/**
 * 通道的微信侧：一个长连接的 bot、它的登录生命周期，
 * 以及给设置页用的 JSON 安全状态快照。
 *
 * 本模块刻意不从 DeepSeek Harness 导入任何东西：它是传输层，
 * Harness 桥接位于 `index.js`。这样整个微信接口都能在
 * 纯 `node` 脚本中运行以便诊断。
 */
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { WeixinBot, splitWeChatMessage } from './wechat-protocol.js'

/** 暴露给 UI 和 agent 工具的登录生命周期状态。 */
export const CHANNEL_STATES = Object.freeze(['idle', 'login', 'online', 'error', 'stopped'])

/** 默认凭据文件，放在 Harness 主目录内以便升级后仍保留。 */
export function defaultTokenPath(dshHome) {
  const home = dshHome && dshHome.length > 0 ? dshHome : path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugins', '@wanxxz', 'dsh-wechat', 'weixin_bot.json')
}

/**
 * 按微信 2000 字符正文上限切分消息文本。
 * 这里重新导出，调用方无需引入协议模块。
 * @param {string} text - 完整回复正文。
 * @returns {string[]} 有序分片。
 */
export { splitWeChatMessage }

/**
 * 一个微信 bot 连接，外加扫码登录流程。
 *
 * bot 开始轮询时 `start()` 才 resolve；平台一下发二维码内容，
 * 就通过 `onQr` 发布，因此登录仍在进行时设置页就能展示它。
 */
export class WeChatChannel {
  /**
   * @param {object} options - 通道接线。
   * @param {object} options.config - 规范化后的插件配置。
   * @param {(message: object) => void} options.onInbound - 入站文本接收器。
   * @param {{debug: Function, info: Function, warn: Function, error: Function}} options.logger - 日志器。
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.onInbound = options.onInbound
    this.bot = null
    this.controller = null
    this.state = 'idle'
    this.qr = null
    this.credentials = null
    this.startedAt = null
    this.lastError = null
    this.lastInboundAt = null
    this.lastOutboundAt = null
    this.inboundCount = 0
    this.outboundCount = 0
    this.loginPromise = null
  }

  /** @returns {string} 当前生效的凭据绝对路径。 */
  tokenPath() {
    return this.config.tokenPath && this.config.tokenPath.length > 0
      ? this.config.tokenPath
      : defaultTokenPath(process.env.DSH_HOME)
  }

  /** @returns {boolean} 该路径是否已存在凭据。 */
  hasCredentials() {
    return this.credentials !== null
  }

  /**
   * 磁盘上是否已有可用凭据文件，且无需登录。
   *
   * 通道用它判断自动启动会复用已有会话，还是会阻塞在没人要求的扫码上。
   * @returns {Promise<boolean>} 文件含有 token 时为 true。
   */
  async credentialsExist() {
    try {
      const raw = await readFile(this.tokenPath(), 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed?.token === 'string' && parsed.token.length > 0
    } catch {
      return false
    }
  }

  /**
   * 发布可安全序列化到浏览器的状态快照。
   * @returns {object} 当前通道事实。
   */
  snapshot() {
    return {
      state: this.state,
      userId: this.credentials?.userId ?? null,
      accountId: this.credentials?.accountId ?? null,
      baseUrl: this.credentials?.baseUrl ?? this.config.baseUrl ?? null,
      tokenPath: this.tokenPath(),
      qr: this.qr === null ? null : { content: this.qr.content, status: this.qr.status, at: this.qr.at },
      startedAt: this.startedAt,
      lastError: this.lastError,
      lastInboundAt: this.lastInboundAt,
      lastOutboundAt: this.lastOutboundAt,
      inboundCount: this.inboundCount,
      outboundCount: this.outboundCount,
      allowedUserIds: [...this.config.allowedUserIds],
      autoReply: this.config.autoReply,
    }
  }

  /**
   * 创建 bot，必要时完成扫码登录，然后在后台轮询。
   * @param {{ force?: boolean }} [options] - `force` 要求重新扫码。
   * @returns {Promise<object>} 凭据记录。
   */
  async start(options = {}) {
    if (this.loginPromise !== null) return this.loginPromise
    this.loginPromise = this.#start(options).finally(() => {
      this.loginPromise = null
    })
    return this.loginPromise
  }

  async #start(options) {
    this.#disposeBot()
    this.lastError = null
    this.state = 'login'
    this.qr = null
    this.controller = new AbortController()

    const bot = new WeixinBot({
      baseUrl: this.config.baseUrl && this.config.baseUrl.length > 0 ? this.config.baseUrl : undefined,
      tokenPath: this.tokenPath(),
      logger: (message, detail) => this.logger.debug(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`),
      onError: (error) => {
        this.lastError = errorMessage(error)
        this.logger.warn(`wechat: bot error: ${this.lastError}`)
      },
      onQr: (content, info) => {
        this.qr = { content, status: 'wait', at: new Date().toISOString(), qrcode: info?.qrcode ?? null }
        this.state = 'login'
        this.logger.info('wechat: QR code issued, waiting for scan')
      },
      onStatus: (status) => {
        if (this.qr !== null) this.qr = { ...this.qr, status }
        if (status === 'expired') this.logger.warn('wechat: QR code expired; a new one will be issued')
        if (status === 'scaned') this.logger.info('wechat: QR code scanned, waiting for confirmation')
      },
    })
    this.bot = bot

    bot.onMessage((message) => {
      void this.#dispatch(message)
    })

    try {
      const credentials = await bot.login({ force: options.force === true })
      this.credentials = credentials
      this.qr = null
      this.state = 'online'
      this.startedAt = new Date().toISOString()
      this.logger.info(`wechat: logged in as ${credentials.userId}`)
    } catch (error) {
      this.lastError = errorMessage(error)
      this.state = 'error'
      this.logger.error(`wechat: login failed: ${this.lastError}`)
      throw error
    }

    void bot.run({ signal: this.controller.signal }).catch((error) => {
      if (this.controller?.signal.aborted === true) return
      this.lastError = errorMessage(error)
      this.state = 'error'
      this.logger.error(`wechat: polling stopped: ${this.lastError}`)
    })

    return this.credentials
  }

  /** 停止轮询并忘掉内存中的会话（凭据仍保留在磁盘上）。 */
  stop() {
    this.#disposeBot()
    if (this.state !== 'idle') this.state = 'stopped'
  }

  /** 删除或替换已存储的二维码内容，例如页面隐藏它之后。 */
  clearQr() {
    this.qr = null
  }

  #disposeBot() {
    this.controller?.abort()
    this.controller = null
    if (this.bot !== null) {
      this.bot.stop()
      this.bot = null
    }
  }

  async #dispatch(message) {
    this.inboundCount += 1
    this.lastInboundAt = new Date().toISOString()
    try {
      await this.onInbound(message)
    } catch (error) {
      this.logger.error(`wechat: inbound handler failed: ${errorMessage(error)}`)
    }
  }

  /**
   * 发送一条回复正文，按平台上限分片。
   * @param {string} userId - 微信接收方 id。
   * @param {string} text - 完整回复文本。
   * @throws 当 bot 未登录或没有缓存的 context token 时抛出。
   */
  async sendText(userId, text) {
    const bot = this.bot
    if (bot === null) throw new Error('WeChat channel is not connected')
    const body = typeof text === 'string' ? text : String(text ?? '')
    if (body.trim().length === 0) return
    const chunks = splitWeChatMessage(body)
    for (let index = 0; index < chunks.length; index += 1) {
      await bot.send(userId, chunks[index])
      this.outboundCount += 1
      this.lastOutboundAt = new Date().toISOString()
      if (index < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  /**
   * 通过入站消息自身的 context token 回复。
   * @param {object} message - 带 context token 的入站消息。
   * @param {string} text - 回复正文。
   */
  async replyTo(message, text) {
    const bot = this.bot
    if (bot === null) throw new Error('WeChat channel is not connected')
    const chunks = splitWeChatMessage(typeof text === 'string' ? text : String(text ?? ''))
    for (let index = 0; index < chunks.length; index += 1) {
      await bot.reply(message, chunks[index])
      this.outboundCount += 1
      this.lastOutboundAt = new Date().toISOString()
      if (index < chunks.length - 1) await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  /** 在微信聊天中显示“正在输入”；失败按设计不致命。 */
  async showTyping(userId) {
    try {
      await this.bot?.sendTyping(userId)
    } catch {
      /* 需要缓存的 context token；首条消息之前忽略即可 */
    }
  }
}

/**
 * 为任意抛出的值生成可读文本。
 * @param {unknown} error - 抛出的值。
 * @returns {string} 消息文本。
 */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
