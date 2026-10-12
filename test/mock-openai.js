/**
 * 用于隔离自检宿主的一个极简 OpenAI 兼容端点。
 *
 * 它以一条固定的 assistant 消息应答 `/v1/chat/completions`，支持流式与非流式，
 * 从而无需外部模型提供方就能验证整条「微信消息 → Session → agent 轮次 →
 * assistant 文本 → 回复」路径。
 *
 * 运行：`node test/mock-openai.js [port]`；回复文本来自 `MOCK_REPLY_TEXT`。
 */
import http from 'node:http'

const port = Number(process.argv[2] ?? 45998)
const model = process.env.MOCK_MODEL_ID ?? 'selfcheck-model'
const reply = process.env.MOCK_REPLY_TEXT ?? '插件自检通过（来自本地模拟模型）'

/**
 * 读取并解析 JSON 请求体。
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

const server = http.createServer((request, response) => {
  void (async () => {
    const url = request.url ?? '/'
    if (url.startsWith('/v1/models')) {
      const body = JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'selfcheck' }] })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }

    if (url.startsWith('/v1/chat/completions')) {
      const payload = await readJson(request)
      console.log(`[mock-openai] chat/completions model=${payload.model ?? '?'} stream=${payload.stream === true} messages=${payload.messages?.length ?? 0}`)
      const created = Math.floor(Date.now() / 1000)
      if (payload.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({
            id: 'chatcmpl-selfcheck',
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finish ?? null }],
          })}\n\n`
        response.write(chunk({ role: 'assistant', content: reply }, null))
        response.write(chunk({}, 'stop'))
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      const body = JSON.stringify({
        id: 'chatcmpl-selfcheck',
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 16, completion_tokens: 8, total_tokens: 24 },
      })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }

    console.log(`[mock-openai] unhandled ${request.method} ${url}`)
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })().catch((error) => {
    console.log(`[mock-openai] handler error: ${error instanceof Error ? error.message : String(error)}`)
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'mock failure' } }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}/v1 (model ${model})`)
  console.log(`[mock-openai] every completion answers: ${JSON.stringify(reply)}`)
})
