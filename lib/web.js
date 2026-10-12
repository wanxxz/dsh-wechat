/**
 * 微信设置页背后的 Host HTTP API。
 *
 * Harness Web 客户端通过 `ctx.webServer` 访问 Host，而第三方插件无法加入随包
 * 发布的 Remote（typert）装配，因此该页面改为与这些路由通信。每个会修改状态的
 * 路由都要求 `x-dsh-wechat` 请求头：跨源页面发送该请求头会触发 CORS 预检，而
 * 本服务器从不响应这种预检，所以任意网页都无法驱动机器人，而同源的 Harness
 * 页面可以。
 *
 * `/qr` 与 `/qr.svg` 返回的是标记文本而非 JSON：它们是备用的登录入口，在客户端
 * 部分加载之前，任何浏览器都能访问。
 */
import { qrPage, qrSvg } from './qr.js'

/** 调用方在会修改状态的请求上必须发送的请求头。 */
export const REQUIRED_HEADER = 'x-dsh-wechat'

/** 可接受的最大请求体大小，单位为字节。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 读取并解析一个小型 JSON 请求体。
 * @param {import('node:http').IncomingMessage} request - HTTP 请求。
 * @returns {Promise<object>} 解析出的对象（请求体为空时返回空对象）。
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/**
 * 写入一个 JSON 响应。
 * @param {import('node:http').ServerResponse} response - HTTP 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 可 JSON 序列化的负载。
 */
function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * 在 Harness Web 服务器上注册该频道的 HTTP 接口。
 *
 * @param {object} options - 装配参数。
 * @param {(route: object) => (() => void)} options.register - 绑定到服务器的 `ctx.webServer.register`。
 * @param {string} options.prefix - 路由前缀，例如 `/wechat-channel`。
 * @param {object} options.channel - `WeChatChannel` 实例。
 * @param {object} options.chats - 聊天注册表（会话、用户、白名单）。
 * @param {{debug: Function, info: Function, warn: Function, error: Function}} options.logger - 日志记录器。
 * @returns {() => void} 移除所有路由的清理函数。
 */
export function registerWechatRoutes(options) {
  const { register, prefix, channel, chats, logger } = options
  const autoLoginOnQr = options.autoLoginOnQr !== false
  const disposers = []

  /**
   * 页面的完整视图：频道信息、桥接计数以及用户行。
   * @returns {object} 可安全序列化为 JSON 的视图。
   */
  const view = () => ({ channel: channel.snapshot(), chat: { ...chats.snapshot(), users: chats.users() } })

  /**
   * 为一个处理函数套上方法校验、请求头策略与错误上报。
   * @param {string} path - 前缀之下的路由路径。
   * @param {{ methods: string[], mutate?: boolean, handler: Function }} spec - 路由规格。
   */
  const route = (path, spec) => {
    const handler = async (request, response) => {
      try {
        if (!spec.methods.includes(request.method ?? 'GET')) {
          response.writeHead(405, { allow: spec.methods.join(', ') })
          response.end()
          return
        }
        if (spec.mutate === true && request.headers[REQUIRED_HEADER] === undefined) {
          sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: `missing ${REQUIRED_HEADER} header` } })
          return
        }
        const body = spec.mutate === true ? await readJsonBody(request) : {}
        const value = await spec.handler(body, request)
        sendJson(response, 200, { ok: true, value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`wechat: ${spec.methods.join('/')} ${path} failed: ${message}`)
        sendJson(response, 400, { ok: false, error: { code: 'request-failed', message } })
      }
    }
    disposers.push(register({ path: `${prefix}${path}`, kind: 'exact', handler }))
  }

  /**
   * 注册一个自行写入响应体的路由（标记文本，而非 JSON）。
   * @param {string} path - 前缀之下的路由路径。
   * @param {string[]} methods - 可接受的方法。
   * @param {(request: object, response: object) => Promise<void>} handler - 响应体写入函数。
   */
  const rawRoute = (path, methods, handler) => {
    const wrapped = async (request, response) => {
      try {
        if (!methods.includes(request.method ?? 'GET')) {
          response.writeHead(405, { allow: methods.join(', ') })
          response.end()
          return
        }
        await handler(request, response)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`wechat: ${methods.join('/')} ${path} failed: ${message}`)
        const body = `wechat channel error: ${message}\n`
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
        response.end(body)
      }
    }
    disposers.push(register({ path: `${prefix}${path}`, kind: 'exact', handler: wrapped }))
  }

  /**
   * 写入一个文本响应体，并使用 no-store 缓存策略。
   * @param {object} response - HTTP 响应。
   * @param {number} status - HTTP 状态码。
   * @param {string} contentType - 媒体类型。
   * @param {string} body - 响应体。
   */
  const sendText = (response, status, contentType, body) => {
    response.writeHead(status, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  rawRoute('/qr.svg', ['GET'], async (_request, response) => {
    const snapshot = channel.snapshot()
    if (snapshot.qr === null) {
      sendText(response, 404, 'text/plain; charset=utf-8', 'no QR code: start a login first\n')
      return
    }
    sendText(response, 200, 'image/svg+xml; charset=utf-8', await qrSvg(snapshot.qr.content, { size: 260 }))
  })

  rawRoute('/qr', ['GET'], async (_request, response) => {
    const snapshot = channel.snapshot()
    // 打开此页面就足以发起一次登录：在设置标签页始终无法渲染的部署环境中，
    // 它就是备用界面。启动是幂等的，并且绝不会强制已有账号重新扫码。
    if (autoLoginOnQr && snapshot.qr === null && snapshot.state !== 'login' && snapshot.userId === null) {
      void channel.start({ force: false }).catch((error) => {
        logger.warn(`wechat: login from the fallback page failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }
    let svg = null
    if (snapshot.qr !== null) {
      try {
        svg = await qrSvg(snapshot.qr.content, { size: 260 })
      } catch (error) {
        logger.warn(`wechat: could not render the QR: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const page = qrPage({
      svg,
      status: snapshot.qr?.status ?? snapshot.state,
      account: snapshot.userId,
      prefix,
      error: snapshot.lastError,
    })
    sendText(response, 200, 'text/html; charset=utf-8', page)
  })

  route('/state', {
    methods: ['GET'],
    handler: () => view(),
  })

  route('/login', {
    methods: ['POST'],
    mutate: true,
    handler: (body) => {
      const force = body.force === true
      // 扫码流程会一直阻塞到用户在手机上确认为止，所以这个请求只负责启动它：
      // 页面改为轮询 `/state` 来获取二维码载荷以及随后出现的 `online` 状态，
      // 而不是让该响应一直挂起。
      void channel.start({ force }).catch((error) => {
        logger.warn(`wechat: login attempt failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return view()
    },
  })

  route('/logout', {
    methods: ['POST'],
    mutate: true,
    handler: () => {
      channel.stop()
      return view()
    },
  })

  route('/qr/dismiss', {
    methods: ['POST'],
    mutate: true,
    handler: () => {
      channel.clearQr()
      return view()
    },
  })

  route('/send', {
    methods: ['POST'],
    mutate: true,
    handler: async (body) => {
      const userId = typeof body.userId === 'string' ? body.userId : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (userId.length === 0) throw new Error('userId is required')
      if (text.trim().length === 0) throw new Error('text is required')
      await channel.sendText(userId, text)
      return view()
    },
  })

  route('/users', {
    methods: ['GET'],
    handler: () => ({ users: chats.users(), chat: chats.snapshot() }),
  })

  route('/allow', {
    methods: ['POST'],
    mutate: true,
    handler: async (body) => {
      const userId = typeof body.userId === 'string' ? body.userId : ''
      if (userId.length === 0) throw new Error('userId is required')
      await chats.setAllowed(userId, body.allowed !== false)
      return { users: chats.users(), chat: chats.snapshot() }
    },
  })

  route('/reset', {
    methods: ['POST'],
    mutate: true,
    handler: async (body) => {
      const userId = typeof body.userId === 'string' ? body.userId : ''
      if (userId.length === 0) throw new Error('userId is required')
      await chats.resetSession(userId)
      return { users: chats.users(), chat: chats.snapshot() }
    },
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        logger.warn(`wechat: route disposer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
