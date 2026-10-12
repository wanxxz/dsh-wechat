/**
 * 用于端到端自检的微信 iLink 端点替身。
 *
 * 把插件的 `baseUrl` 指向这个服务器（见 README 的自检一节），整个频道就能在
 * 没有微信的情况下运行：它签发一个二维码，立即确认，投递一条入站消息，并打印
 * 频道回传的一切。这在运行中的 Harness 内部走通了真实路径——频道 → Session →
 * agent 轮次 → 回复。
 *
 * 运行：`node test/mock-ilink.js [port]`；它会一直驻留，直到被中断。
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 45999)
// 一条消息，或用 `||` 分隔的脚本按顺序投递（每次都在下一次 getupdates 轮询时），
// 这就是在一次运行中重放一段对话的方式。
const script = (process.env.MOCK_INBOUND_TEXTS ?? process.env.MOCK_INBOUND_TEXT ?? '请只回复这一句话：插件自检通过')
  .split('||')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
const senderId = process.env.MOCK_SENDER_ID ?? 'wx-selfcheck'
const pollHoldMs = Number(process.env.MOCK_POLL_HOLD_MS ?? 1500)
// `wait` 让频道停留在 QR 状态，降级登录页面和登录状态渲染正是对照它来检查的。
const qrStatus = process.env.MOCK_QR_STATUS ?? 'confirmed'

const state = { pollCount: 0, sent: [], inboundCount: 0 }
const started = Date.now()
// 频道按 `message_id` 去重，因此每次运行都必须生成一个新的；跨运行复用同一个
// id 会被静默丢弃（这正是防止重连重复投递一条消息的预期保护）。
const messageIdBase = Number(process.env.MOCK_MESSAGE_ID ?? (Date.now() % 1_000_000_000))

/** 一条日志行，前缀为自启动以来的毫秒数。 */
function log(message) {
  console.log(`[${String(Date.now() - started).padStart(6, ' ')}ms] ${message}`)
}

/**
 * 读取 JSON 请求体。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {Promise<object>} 解析后的请求体。
 */
async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/**
 * 以 JSON 应答。
 * @param {import('node:http').ServerResponse} response - 响应。
 * @param {unknown} payload - 响应体。
 * @param {number} [status] - 状态码。
 */
function sendJson(response, payload, status = 200) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

/**
 * 本服务器投递的那一条入站消息，形状与平台的一致。
 * @returns {object} 一个 getupdates 条目。
 */
function inboundMessage() {
  return {
    message_id: messageIdBase + state.inboundCount,
    from_user_id: senderId,
    to_user_id: 'selfcheck-bot',
    client_id: `selfcheck-client-${messageIdBase}-${state.inboundCount}`,
    create_time_ms: Date.now(),
    message_type: 1,
    message_state: 2,
    context_token: 'selfcheck-context-token',
    item_list: [{ type: 1, text_item: { text: script[Math.max(0, state.inboundCount - 1)] ?? script.at(-1) } }],
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/'
    if (url.startsWith('/ilink/bot/get_bot_qrcode')) {
      log('GET get_bot_qrcode')
      sendJson(response, {
        qrcode: 'selfcheck-ticket',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/selfcheck?qrcode=selfcheck-ticket&bot_type=3',
      })
      return
    }

    if (url.startsWith('/ilink/bot/get_qrcode_status')) {
      if (qrStatus !== 'confirmed') {
        log(`GET get_qrcode_status -> ${qrStatus}`)
        sendJson(response, { status: qrStatus })
        return
      }
      log('GET get_qrcode_status -> confirmed')
      sendJson(response, {
        status: 'confirmed',
        bot_token: 'selfcheck-bot-token',
        ilink_bot_id: 'selfcheck-bot',
        ilink_user_id: 'selfcheck-operator',
        baseurl: `http://127.0.0.1:${port}`,
      })
      return
    }

    if (url.startsWith('/ilink/bot/getupdates')) {
      state.pollCount += 1
      // 像长轮询一样挂住；客户端在两次轮询之间没有休眠。
      await new Promise((resolve) => setTimeout(resolve, pollHoldMs))
      const deliver = state.inboundCount < script.length
      if (deliver) state.inboundCount += 1
      log(`POST getupdates #${state.pollCount} -> ${deliver ? `message ${state.inboundCount}/${script.length}` : 'empty'}`)
      sendJson(response, {
        msgs: deliver ? [inboundMessage()] : [],
        get_updates_buf: `buf-${state.inboundCount}`,
      })
      return
    }

    if (url.startsWith('/ilink/bot/sendmessage')) {
      const body = await readJson(request)
      const items = body?.msg?.item_list ?? []
      const text = items.map((item) => item?.text_item?.text ?? '').join('')
      state.sent.push(text)
      log(`POST sendmessage <- ${JSON.stringify(text.slice(0, 400))}`)
      sendJson(response, { ret: 0 })
      return
    }

    if (url.startsWith('/ilink/bot/getconfig')) {
      log('POST getconfig -> typing_ticket')
      sendJson(response, { ret: 0, typing_ticket: 'selfcheck-typing-ticket' })
      return
    }

    if (url.startsWith('/ilink/bot/sendtyping')) {
      sendJson(response, { ret: 0 })
      return
    }

    log(`unhandled ${request.method} ${url}`)
    sendJson(response, { ret: 0 })
  })().catch((error) => {
    log(`handler error: ${error instanceof Error ? error.message : String(error)}`)
    if (!response.headersSent) sendJson(response, { ret: 1, errmsg: 'mock failure' }, 500)
  })
})

server.listen(port, '127.0.0.1', () => {
  log(`mock iLink endpoint listening on http://127.0.0.1:${port}`)
  log(`it will deliver ${script.length} message(s) from ${senderId}: ${JSON.stringify(script)}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`stopping; ${state.sent.length} outbound message(s) seen`)
    for (const [index, text] of state.sent.entries()) log(`  outbound[${index}] ${JSON.stringify(text.slice(0, 400))}`)
    server.close(() => process.exit(0))
  })
}
