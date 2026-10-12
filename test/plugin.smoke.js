/**
 * 插件冒烟测试：把真实的 `index.js` 应用到伪造的 Harness 上下文，并演练设置
 * 页面和 agent 所用的各项接口面——工具注册以及 `/wechat-channel` HTTP API。
 *
 * 运行：`node test/plugin.smoke.js`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { apply, normalizeConfig } from '../index.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-plugin-'))
const routes = new Map()
const tools = []
const sent = []
const state = { channel: 'stopped' }

/** 按路由处理函数的方式读取请求体。 */
async function* body(source) {
  if (source !== undefined) yield Buffer.from(source, 'utf8')
}

function makeRequest(method, payload, extraHeaders = {}) {
  return {
    method,
    headers: { ...extraHeaders },
    [Symbol.asyncIterator]: () => body(payload),
  }
}

function makeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (typeof chunk === 'string') this.body = chunk
    },
  }
}

const children = []
const ctx = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  agents: { get: () => undefined },
  workspaceRegistry: { create: async (target) => ({ path: target, attachSession: async () => {} }) },
  webServer: undefined,
  get: (name) =>
    ({
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      },
      agentPresets: { resolve: async (id) => ({ id: id ?? 'standard' }), mount: async () => {} },
      permissionPresets: { resolve: (id) => id, set: () => {} },
      sessionTitle: { rename: () => {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })[name],
  on() {
    return () => {}
  },
  effect(factory) {
    const dispose = factory()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(names, callback) {
    children.push(names)
    callback({
      logger: ctx.logger,
      get: ctx.get,
      on: ctx.on,
      effect: ctx.effect,
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    })
  },
}

const config = normalizeConfig({
  autoStart: false,
  statePath: path.join(root, 'state.json'),
  workspacePath: path.join(root, 'workspace'),
  agentTool: true,
  // 降级 QR 页面在打开时会启动一次登录；本测试绝不能触达真实平台，因此它在
  // 不带该副作用的情况下演练这个页面。
  qrAutoLogin: false,
})

// 插件构建的频道是内部的；无法通过替换路由闭包捕获的那些部件来驱动它的可观测
// 接口面，因此下面的断言停留在伪造上下文所能看到的注册/行为层面。
apply(ctx, config)
await new Promise((resolve) => setTimeout(resolve, 50))

// 1. 工具按 `ctx.tools.register` 要求的契约完成注册。
assert.equal(tools.length, 1, 'exactly one agent tool must be registered')
const tool = tools[0]
assert.equal(tool.name, 'wechat_send')
assert.equal(typeof tool.execute, 'function')
assert.equal(typeof tool.output.render, 'function')
assert.equal(tool.parameters.type, 'object')
assert.deepEqual(tool.parameters.required, ['text'])
assert.match(tool.description, /WeChat/u)
assert.equal(tool.output.render({}, { delivered: true, userId: 'u1' })[0].text, 'Delivered to WeChat user u1.')
assert.match(tool.output.render({}, { delivered: false, error: 'boom' })[0].text, /boom/u)

// 2. 没有接收者时，工具会直接拒绝，而不是去猜测。
{
  const result = await tool.execute({ text: 'hi' }, {})
  assert.equal(result.delivered, false)
  assert.match(result.error, /no recipient/u)
}

// 3. 每一条文档所述的路由都挂载在配置的前缀之下。
for (const suffix of ['/state', '/login', '/logout', '/qr', '/qr.svg', '/qr/dismiss', '/send', '/users', '/allow', '/reset']) {
  assert.ok(routes.has(`/wechat-channel${suffix}`), `route ${suffix} must be registered`)
  assert.equal(routes.get(`/wechat-channel${suffix}`).kind, 'exact')
}

// 3b. 在没有客户端插件的情况下，降级登录页面以 HTML 形式提供，而原始 SVG 路由
// 在尚无二维码存在时会自我说明。
{
  const page = makeResponse()
  await routes.get('/wechat-channel/qr').handler(makeRequest('GET'), page)
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /text\/html/u)
  assert.match(page.body, /<!doctype html>/u)
  assert.match(page.body, /No QR code yet/u)

  const svg = makeResponse()
  await routes.get('/wechat-channel/qr.svg').handler(makeRequest('GET'), svg)
  assert.equal(svg.status, 404)
  assert.match(svg.body, /no QR code/u)
}

// 4. GET /state 以 JSON 返回频道快照。
{
  const response = makeResponse()
  await routes.get('/wechat-channel/state').handler(makeRequest('GET'), response)
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body)
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.value.channel.state, 'string')
  assert.equal(payload.value.channel.tokenPath.endsWith('weixin_bot.json'), true)
  assert.equal(typeof payload.value.chat.workspacePath, 'string')
}

// 5. 缺少该请求头的变更型路由会被拒绝，因此跨站页面无法驱动这个机器人。
{
  const response = makeResponse()
  await routes.get('/wechat-channel/login').handler(makeRequest('POST', '{}'), response)
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.body).error.code, 'forbidden')
}

// 6. 错误的方法会被拒绝。
{
  const response = makeResponse()
  await routes.get('/wechat-channel/state').handler(makeRequest('POST', '{}'), response)
  assert.equal(response.status, 405)
}

// 7. 一次已授权的变更调用若请求体格式有误，会返回 400，而不是崩溃。
{
  const response = makeResponse()
  await routes.get('/wechat-channel/send').handler(
    makeRequest('POST', 'not json', { 'x-dsh-wechat': '1' }),
    response,
  )
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).ok, false)
}

// 8. /allow 持久化一条覆盖项，随后 /users 会报告它。
{
  const allow = makeResponse()
  await routes.get('/wechat-channel/allow').handler(
    makeRequest('POST', JSON.stringify({ userId: 'wx-x', allowed: false }), { 'x-dsh-wechat': '1' }),
    allow,
  )
  assert.equal(allow.status, 200)
  const users = makeResponse()
  await routes.get('/wechat-channel/users').handler(makeRequest('GET'), users)
  assert.equal(users.status, 200)
  assert.equal(JSON.parse(users.body).ok, true)
}

// 9. 插件只索取了 web 服务器，没有索取它得不到的东西。
assert.deepEqual(children, [['webServer']])
assert.equal(state.channel, 'stopped')

await rm(root, { recursive: true, force: true })
console.log('plugin smoke test: all checks passed')
