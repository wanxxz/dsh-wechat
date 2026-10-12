/**
 * 微信通道 —— Host 侧。
 *
 * 把官方微信 iLink Bot（微信 ClawBot）通道接到 DeepSeek Harness：二维码登录、
 * 每个微信用户一个 Session、用 agent 的回答自动回复、用于主动发送的 agent 工具，
 * 以及设置页背后的 HTTP API。
 *
 * 本模块只导入 Node 内置模块：所有 Harness 能力都通过 `ctx` 上的服务获取，
 * 因此解析问题绝不会在导入阶段让插件崩溃。
 *
 * 开发提示：桌面 profile 在其 `hmr` 行设置 `config.root` 后会监听本目录，
 * 所以这里的改动会重新加载插件，无需重启应用。
 */
import os from 'node:os'
import path from 'node:path'

import { WeChatChannel, defaultTokenPath } from './lib/channel.js'
import { WeChatChats } from './lib/chat.js'
import { registerWechatRoutes } from './lib/web.js'

/** 加载器诊断信息中使用的 Cordis 插件名。 */
export const name = 'wechat'

/** 通道离不开的服务；缺少它们时插件保持未激活。 */
export const inject = ['agents', 'workspaceRegistry']

/** 设置页 API 的默认 HTTP 前缀。 */
const DEFAULT_HTTP_PREFIX = '/wechat-channel'

/** Harness 主目录，与启动器自身的解析结果一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 解析 `autoStart` 策略。
 *
 * `always` 在插件加载时即登录（或启动扫码）；
 * `if-credentials` 只重连已登录的 bot，首次登录留给设置页；
 * `never` 每次都要等设置页操作。
 * @param {unknown} value - 原始配置值。
 * @returns {'always' | 'if-credentials' | 'never'} 解析后的策略。
 */
function autoStartPolicy(value) {
  if (value === true || value === 'always') return 'always'
  if (value === false || value === 'never') return 'never'
  if (value === 'if-credentials') return 'if-credentials'
  return 'if-credentials'
}

/**
 * 把行配置规范化为各模块期望的结构。
 * @param {object | undefined} raw - 该行的 `config`。
 * @returns {object} 已解析全部默认值的配置。
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.length > 0) : [])
  const home = dshHome()
  return {
    autoStart: autoStartPolicy(config.autoStart),
    autoReply: config.autoReply !== false,
    allowedUserIds: strings(config.allowedUserIds),
    workspacePath: typeof config.workspacePath === 'string' ? config.workspacePath : '',
    agentPreset: typeof config.agentPreset === 'string' ? config.agentPreset : '',
    permissionPreset: typeof config.permissionPreset === 'string' ? config.permissionPreset : '',
    tokenPath: typeof config.tokenPath === 'string' && config.tokenPath.length > 0 ? config.tokenPath : defaultTokenPath(home),
    statePath: typeof config.statePath === 'string' && config.statePath.length > 0 ? config.statePath : WeChatChats.defaultStatePath(home),
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    model: config.model ?? null,
    typingIndicator: config.typingIndicator !== false,
    agentTool: config.agentTool !== false,
    approvalFallback: config.approvalFallback === 'default' ? 'default' : 'reject',
    qrAutoLogin: config.qrAutoLogin !== false,
    defaultLanguage: config.defaultLanguage === 'en' ? 'en' : 'zh',
    turnTimeoutMs: Number.isSafeInteger(config.turnTimeoutMs) && config.turnTimeoutMs > 0 ? config.turnTimeoutMs : undefined,
    httpPrefix: typeof config.httpPrefix === 'string' && config.httpPrefix.startsWith('/') ? config.httpPrefix.replace(/\/+$/u, '') : DEFAULT_HTTP_PREFIX,
    defaultWorkspacePath: path.join(home, 'plugins', '@wanxxz', 'dsh-wechat', 'workspace'),
    dshHome: home,
  }
}

/**
 * 基于 `ctx.logger` 的最小日志器，带 console 兜底。
 * @param {object} ctx - 插件上下文。
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} 日志器。
 */
function createLogger(ctx) {
  const service = ctx.logger
  const write = (level, message) => {
    try {
      if (service !== undefined && typeof service[level] === 'function') service[level](message)
      else if (level === 'error') console.error(`[wechat] ${message}`)
      else if (level === 'warn') console.warn(`[wechat] ${message}`)
    } catch {
      /* 日志绝不能弄坏通道 */
    }
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * 注册 `wechat_send` agent 工具。
 *
 * 该定义是按 `ctx.tools.register` 自身的约定手写的
 * （`output.render` 加受支持的 JSON Schema），而不是导入 `defineTool`，
 * 这样插件对 Harness 的导入保持为零。
 * @param {object} ctx - 插件上下文。
 * @param {object} chats - 桥接对象，用于解析调用者并发送。
 * @param {object} logger - 日志器。
 * @returns {Function | undefined} 注册的清理函数。
 */
function registerSendTool(ctx, chats, logger) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    logger.warn('wechat: no tools service in this profile; the wechat_send tool is not registered')
    return undefined
  }

  const definition = {
    name: 'wechat_send',
    description:
      'Send a WeChat message as the channel bot. With no `userId`, the message goes to the person whose WeChat conversation owns the current Session. Use it to push a result, a reminder, or a scheduled report into WeChat. The recipient must have messaged the bot at least once, because WeChat needs a conversation context to deliver.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Message body to deliver. Long bodies are split at WeChat\u2019s 2000-character limit.' },
        userId: { type: 'string', description: 'WeChat user id to send to. Omit to reply to this Session\u2019s own WeChat user.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['delivered'],
        properties: {
          delivered: { type: 'boolean' },
          userId: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.delivered === true
              ? `Delivered to WeChat user ${value.userId}.`
              : `Not delivered: ${value.error ?? 'unknown error'}`,
        },
      ],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const owner = chats.ownerOfSession(exec?.agent?.session?.id)
      const target = typeof args.userId === 'string' && args.userId.length > 0 ? args.userId : owner
      if (typeof target !== 'string' || target.length === 0) {
        return {
          delivered: false,
          error: 'no recipient: pass userId, or call this from a Session created by the WeChat channel',
        }
      }
      try {
        await chats.sendToUser(target, args.text)
        return { delivered: true, userId: target }
      } catch (error) {
        return { delivered: false, userId: target, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  try {
    const dispose = tools.register(definition)
    logger.info('wechat: registered the wechat_send tool')
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    logger.warn(`wechat: could not register wechat_send: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 在当前 profile 中激活微信通道。
 * @param {object} ctx - 插件上下文。
 * @param {object} [rawConfig] - `cordis.patch.yml` 中该行的 `config`。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = createLogger(ctx)

  /** 在下方赋值；通道的入站接收器闭包引用此绑定。 */
  let chats = null
  const channel = new WeChatChannel({
    config,
    logger,
    onInbound: (message) => {
      if (chats === null) return
      void chats.handleInbound(message)
    },
  })
  chats = new WeChatChats({
    ctx,
    config,
    channel,
    logger,
    statePath: config.statePath,
    defaultWorkspacePath: config.defaultWorkspacePath,
  })

  logger.info(`wechat: channel ready (state ${config.statePath}, workspace ${config.workspacePath || config.defaultWorkspacePath})`)

  ctx.effect(
    () => {
      let stopped = false
      const boot = (async () => {
        await chats.start()
        if (stopped) return
        if (config.autoStart === 'never') return
        if (config.autoStart === 'if-credentials' && !(await channel.credentialsExist())) {
          logger.info('wechat: no stored credentials; sign in from Settings → Built-in plugins → WeChat')
          return
        }
        try {
          await channel.start()
        } catch (error) {
          logger.warn(`wechat: auto-start login failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      return async () => {
        stopped = true
        await boot.catch(() => undefined)
        await chats.dispose()
        channel.stop()
      }
    },
    'wechat: lifecycle',
  )

  if (config.agentTool) {
    ctx.effect(() => {
      const dispose = registerSendTool(ctx, chats, logger)
      return () => dispose?.()
    }, 'wechat: agent tool')
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const dispose = registerWechatRoutes({
        register: (route) => child.webServer.register(route),
        prefix: config.httpPrefix,
        channel,
        chats,
        logger,
        autoLoginOnQr: config.qrAutoLogin,
      })
      logger.info(`wechat: settings API mounted at ${config.httpPrefix}`)
      return dispose
    }, 'wechat: settings API')
  })
}
