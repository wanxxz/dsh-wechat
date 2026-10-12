/**
 * WeChat iLink Bot 协议 —— 零依赖 ESM 移植版
 * ============================================================================
 * 移植自 CherryHQ/cherry-studio PR #13714 (`feat(cherry-claw): add WeChat channel adapter`)
 *   - src/main/services/agents/services/channels/adapters/WeChatProtocol.ts (708 行)
 *   - src/main/services/agents/services/channels/adapters/WeChatAdapter.ts (218 行, 仅 splitMessage)
 *
 * 与参考实现的差异（有意为之）：
 *   - 去掉 electron `net.fetch` / `@logger` / `zod` 依赖：改用 globalThis.fetch、
 *     可选的回调 logger（onError），zod 校验换成手写的轻量取值/校验。
 *   - 补齐了参考实现里的几个隐含缺陷（见文件末尾 "移植备注 / 存疑点" 注释块）。
 *
 * ---------------------------------------------------------------------------
 * 用法示例（零依赖，Node >= 18；本机实测 v26.10.0）
 * ---------------------------------------------------------------------------
 *   import { WeixinBot, splitWeChatMessage } from './wechat-protocol.js'
 *
 *   // 1) 扫二维码登录（首次运行）。凭据会写到 tokenPath（0o600）。
 *   const bot = new WeixinBot({
 *     // baseUrl: 'https://ilinkai.weixin.qq.com',        // 默认值
 *     tokenPath: 'C:/Users/me/.weixin-bot/weixin_bot.json', // 可覆盖；默认见 DEFAULT_TOKEN_PATH
 *     onQr: (qrContent, info) => {                     // qrContent 原样透出，不渲染
 *       console.log('请扫码 / 打开链接：', qrContent, info.qrcode)
 *     },
 *     onStatus: (status) => console.log('登录状态:', status), // wait|scaned|confirmed|expired
 *     onError: (err) => console.error('[wechat]', err)
 *   })
 *
 *   const cred = await bot.login()          // -> { token, baseUrl, accountId, userId }
 *   // await bot.login({ force: true })     // 忽略已存凭据，强制重新扫码
 *
 *   // 2) 收消息
 *   bot.onMessage(async (msg) => {
 *     // msg = { userId, text, type, contextToken, timestamp, raw }
 *     await bot.sendTyping(msg.userId)
 *     await bot.reply(msg, '收到：' + msg.text)
 *   })
 *
 *   // 3) 长轮询（阻塞；bot.stop() 或 signal 中止）
 *   const ac = new AbortController()
 *   process.on('SIGINT', () => { ac.abort(); bot.stop() })
 *   await bot.run({ signal: ac.signal })
 *
 *   // 4) 主动发送 / 2000 字切分
 *   await bot.send(userId, 'hi')                    // 需要该 userId 有缓存 context_token
 *   for (const chunk of splitWeChatMessage(longText)) await bot.send(userId, chunk)
 * ============================================================================
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// ============================================================================
// 常量 —— 对应原实现 "Constants" 段（逐字一致，勿改）
// ============================================================================

/** 原: const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com' */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** 原: const CHANNEL_VERSION = '1.0.0' —— 进 base_info.channel_version */
export const CHANNEL_VERSION = '1.0.0'
/** 原: const QR_POLL_INTERVAL_MS = 2_000 */
export const QR_POLL_INTERVAL_MS = 2_000
/** 原: const MAX_CONTEXT_TOKENS = 1000 */
export const MAX_CONTEXT_TOKENS = 1000
/** 移植自 WeChatAdapter.ts: const WECHAT_MAX_LENGTH = 2000 */
export const WECHAT_MAX_LENGTH = 2000

/** 默认凭据落盘路径（参考实现由 electron app.getPath('userData') 拼出；此处用 os.homedir()）。
 *  可用构造函数 options.tokenPath 覆盖，也可用环境变量 WEIXIN_BOT_TOKEN_PATH 覆盖。 */
export const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.weixin-bot', 'weixin_bot.json')

// ============================================================================
// 枚举 —— 对应原实现 "Types" 段（MessageType / MessageState / MessageItemType）
// ============================================================================

/** 原: enum MessageType { USER = 1, BOT = 2 } */
export const MessageType = Object.freeze({ USER: 1, BOT: 2 })
/** 原: enum MessageState { NEW = 0, GENERATING = 1, FINISH = 2 } */
export const MessageState = Object.freeze({ NEW: 0, GENERATING: 1, FINISH: 2 })
/** 原: enum MessageItemType { TEXT = 1, IMAGE = 2, VOICE = 3, FILE = 4, VIDEO = 5 } */
export const MessageItemType = Object.freeze({ TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 })

/** 二维码登录状态：原 QrStatusResponseSchema 的 z.enum(['wait','scaned','confirmed','expired'])。
 *  注意 'scaned' 是协议里的拼写（少一个 n），必须逐字保留。 */
export const QR_STATUSES = Object.freeze(['wait', 'scaned', 'confirmed', 'expired'])

// ============================================================================
// 端点路径 —— 对应原实现的 apiFetch / apiGet 调用点（逐字一致）
// ============================================================================

export const ENDPOINTS = Object.freeze({
  GET_UPDATES: '/ilink/bot/getupdates', // 长轮询收消息
  SEND_MESSAGE: '/ilink/bot/sendmessage', // 发消息
  GET_CONFIG: '/ilink/bot/getconfig', // 取 typing_ticket
  SEND_TYPING: '/ilink/bot/sendtyping', // 发送"正在输入"
  GET_BOT_QRCODE: '/ilink/bot/get_bot_qrcode?bot_type=3', // 取登录二维码
  GET_QRCODE_STATUS: '/ilink/bot/get_qrcode_status' // 轮询扫码状态
})

// 超时（毫秒）—— 逐字保留原实现里的 magic number
const TIMEOUT_GET_UPDATES_MS = 40_000 // 原: apiFetch(..., 40_000, signal)
const TIMEOUT_DEFAULT_MS = 40_000 // 原: apiFetch 的默认参数 timeoutMs = 40_000
const TIMEOUT_SHORT_MS = 15_000 // 原: sendmessage / getconfig / sendtyping 均为 15_000
const RETRY_DELAY_MIN_MS = 1_000 // 原: let retryDelayMs = 1_000 / retryDelayMs = 1_000
const RETRY_DELAY_MAX_MS = 10_000 // 原: Math.min(retryDelayMs * 2, 10_000)

// ============================================================================
// 错误类型 —— 对应原实现 class ApiError
// ============================================================================

/** 原: class ApiError extends Error（status / code / payload 三个字段名保持不变） */
export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = options.status
    this.code = options.code
    this.payload = options.payload
  }
}

/** 原: CredentialsSchema（zod object）—— 手写校验/取值 */
export class CredentialsFormatError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CredentialsFormatError'
  }
}

// ============================================================================
// 轻量校验工具 —— 替代原实现的 zod schema（ApiErrorBodySchema / WeixinMessageSchema /
// GetUpdatesRespSchema / QrCodeResponseSchema / QrStatusResponseSchema /
// GetConfigRespSchema / CredentialsSchema）
// ============================================================================

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v)
const isString = (v) => typeof v === 'string'

/** 原: ApiErrorBodySchema = z.object({ ret?, errcode?, errmsg? }) —— safeParse 语义 */
function parseApiErrorBody(raw) {
  if (!isObject(raw)) return null
  const out = {}
  if (isNumber(raw.ret)) out.ret = raw.ret
  if (isNumber(raw.errcode)) out.errcode = raw.errcode
  if (isString(raw.errmsg)) out.errmsg = raw.errmsg
  return out
}

/** 原: WeixinMessageSchema —— 手写归一化（缺失/类型不符的字段退回默认值，等价于"尽力取值"） */
function normalizeMessageItem(raw) {
  if (!isObject(raw)) return { type: 0 }
  const item = { type: isNumber(raw.type) ? raw.type : 0 }
  if (isObject(raw.text_item)) item.text_item = { text: isString(raw.text_item.text) ? raw.text_item.text : '' }
  if (isObject(raw.image_item)) {
    item.image_item = {}
    if (isString(raw.image_item.url)) item.image_item.url = raw.image_item.url
  }
  if (isObject(raw.voice_item)) {
    item.voice_item = {}
    if (isString(raw.voice_item.text)) item.voice_item.text = raw.voice_item.text
  }
  if (isObject(raw.file_item)) {
    item.file_item = {}
    if (isString(raw.file_item.file_name)) item.file_item.file_name = raw.file_item.file_name
  }
  if ('video_item' in raw) item.video_item = raw.video_item
  if ('ref_msg' in raw) item.ref_msg = raw.ref_msg
  return item
}

/** 原: WeixinMessageSchema.parse(...) —— 字段名逐字保留 */
function normalizeMessage(raw) {
  if (!isObject(raw)) return null
  return {
    message_id: isNumber(raw.message_id) ? raw.message_id : 0,
    from_user_id: isString(raw.from_user_id) ? raw.from_user_id : '',
    to_user_id: isString(raw.to_user_id) ? raw.to_user_id : '',
    client_id: isString(raw.client_id) ? raw.client_id : '',
    create_time_ms: isNumber(raw.create_time_ms) ? raw.create_time_ms : 0,
    message_type: isNumber(raw.message_type) ? raw.message_type : 0,
    message_state: isNumber(raw.message_state) ? raw.message_state : 0,
    context_token: isString(raw.context_token) ? raw.context_token : '',
    item_list: Array.isArray(raw.item_list) ? raw.item_list.map(normalizeMessageItem) : []
  }
}

/** 原: GetUpdatesRespSchema = z.object({ msgs: array(...).default([]), get_updates_buf: string().default('') }) */
function parseGetUpdatesResponse(raw) {
  const obj = isObject(raw) ? raw : {}
  const msgs = Array.isArray(obj.msgs) ? obj.msgs.map(normalizeMessage).filter(Boolean) : []
  const get_updates_buf = isString(obj.get_updates_buf) ? obj.get_updates_buf : ''
  return { msgs, get_updates_buf }
}

/** 原: QrCodeResponseSchema = z.object({ qrcode: string(), qrcode_img_content: string() }) */
function parseQrCodeResponse(raw) {
  const obj = isObject(raw) ? raw : {}
  if (!isString(obj.qrcode)) throw new Error('get_bot_qrcode response missing "qrcode"')
  return {
    qrcode: obj.qrcode,
    qrcode_img_content: isString(obj.qrcode_img_content) ? obj.qrcode_img_content : ''
  }
}

/** 原: QrStatusResponseSchema = z.object({ status: enum([...]), bot_token?, ilink_bot_id?, ilink_user_id?, baseurl? }) */
function parseQrStatusResponse(raw) {
  const obj = isObject(raw) ? raw : {}
  // 有意放宽：平台还会返回 `scaned_but_redirect`、
  // `binded_redirect`、`need_verifycode` 和 `verify_code_blocked`，
  // 而参考实现的四值枚举会直接拒绝它们。现在未知状态会继续轮询
  // （并传递给 `onStatus`），而不是让一个可能仍在手机上
  // 完成的登录直接失败。
  if (!isString(obj.status) || obj.status.length === 0) {
    throw new Error(`get_qrcode_status response has no status: ${JSON.stringify(obj.status)}`)
  }
  const out = { status: obj.status, known: QR_STATUSES.includes(obj.status) }
  if (isString(obj.bot_token)) out.bot_token = obj.bot_token
  if (isString(obj.ilink_bot_id)) out.ilink_bot_id = obj.ilink_bot_id
  if (isString(obj.ilink_user_id)) out.ilink_user_id = obj.ilink_user_id
  if (isString(obj.baseurl)) out.baseurl = obj.baseurl
  if (isString(obj.redirect_host)) out.redirect_host = obj.redirect_host
  return out
}

/** 原: GetConfigRespSchema = z.object({ typing_ticket: string().optional() }) */
function parseGetConfigResponse(raw) {
  const obj = isObject(raw) ? raw : {}
  return isString(obj.typing_ticket) ? { typing_ticket: obj.typing_ticket } : {}
}

/** 原: CredentialsSchema = z.object({ token, baseUrl, accountId, userId }) 全部 required string */
function parseCredentials(raw) {
  const obj = isObject(raw) ? raw : null
  if (
    !obj ||
    !isString(obj.token) ||
    !isString(obj.baseUrl) ||
    !isString(obj.accountId) ||
    !isString(obj.userId)
  ) {
    return null
  }
  return { token: obj.token, baseUrl: obj.baseUrl, accountId: obj.accountId, userId: obj.userId }
}

// ============================================================================
// API helpers —— 对应原实现 "API helpers" 段
// ============================================================================

/** 原: function buildBaseInfo(): BaseInfo { return { channel_version: CHANNEL_VERSION } } */
export function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION }
}

/**
 * 原: function buildHeaders(token, uin) —— 请求头逐字一致：
 *   Content-Type / AuthorizationType: ilink_bot_token / Authorization: Bearer <token> / X-WECHAT-UIN
 */
export function buildHeaders(token, uin) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': uin
  }
}

/**
 * 原: async function parseJsonResponse(response, label)
 *   - 空 body 视为 {}；
 *   - !response.ok → ApiError(errmsg ?? `${label} failed with HTTP ${status}`, {status, code: errcode, payload})
 *   - 2xx 但 body.ret 是非 0 数字 → ApiError(errmsg ?? `${label} failed`, {status, code: errcode ?? ret, payload})
 */
export async function parseJsonResponse(response, label) {
  const text = await response.text()
  const raw = text ? JSON.parse(text) : {}

  if (!response.ok) {
    const parsed = parseApiErrorBody(raw) ?? {}
    throw new ApiError(parsed.errmsg ?? `${label} failed with HTTP ${response.status}`, {
      status: response.status,
      code: parsed.errcode,
      payload: raw
    })
  }

  const body = parseApiErrorBody(raw)
  if (body && isNumber(body.ret) && body.ret !== 0) {
    throw new ApiError(body.errmsg ?? `${label} failed`, {
      status: response.status,
      code: body.errcode ?? body.ret,
      payload: raw
    })
  }

  return raw
}

/**
 * 原: async function apiFetch(baseUrlOrigin, endpoint, body, token, uin, timeoutMs = 40_000, signal?)
 *   原实现用 electron net.fetch；此处用 globalThis.fetch（Node 18+ 内置 undici）。
 *   AbortSignal.timeout 产生 TimeoutError，属于可重试错误；外部 signal 产生的 AbortError 才是取消。
 */
export async function apiFetch(baseUrlOrigin, endpoint, body, token, uin, timeoutMs = TIMEOUT_DEFAULT_MS, signal) {
  const url = `${baseUrlOrigin}${endpoint}`
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, uin),
    body: JSON.stringify(body),
    signal: requestSignal
  })

  return parseJsonResponse(response, endpoint)
}

/**
 * 原: async function apiGet(baseUrlOrigin, urlPath, headers = {})
 *   （原实现无超时；这里保留这一行为，只额外支持可选 signal）
 */
export async function apiGet(baseUrlOrigin, urlPath, headers = {}, options = {}) {
  const url = `${baseUrlOrigin}${urlPath}`
  const response = await fetch(url, {
    method: 'GET',
    headers,
    ...(options.signal ? { signal: options.signal } : {})
  })
  return parseJsonResponse(response, urlPath)
}

/** 原: async function getUpdates(baseUrl, token, uin, buf, signal?) —— POST /ilink/bot/getupdates */
export async function getUpdates(baseUrl, token, uin, buf, signal) {
  const raw = await apiFetch(
    baseUrl,
    ENDPOINTS.GET_UPDATES,
    { get_updates_buf: buf, base_info: buildBaseInfo() },
    token,
    uin,
    TIMEOUT_GET_UPDATES_MS,
    signal
  )
  return parseGetUpdatesResponse(raw)
}

/** 原: async function apiSendMessage(baseUrl, token, uin, msg) —— POST /ilink/bot/sendmessage，body = { msg, base_info } */
export async function apiSendMessage(baseUrl, token, uin, msg) {
  await apiFetch(baseUrl, ENDPOINTS.SEND_MESSAGE, { msg, base_info: buildBaseInfo() }, token, uin, TIMEOUT_SHORT_MS)
}

/** 原: async function apiGetConfig(baseUrl, token, uin, userId, contextToken) —— POST /ilink/bot/getconfig */
export async function apiGetConfig(baseUrl, token, uin, userId, contextToken) {
  const raw = await apiFetch(
    baseUrl,
    ENDPOINTS.GET_CONFIG,
    { ilink_user_id: userId, context_token: contextToken, base_info: buildBaseInfo() },
    token,
    uin,
    TIMEOUT_SHORT_MS
  )
  return parseGetConfigResponse(raw)
}

/** 原: async function apiSendTyping(baseUrl, token, uin, userId, ticket, status) —— POST /ilink/bot/sendtyping，status: 1|2 */
export async function apiSendTyping(baseUrl, token, uin, userId, ticket, status) {
  const body = {
    ilink_user_id: userId,
    typing_ticket: ticket,
    status,
    base_info: buildBaseInfo()
  }
  await apiFetch(baseUrl, ENDPOINTS.SEND_TYPING, body, token, uin, TIMEOUT_SHORT_MS)
}

/** 原: async function fetchQrCode(baseUrl) —— GET /ilink/bot/get_bot_qrcode?bot_type=3 */
export async function fetchQrCode(baseUrl) {
  const raw = await apiGet(baseUrl, ENDPOINTS.GET_BOT_QRCODE)
  return parseQrCodeResponse(raw)
}

/**
 * 原: async function pollQrStatus(baseUrl, qrcode)
 *   GET /ilink/bot/get_qrcode_status?qrcode=<encodeURIComponent(qrcode)>
 *   额外请求头 'iLink-App-ClientVersion': '1'（注意与 POST 的 base_info.channel_version 是两回事）
 */
export async function pollQrStatus(baseUrl, qrcode) {
  const raw = await apiGet(baseUrl, `${ENDPOINTS.GET_QRCODE_STATUS}?qrcode=${encodeURIComponent(qrcode)}`, {
    'iLink-App-ClientVersion': '1'
  })
  return parseQrStatusResponse(raw)
}

/**
 * 原: function buildTextMessage(userId, contextToken, text)
 *   出站私聊文本消息的固定形状（from_user_id 空串、client_id 为 uuid、
 *   message_type=BOT(2)、message_state=FINISH(2)、item_list 单个 TEXT item）。
 */
export function buildTextMessage(userId, contextToken, text) {
  return {
    from_user_id: '',
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }]
  }
}

/** 原: function normalizeBaseUrl(baseUrl) —— 去掉结尾斜杠 */
export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '')
}

/**
 * 把平台提供的主机解析成 base URL。
 *
 * `redirect_host` 以裸主机形式到达（有时带端口），因此会补上协议；
 * 若已显式给出协议则原样保留，这也让测试可以把它指向本地服务器。
 * @param {string} host - 平台给出的主机或绝对 URL。
 * @param {string} fallbackBase - 用于继承异常值协议的基准 base。
 * @returns {string} 去掉结尾斜杠的 base URL。
 */
export function withScheme(host, fallbackBase) {
  const value = String(host).trim()
  if (value.length === 0) return normalizeBaseUrl(fallbackBase)
  if (/^https?:\/\//iu.test(value)) return normalizeBaseUrl(value)
  const scheme = /^http:\/\//iu.test(String(fallbackBase)) ? 'http' : 'https'
  return normalizeBaseUrl(`${scheme}://${value}`)
}

// ============================================================================
// 凭据读写 —— 对应原实现 "Auth" 段的 loadCredentials / saveCredentials / clearCredentials
// ============================================================================

/** 原: async function loadCredentials(tokenPath) —— ENOENT 返回 undefined，格式非法抛错 */
export async function loadCredentials(tokenPath) {
  try {
    const raw = await readFile(tokenPath, 'utf8')
    const result = parseCredentials(JSON.parse(raw))
    if (!result) {
      throw new CredentialsFormatError(`Invalid credentials format in ${tokenPath}`)
    }
    return result
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** 原: async function saveCredentials(credentials, tokenPath) —— 目录 0o700、文件 0o600（写入后再 chmod 一次） */
export async function saveCredentials(credentials, tokenPath) {
  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 })
  await writeFile(tokenPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  await chmod(tokenPath, 0o600)
}

/** 原: async function clearCredentials(tokenPath) —— rm force（不存在不报错） */
export async function clearCredentials(tokenPath) {
  await rm(tokenPath, { force: true })
}

/**
 * 原: interface LoginOptions { baseUrl, tokenPath, force?, onQrUrl? }
 *     async function loginFlow(options)
 *   本移植把回调扩展为 onQr(content, { qrcode }) 与 onStatus(status, info)，
 *   同时保留 onQrUrl(url) 作为向后兼容别名（原实现只传 qrcode_img_content）。
 */
export async function loginFlow(options) {
  const tokenPath = options.tokenPath
  if (!tokenPath) throw new Error('tokenPath is required for loginFlow')

  if (!options.force) {
    const existing = await loadCredentials(tokenPath)
    if (existing) return existing
  }

  // 原: for (;;) —— 二维码 expired 后回到外层重新申请
  for (;;) {
    const qr = await fetchQrCode(options.baseUrl)
    // 原: options.onQrUrl?.(qr.qrcode_img_content)
    options.onQr?.(qr.qrcode_img_content, { qrcode: qr.qrcode })
    options.onQrUrl?.(qr.qrcode_img_content)

    let lastStatus
    let expiredNotified = false
    // 平台可能把待完成的登录迁移到另一台主机
    // （`scaned_but_redirect`）；随后就在那里轮询同一个二维码票据。
    let pollBase = options.baseUrl
    // 移植补充：轮询间隔可配置，便于自检与按平台节奏调速。
    const pollInterval = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0 ? options.pollIntervalMs : QR_POLL_INTERVAL_MS

    // 原: 内层轮询，只关心 wait / scaned / confirmed / expired
    for (;;) {
      const status = await pollQrStatus(pollBase, qr.qrcode)

      if (status.status !== lastStatus) {
        // 原实现这里只做 logger.info；移植后统一走 onStatus 回调
        if (status.status === 'scaned') {
          options.onStatus?.('scaned', status)
        } else if (status.status === 'confirmed') {
          options.onStatus?.('confirmed', status)
        } else if (status.status === 'expired') {
          options.onStatus?.('expired', status)
          expiredNotified = true
        } else {
          options.onStatus?.(status.status, status)
        }
        lastStatus = status.status
      }

      if (status.status === 'scaned_but_redirect' && isString(status.redirect_host)) {
        pollBase = withScheme(status.redirect_host, pollBase)
        await delay(pollInterval)
        continue
      }

      // `binded_redirect` 表示该手机已绑定过机器人；平台在能复用时
      // 会直接返回凭据。
      const confirmed = status.status === 'confirmed' || (status.status === 'binded_redirect' && isString(status.bot_token))
      if (confirmed) {
        if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
          throw new Error('QR login confirmed, but the API did not return bot credentials')
        }

        const credentials = {
          token: status.bot_token,
          // 用 `||` 而非 `??`：平台可能返回 `baseurl: ""`，而 `??`
          // 会保留空串，从而构造出无效的请求 URL。
          baseUrl: status.baseurl || options.baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id
        }
        await saveCredentials(credentials, tokenPath)
        return credentials
      }

      if (status.status === 'expired') break

      await delay(pollInterval)
    }

    // 移植补充：二维码过期后重新申请新码，再通知一次 wait（原实现直接回到 for(;;)，
    // 不重发 wait 事件，UI 会一直停留在 expired 状态）
    if (expiredNotified) options.onStatus?.('wait', { qrcode: null, refreshed: true })
  }
}

// ============================================================================
// WeixinBot —— 对应原实现 "WeixinBot" 段
// ============================================================================

/** 原: type MessageHandler = (msg: IncomingMessage) => void | Promise<void> */
const noop = () => {}

export class WeixinBot {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]   默认 https://ilinkai.weixin.qq.com
   * @param {string} [options.tokenPath] 凭据文件路径，默认 DEFAULT_TOKEN_PATH（可被 login({tokenPath}) 覆盖）
   * @param {string} [options.uin]       X-WECHAT-UIN；默认随机（原: base64(String(randomBytes(4).readUInt32BE(0)))）
   * @param {(e:unknown)=>void} [options.onError]
   * @param {(content:string, info:{qrcode:string})=>void} [options.onQr]
   * @param {(status:'wait'|'scaned'|'confirmed'|'expired', info:object)=>void} [options.onStatus]
   * @param {(url:string)=>void} [options.onQrUrl] 向后兼容别名（原实现签名）
   * @param {number} [options.maxContextTokens] 默认 MAX_CONTEXT_TOKENS
   * @param {boolean} [options.dedupe] 默认 true：按 message_id 去重（移植补充）
   * @param {()=>string} [options.logger] 可选日志函数（替代原 @logger）
   */
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    // 原: this.uin = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
    this.uin = options.uin ?? Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
    this.tokenPath = options.tokenPath ?? process.env.WEIXIN_BOT_TOKEN_PATH ?? DEFAULT_TOKEN_PATH
    this.onErrorCallback = options.onError
    this.onQrCallback = options.onQr
    this.onQrUrlCallback = options.onQrUrl
    this.onStatusCallback = options.onStatus
    this.maxContextTokens = options.maxContextTokens ?? MAX_CONTEXT_TOKENS
    this.dedupe = options.dedupe !== false
    this.log = options.logger ?? noop

    this.handlers = []
    /** 原: private readonly contextTokens = new Map<string, string>() */
    this.contextTokens = new Map()
    this.credentials = undefined
    /** 原: private cursor = '' —— 即 get_updates_buf 续传游标 */
    this.cursor = ''
    this.stopped = false
    this.currentPollController = null
    this.runPromise = null
    /** 移植补充：message_id 去重窗口（防重连后重复派发） */
    this.seenMessageIds = new Set()
    /** 移植补充：teardown 阶段抑制 onError 噪音 */
    this.shuttingDown = false
  }

  /**
   * 原: async login(options: { force?: boolean } = {})
   *   - 复用 tokenPath 上的既有凭据（除非 force）
   *   - 换 token 时清空 cursor 与 context_token 缓存
   *   @returns {Promise<{token:string,baseUrl:string,accountId:string,userId:string}>}
   */
  async login(options = {}) {
    const tokenPath = options.tokenPath ?? this.tokenPath
    if (!tokenPath) throw new Error('WeixinBot: tokenPath is required (constructor option tokenPath)')

    const previousToken = this.credentials?.token
    const credentials = await loginFlow({
      baseUrl: this.baseUrl,
      tokenPath,
      force: options.force,
      onQr: this.onQrCallback,
      onQrUrl: this.onQrUrlCallback,
      onStatus: this.onStatusCallback
    })

    this.credentials = credentials
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl)

    if (previousToken && previousToken !== credentials.token) {
      this.cursor = ''
      this.contextTokens.clear()
    }

    this.log('[wechat] logged in', { userId: credentials.userId })
    return credentials
  }

  /** 原: onMessage(handler): this —— 注册消息处理器，可多次注册 */
  onMessage(handler) {
    this.handlers.push(handler)
    return this
  }

  /**
   * 原: async reply(message: IncomingMessage, text: string)
   *   移植扩展：第一个参数既可以是 IncomingMessage，也可以是 contextToken 字符串。
   *   发完文本后 fire-and-forget 关闭"正在输入"。
   */
  async reply(messageOrContextToken, text) {
    let userId
    let contextToken
    if (typeof messageOrContextToken === 'string') {
      contextToken = messageOrContextToken
      userId = this.userIdForContextToken(contextToken)
      if (!userId) throw new Error('reply(contextToken, text) requires a previously cached context token')
    } else {
      if (!messageOrContextToken || typeof messageOrContextToken !== 'object') {
        throw new Error('reply(msg|contextToken, text) expects an IncomingMessage or a context token string')
      }
      userId = messageOrContextToken.userId
      contextToken = messageOrContextToken.contextToken ?? messageOrContextToken._contextToken
    }
    if (!contextToken) throw new Error(`No context token available for user ${userId}`)

    this.contextTokens.set(userId, contextToken)
    await this.sendText(userId, text, contextToken)
    this.stopTyping(userId).catch(() => {})
  }

  /** 原: async sendTyping(userId) —— 需要已缓存 context_token；getconfig 拿 typing_ticket 后 status=1 */
  async sendTyping(userId) {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      throw new Error(`No cached context token for user ${userId}. Reply to an incoming message first.`)
    }

    const credentials = await this.ensureCredentials()
    const config = await apiGetConfig(this.baseUrl, credentials.token, this.uin, userId, contextToken)
    if (!config.typing_ticket) return

    await apiSendTyping(this.baseUrl, credentials.token, this.uin, userId, config.typing_ticket, 1)
  }

  /** 原: async stopTyping(userId) —— status=2；无 context_token 时直接返回（不抛错） */
  async stopTyping(userId) {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) return

    const credentials = await this.ensureCredentials()
    const config = await apiGetConfig(this.baseUrl, credentials.token, this.uin, userId, contextToken)
    if (!config.typing_ticket) return

    await apiSendTyping(this.baseUrl, credentials.token, this.uin, userId, config.typing_ticket, 2)
  }

  /** 原: async send(userId, text) —— 需要已缓存 context_token */
  async send(userId, text) {
    const contextToken = this.contextTokens.get(userId)
    if (!contextToken) {
      throw new Error(`No cached context token for user ${userId}. Reply to an incoming message first.`)
    }

    await this.sendText(userId, text, contextToken)
  }

  /**
   * 原: async run(): Promise<void> —— 幂等（并发调用返回同一个 promise）
   *   移植扩展：run({ signal }) 支持外部取消。
   */
  async run(options = {}) {
    if (options.credentials) this.credentials = options.credentials
    if (this.runPromise) return this.runPromise

    if (options.signal) {
      if (options.signal.aborted) {
        this.stopped = true
        return
      }
      const abortHandler = () => this.stop()
      options.signal.addEventListener('abort', abortHandler, { once: true })
      this.runAbortCleanup = () => options.signal.removeEventListener('abort', abortHandler)
    }

    this.stopped = false
    this.runPromise = this.runLoop()

    try {
      await this.runPromise
    } finally {
      this.runPromise = null
      this.currentPollController = null
      this.runAbortCleanup?.()
      this.runAbortCleanup = null
    }
  }

  /** 原: stop(): void —— 置 stopped 并 abort 当前在飞的长轮询 */
  stop() {
    this.stopped = true
    this.currentPollController?.abort()
  }

  /** 原: private async runLoop() —— 主长轮询循环（含 -14 session 过期重登、退避 1s→10s） */
  async runLoop() {
    await this.ensureCredentials()
    this.log('[wechat] long-poll loop started')
    let retryDelayMs = RETRY_DELAY_MIN_MS

    while (!this.stopped) {
      // 移植补充：stop() 可能发生在两次轮询之间（例如 handler 执行期间），
      // 这里补一次检查，避免参考实现里"刚停又发一次长轮询"的多余往返。
      if (this.stopped) break
      try {
        const credentials = await this.ensureCredentials()
        this.currentPollController = new AbortController()
        const updates = await getUpdates(
          this.baseUrl,
          credentials.token,
          this.uin,
          this.cursor,
          this.currentPollController.signal
        )

        this.currentPollController = null
        // 原: this.cursor = updates.get_updates_buf || this.cursor  —— 续传游标
        this.cursor = updates.get_updates_buf || this.cursor
        retryDelayMs = RETRY_DELAY_MIN_MS

        for (const raw of updates.msgs ?? []) {
          this.rememberContext(raw)
          if (this.dedupe && raw.message_id > 0) {
            if (this.seenMessageIds.has(raw.message_id)) continue
            this.seenMessageIds.add(raw.message_id)
            if (this.seenMessageIds.size > this.maxContextTokens) {
              const oldest = this.seenMessageIds.values().next().value
              if (oldest !== undefined) this.seenMessageIds.delete(oldest)
            }
          }
          const incoming = this.toIncomingMessage(raw)
          if (incoming) {
            await this.dispatchMessage(incoming)
          }
        }
      } catch (error) {
        this.currentPollController = null

        if (process.env.WECHAT_TRACE) {
          console.log(`   [trace] catch error=${error?.name}:${error?.message} stopped=${this.stopped}`)
        }

        if (this.stopped && isAbortError(error)) break

        if (isSessionExpired(error)) {
          this.log('[wechat] session expired, re-authenticating')
          this.credentials = undefined
          this.cursor = ''
          this.contextTokens.clear()

          try {
            await clearCredentials(this.tokenPath)
            await this.login({ force: true })
            retryDelayMs = RETRY_DELAY_MIN_MS
            if (process.env.WECHAT_TRACE) console.log('   [trace] re-login done, continue')
            continue
          } catch (loginError) {
            this.reportError(loginError)
          }
        } else {
          this.reportError(error)
        }

        await delay(retryDelayMs)
        retryDelayMs = Math.min(retryDelayMs * 2, RETRY_DELAY_MAX_MS)
      }
      if (process.env.WECHAT_TRACE) console.log(`   [trace] loop iteration end stopped=${this.stopped}`)
    }

    this.log('[wechat] long-poll loop stopped')
  }

  /** 原: private async ensureCredentials() —— 内存 → 磁盘 → 交互式登录 */
  async ensureCredentials() {
    if (this.credentials) return this.credentials

    const stored = await loadCredentials(this.tokenPath)
    if (stored) {
      this.credentials = stored
      this.baseUrl = normalizeBaseUrl(stored.baseUrl)
      return stored
    }

    return this.login()
  }

  /** 原: private async sendText(userId, text, contextToken) —— 空文本直接抛错 */
  async sendText(userId, text, contextToken) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('Message text cannot be empty.')
    }

    const credentials = await this.ensureCredentials()
    await apiSendMessage(this.baseUrl, credentials.token, this.uin, buildTextMessage(userId, contextToken, text))
  }

  /** 原: private async dispatchMessage(message) —— Promise.allSettled 并行派发，失败的走 onError */
  async dispatchMessage(message) {
    if (this.handlers.length === 0) return

    const results = await Promise.allSettled(this.handlers.map(async (handler) => handler(message)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.reportError(result.reason)
      }
    }
  }

  /**
   * 原: private rememberContext(message) —— USER 消息取 from_user_id，其余取 to_user_id；
   *   超过 MAX_CONTEXT_TOKENS 时淘汰最早插入的一条（Map 保序 = FIFO）。
   */
  rememberContext(message) {
    const userId =
      message.message_type === MessageType.USER ? message.from_user_id : message.to_user_id
    if (userId && message.context_token) {
      if (this.contextTokens.size >= this.maxContextTokens && !this.contextTokens.has(userId)) {
        const oldest = this.contextTokens.keys().next().value
        if (oldest !== undefined) this.contextTokens.delete(oldest)
      }
      this.contextTokens.set(userId, message.context_token)
    }
  }

  /**
   * 原: private toIncomingMessage(message) —— 只把 USER 消息转成 IncomingMessage。
   *   移植扩展：额外带上 contextToken（无下划线别名）与 raw（原始协议报文）。
   */
  toIncomingMessage(message) {
    if (message.message_type !== MessageType.USER) return null

    return {
      userId: message.from_user_id,
      text: extractText(message.item_list),
      type: detectType(message.item_list),
      contextToken: message.context_token,
      _contextToken: message.context_token, // 原实现字段名，保持兼容
      timestamp: new Date(message.create_time_ms),
      raw: message
    }
  }

  /** 原: private reportError(error) —— 日志 + onError 回调 */
  reportError(error) {
    if (this.shuttingDown) return
    const text = error instanceof Error ? error.message : String(error)
    this.log('[wechat] bot error', text, error)
    this.onErrorCallback?.(error)
  }

  /** 移植补充：reply(contextToken, text) 形态需要反查 userId */
  userIdForContextToken(contextToken) {
    for (const [userId, token] of this.contextTokens) {
      if (token === contextToken) return userId
    }
    return undefined
  }

  /** 移植补充：停止轮询并释放外部 signal 监听（run() 返回后调用） */
  async close() {
    this.shuttingDown = true
    this.stop()
    try {
      await this.runPromise
    } catch {
      /* 已停止 */
    }
  }
}

// ============================================================================
// Helpers —— 对应原实现 "Helpers" 段
// ============================================================================

/** 原: function detectType(items): IncomingMessage['type'] —— 只看第一个 item */
export function detectType(items) {
  const first = items[0]
  switch (first?.type) {
    case MessageItemType.IMAGE:
      return 'image'
    case MessageItemType.VOICE:
      return 'voice'
    case MessageItemType.FILE:
      return 'file'
    case MessageItemType.VIDEO:
      return 'video'
    default:
      return 'text'
  }
}

/** 原: function extractText(items) —— 多 item 用 '\n' 拼接，空串过滤 */
export function extractText(items) {
  return items
    .map((item) => {
      switch (item.type) {
        case MessageItemType.TEXT:
          return item.text_item?.text ?? ''
        case MessageItemType.IMAGE:
          return item.image_item?.url ?? '[image]'
        case MessageItemType.VOICE:
          return item.voice_item?.text ?? '[voice]'
        case MessageItemType.FILE:
          return item.file_item?.file_name ?? '[file]'
        case MessageItemType.VIDEO:
          return '[video]'
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

/** 原: function isAbortError(error) —— AbortError / TimeoutError 均视为可重试中断 */
export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/** 原: function isSessionExpired(error) —— ApiError.code === -14 */
export function isSessionExpired(error) {
  return error instanceof ApiError && error.code === -14
}

/**
 * 移植自 WeChatAdapter.ts `splitMessage(text)`（重命名导出为 splitWeChatMessage）：
 * 文本 > 2000 时优先按空行切、其次按换行切、最后硬切；切点后的前导换行会被吃掉。
 */
export function splitWeChatMessage(text) {
  const str = String(text)
  if (str.length <= WECHAT_MAX_LENGTH) {
    return [str]
  }

  const chunks = []
  let remaining = str

  while (remaining.length > 0) {
    if (remaining.length <= WECHAT_MAX_LENGTH) {
      chunks.push(remaining)
      break
    }

    let splitIndex = remaining.lastIndexOf('\n\n', WECHAT_MAX_LENGTH)
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf('\n', WECHAT_MAX_LENGTH)
    }
    if (splitIndex <= 0) {
      splitIndex = WECHAT_MAX_LENGTH
    }

    chunks.push(remaining.slice(0, splitIndex))
    remaining = remaining.slice(splitIndex).replace(/^\n+/, '')
  }

  return chunks
}

/** 原: module 顶层 `export`（WeChatProtocol 默认只导出 WeixinBot + IncomingMessage 类型） */
export default WeixinBot

// ============================================================================
// 移植备注 / 存疑点（在参考实现里发现的不一致，均在代码里做了对应处理）
// ============================================================================
//
// 1) `getconfig` 端点：任务描述里没列，但参考实现确实调用
//    POST /ilink/bot/getconfig { ilink_user_id, context_token, base_info } 取 typing_ticket，
//    再 POST /ilink/bot/sendtyping { ilink_user_id, typing_ticket, status: 1|2, base_info }。
//    已按参考实现逐字保留。
//
// 2) QR 内容字段：参考实现用的是 `qrcode_img_content`（不是 `qrcode`）。
//    fetchQrCode 用 `qrcode` 去轮询 get_qrcode_status，用 `qrcode_img_content` 给 UI。
//    本移植 onQr(content, { qrcode }) 第一个参数 = qrcode_img_content（原样字符串，不渲染）。
//
// 3) `scaned` 拼写：协议里就是少一个 n 的 `scaned`（不是 `scanned`），逐字保留。
//
// 4) session 过期判定：仅 `ApiError.code === -14`。parseJsonResponse 里 code 优先取
//    `errcode`，缺失时退回 `ret`，所以 body 里 `{ret:-14}` 或 `{errcode:-14}` 都能触发重登。
//
// 5) 原实现 `run()` 的 `stopped` 复位：原代码每次 run() 都 `this.stopped = false`，
//    但 runLoop 的 catch 里用 `this.stopped && isAbortError(error)` 判断 break —— 若
//    stop() 发生在 getUpdates 之外（比如 handler 执行中），循环下一轮不会立刻退出，
//    而是会再发一次长轮询。本移植保留同样语义（未见明显后果），只是 run({signal}) 更明确。
//
// 6) 原实现 `reply()` 里 `this.stopTyping(userId).catch(() => {})`：stopTyping 内部会
//    getconfig + sendtyping 两次网络往返，且无 context_token 时静默返回。本移植一致。
//
// 7) 原实现 `this.tokenPath` 是可选字段，但 loginFlow/loadCredentials 里用了 `this.tokenPath!`；
//    若调用方不传 tokenPath，Node 侧会在 readFile(undefined) 上抛类型错误。
//    本移植补了默认路径 DEFAULT_TOKEN_PATH（可用 env WEIXIN_BOT_TOKEN_PATH 覆盖）。
//
// 8) 原实现 `extractText` 里 `item.text_item?.text` 等用了可选链；本移植在 normalizeMessage
//    阶段已补全字段，行为一致。`voice_item.text` 当文字转写用，缺失退回 '[voice]'。
//
// 9) 原 `apiFetch` 用 electron `net.fetch`（走 chromium 网络栈，可走系统代理）；
//    本移植用 `globalThis.fetch`（undici），不读系统代理（需要时自行设
//    `NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY`，或传自定义 fetch）。
//
// 10) 原 `apiGet`（get_bot_qrcode / get_qrcode_status）没有超时；本移植保持无超时，
//     但允许传 signal。若二维码接口挂死，需要调用方自行 abort。
//
// 11) 原实现内层轮询在二维码 expired 后 break 回外层重新取码，但没有再次通知 UI
//     "wait"；本移植补了一次 onStatus('wait', { refreshed: true })。
//
// 12) 原实现没有 message_id 去重；本移植新增可选（默认开）去重窗口，可用
//     `new WeixinBot({ dedupe: false })` 关掉以完全对齐原行为。
// ============================================================================
