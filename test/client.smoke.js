/**
 * 客户端半边冒烟测试：按照 Harness 浏览器模块加载器的方式加载构建产物
 * `client.js`，把它应用到伪造的客户端上下文，并针对预设的 Host 应答渲染
 * 设置标签页。
 *
 * 它验证三件否则只能在浏览器里才暴露的事：模块以文档所述的选项注册到
 * `settings.plugins.tab`，组件渲染时不抛异常，以及内置的 QR 编码器为登录
 * 载荷生成真实矩阵。
 *
 * 运行：`node test/client.smoke.js`。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await readFile(path.join(here, '..', 'client.js'), 'utf8')

/** Hooks 运行时：只提供渲染一棵组件树所需的最少 React 能力。 */
let hooks = []
let cursor = 0
let dirty = false

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.flat() } }
  },
  useState(initial) {
    const index = cursor
    cursor += 1
    if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      dirty = true
    }
    return [hooks[index], set]
  },
  useMemo(factory, deps) {
    const index = cursor
    cursor += 1
    const key = JSON.stringify(deps ?? [])
    if (hooks[index]?.key !== key) hooks[index] = { key, value: factory() }
    return hooks[index].value
  },
  useCallback(factory, deps) {
    return React.useMemo(() => factory, deps)
  },
  useEffect(effect, deps) {
    const index = cursor
    cursor += 1
    const key = JSON.stringify(deps ?? [])
    if (hooks[index]?.key === key) return
    hooks[index] = { key }
    const cleanup = effect()
    if (typeof cleanup === 'function') hooks[index].cleanup = cleanup
  },
}

/** 重置 hooks 运行时后渲染一次组件。 */
function render(Component, props) {
  cursor = 0
  dirty = false
  return Component(props)
}

/**
 * 把函数组件展开为普通元素，便于断言遍历整棵树。这一趟展开使用全新的
 * hooks 槽位数组，展开结束后再恢复被渲染组件自身的槽位，因此展开永远不会
 * 破坏它的状态。
 * @param {unknown} node - 渲染树或元素。
 * @returns {unknown} 展开后的树。
 */
function expandTree(node) {
  const savedHooks = hooks
  const savedCursor = cursor
  hooks = []
  cursor = 0
  try {
    return expand(node)
  } finally {
    hooks = savedHooks
    cursor = savedCursor
  }
}

function expand(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  const { type, props } = node
  const children = expand(props?.children)
  const next = { ...props, children }
  return typeof type === 'function' ? expand(type(next)) : { type, props: next }
}

/** 从渲染树中收集某一标签的全部元素。 */
function findAll(root, tag) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const item of current) walk(item)
      return
    }
    if (current.type === tag) found.push(current)
    walk(current.props?.children)
  }
  walk(expandTree(root))
  return found
}

/** 渲染树的文本内容，用于文案断言。 */
function textOf(node) {
  const walk = (current) => {
    if (current === null || current === undefined) return ''
    if (typeof current === 'string' || typeof current === 'number') return String(current)
    if (Array.isArray(current)) return current.map(walk).join('')
    return walk(current.props?.children)
  }
  return walk(expandTree(node))
}

const channelState = {
  state: 'login',
  userId: null,
  accountId: null,
  baseUrl: '',
  tokenPath: 'C:\\Users\\me\\.dsh\\plugins\\@wanxxz\\dsh-wechat\\weixin_bot.json',
  qr: { content: 'https://ilinkai.weixin.qq.com/qrcode?ticket=abc123def456', status: 'wait', at: new Date().toISOString() },
  startedAt: null,
  lastError: null,
  lastInboundAt: null,
  lastOutboundAt: null,
  inboundCount: 2,
  outboundCount: 3,
  allowedUserIds: [],
  autoReply: true,
}

const userRow = {
  userId: 'wx-abcdef123456',
  messages: 7,
  lastSeenAt: new Date().toISOString(),
  sessionId: 'wechat-0f0f0f0f-1111-2222-3333-444444444444',
  turns: 3,
  allowed: true,
  live: true,
}

// 旧版 Host 半边上报的计数字段名是 `users`/`sessions`；页面必须退回到
// `/users` 获取行列表，并提示需要重启。后续的检查会把它切换为当前的形态。
const hostAnswers = {
  '/wechat-channel/state': {
    ok: true,
    value: {
      channel: channelState,
      chat: {
        users: 1,
        sessions: 1,
        activeAgents: 1,
        pendingTurns: 0,
        workspacePath: 'C:\\Users\\me\\.dsh\\plugins\\@wanxxz\\dsh-wechat\\workspace',
        statePath: 'C:\\Users\\me\\.dsh\\plugins\\@wanxxz\\dsh-wechat\\state.json',
        allowedUserIds: [],
      },
    },
  },
  '/wechat-channel/users': {
    ok: true,
    value: { users: [userRow], chat: { userCount: 1, sessionCount: 1, activeAgents: 1, pendingTurns: 0 } },
  },
}

const calls = { fetch: [], registered: [], locale: [] }
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(module) {
      loaded = module
    },
  },
}
globalThis.fetch = async (url, options) => {
  calls.fetch.push({ url, options })
  const payload = hostAnswers[url] ?? { ok: true, value: { users: [], chat: {} } }
  return { status: 200, json: async () => payload }
}
globalThis.document = { visibilityState: 'visible' }

// 1. 模块以包名注册自身，并返回插件的形状。
// `client.js` 是浏览器模块文件，而非 ESM 导入：像 script 标签那样，针对上面
// 安装的全局对象求值它的源码。
new Function(source)()
assert.ok(loaded !== null, 'client.js must call window.__ModuleLoader__.load')
const factory = loaded.factory
assert.equal(loaded.id, '@wanxxz/dsh-wechat')
const plugin = factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})
assert.deepEqual(plugin.inject, ['slots', 'locale'])
assert.equal(typeof plugin.apply, 'function')

// 2. apply() 按照 slot 自身的选项契约注册设置标签页。
const fakeCtx = {
  effect(factory, label) {
    calls.registered.push({ kind: 'effect', label })
    const dispose = factory()
    return () => dispose?.()
  },
  locale: {
    register(namespace, dictionaries) {
      calls.locale.push({ namespace, languages: Object.keys(dictionaries) })
      return () => {}
    },
    bind(namespace) {
      const dictionaries = { zh: {}, en: {} }
      return (key) => {
        const bundle = {
          zh: {
            tab: '微信',
            title: '微信频道',
            subtitle: 's',
            stateLogin: '等待扫码',
            account: '机器人账号',
            noAccount: '未登录',
            login: '扫码登录',
            refresh: '刷新',
            tokenPath: '凭据文件',
            inboundCount: '收到',
            outboundCount: '发出',
            lastInbound: '最后收到消息',
            lastOutbound: '最后发出消息',
            allowlist: '允许的微信用户',
            allowlistEmpty: 'empty',
            users: '已知用户',
            noUsers: 'none',
            messages: '消息数',
            lastSeen: '最后活跃',
            allowed: '允许',
            blocked: '已禁止',
            allow: '允许',
            block: '禁止',
            resetSession: '重置会话',
            resetHint: 'hint',
            send: '发送测试消息',
            sendHint: 'hint2',
            commandsHint: 'cmds',
            qrTitle: '用手机微信扫码',
            qrHint: 'qr hint',
            openQr: '在新标签页打开二维码',
            staleHostTitle: '请先重启 DeepSeek Harness',
            staleHostBody: '当前运行的 Host 还是安装时那版代码，请重启应用后再扫码。',
            staleHostButton: '已暂停扫码，重启后再试',
            qrWaiting: 'waiting',
            loading: 'loading',
            unavailable: 'unavailable',
            error: '错误',
            sendPlaceholder: 'text',
            sendAction: '发送',
            sent: '已发送',
          },
          en: {},
        }
        void namespace
        void dictionaries
        return bundle.zh[key] ?? key
      }
    },
  },
  slots: {
    inject(owner, callback) {
      calls.registered.push({ kind: 'inject', owner })
      return callback()
    },
    register(options, component) {
      calls.registered.push({ kind: 'register', options, component })
      return () => {}
    },
  },
}
plugin.apply(fakeCtx)

const registration = calls.registered.find((entry) => entry.kind === 'register')
assert.ok(registration, 'apply() must register a slot entry')
assert.equal(registration.options.name, 'settings.plugins.tab')
assert.equal(registration.options.id, 'wechat')
assert.equal(typeof registration.options.order, 'number')
assert.equal(typeof registration.options.label, 'function')
assert.equal(registration.options.label(), '微信')
assert.equal(registration.options.locale, 'settings.wechat')
assert.deepEqual(calls.locale, [{ namespace: 'settings.wechat', languages: ['zh', 'en'] }])

// 3. 标签页完成渲染，轮询 Host，并把 QR 载荷绘制为 SVG 矩阵。
const Component = registration.component
let tree = render(Component, { t: registration.options.inject().t })
await new Promise((resolve) => setTimeout(resolve, 10))
tree = render(Component, { t: registration.options.inject().t })

assert.equal(calls.fetch.length >= 1, true, 'the tab must read /wechat-channel/state')
assert.equal(calls.fetch[0].url, '/wechat-channel/state')

const svgs = findAll(tree, 'svg')
assert.equal(svgs.length, 1, 'the login state must draw exactly one QR svg')
const qrPath = findAll(svgs[0], 'path').find((node) => typeof node.props.d === 'string' && node.props.d.length > 100)
assert.ok(qrPath, 'the QR svg must contain a module path')
const segments = qrPath.props.d.split('M').length - 1
assert.ok(segments > 300, `a version-3-and-up QR has many modules, got ${segments}`)
assert.equal(svgs[0].props.viewBox.startsWith('0 0 '), true)
const viewBoxSize = Number(svgs[0].props.viewBox.split(' ')[2])
assert.ok(viewBoxSize >= 21 && viewBoxSize <= 57, `QR module count out of range: ${viewBoxSize}`)

// 页面还会链接到 Host 渲染的降级页面，后者不需要客户端半边。
{
  const links = findAll(tree, 'a')
  const fallback = links.find((node) => node.props.href === '/wechat-channel/qr')
  assert.ok(fallback, 'the QR block must link the Host-rendered fallback page')
  assert.equal(fallback.props.target, '_blank')
}

// 5. 早于本页构建版本的 Host 半边会被上报，并且登录会被暂停：
// 它的 Session 建立顺序是坏的，因此放行扫码会一路走进失败的对话。
{
  const text = textOf(tree)
  assert.match(text, /微信频道/u, 'the page copy must render')
  assert.match(text, /等待扫码/u, 'the channel state must render')
  assert.match(text, /请先重启 DeepSeek Harness/u, 'a stale Host must be called out')
  const login = findAll(tree, 'button').find((node) => node.props.disabled === true)
  assert.ok(login, 'login must be disabled while the Host half is stale')
  assert.match(textOf(login), /重启后再试/u)
}

// 6. 对于只提供计数的 Host，用户行通过 `/users` 降级路径到达。
assert.ok(
  calls.fetch.some((entry) => entry.url === '/wechat-channel/users'),
  'a counts-only /state must fall back to /users for the row list',
)
assert.match(textOf(tree), /wx-abcdef123456/u, 'the user row must render')

// 7. 具备当前形态的 Host 自身携带用户行，不给出任何警告，并且它的登录操作
// 重新变为可用。
{
  hostAnswers['/wechat-channel/state'].value.chat = {
    userCount: 1,
    sessionCount: 1,
    activeAgents: 1,
    pendingTurns: 0,
    workspacePath: 'C:\\Users\\me\\.dsh\\plugins\\@wanxxz\\dsh-wechat\\workspace',
    statePath: 'C:\\Users\\me\\.dsh\\plugins\\@wanxxz\\dsh-wechat\\state.json',
    allowedUserIds: [],
    users: [userRow],
  }
  const before = calls.fetch.filter((entry) => entry.url === '/wechat-channel/users').length
  render(Component, { t: registration.options.inject().t })
  await new Promise((resolve) => setTimeout(resolve, 10))
  tree = render(Component, { t: registration.options.inject().t })
  const after = calls.fetch.filter((entry) => entry.url === '/wechat-channel/users').length
  assert.equal(after, before, 'a /state that carries users must not trigger /users')
  assert.doesNotMatch(textOf(tree), /请先重启/u, 'a current Host must not warn')
  assert.match(textOf(tree), /wx-abcdef123456/u)
}

// 8. 各项操作都会带变更请求头调用 Host，而 QR 流程从不在这些调用上阻塞。
const buttons = findAll(tree, 'button')
assert.ok(buttons.length >= 2, 'the tab must render its actions')
const loginButton = buttons.find((node) => textOf(node) === '扫码登录')
assert.ok(loginButton, 'the login action must be present')
assert.notEqual(loginButton.props.disabled, true, 'login must be enabled on a current Host')
await loginButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 10))
const posted = calls.fetch.find((entry) => entry.url === '/wechat-channel/login')
assert.ok(posted, 'the login action must POST /wechat-channel/login')
assert.equal(posted.options.method, 'POST')
assert.equal(posted.options.headers['x-dsh-wechat'], '1')

console.log('client smoke test: all checks passed')
// 标签页按定时器轮询；本测试不渲染清理那一趟。
process.exit(0)
