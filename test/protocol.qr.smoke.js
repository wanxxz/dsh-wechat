/**
 * 针对参考实现未覆盖的平台 QR 状态的登录流程测试：一次被重定向到另一台主机的
 * 待处理登录（`scaned_but_redirect`）、一个已绑定的机器人（`binded_redirect`）、
 * 一个不得让登录失败的状态，以及一个必须回退到登录基址的空 `baseurl`。
 *
 * 两个本地 HTTP 服务器充当 iLink 端点。无需网络访问。
 *
 * 运行：`node test/protocol.qr.smoke.js`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { loginFlow } from '../lib/wechat-protocol.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-qr-'))
const tokenPath = path.join(root, 'credentials.json')

/** 提供一个脚本化的 QR 状态序列。 */
function startServer(script) {
  const state = { polls: 0, requests: [] }
  const server = http.createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`)
    if (request.url.startsWith('/ilink/bot/get_bot_qrcode')) {
      const body = JSON.stringify({ qrcode: 'ticket-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/test?qrcode=ticket-1' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (request.url.startsWith('/ilink/bot/get_qrcode_status')) {
      const next = script[Math.min(state.polls, script.length - 1)]
      state.polls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(next))
      return
    }
    response.writeHead(404)
    response.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: `http://127.0.0.1:${server.address().port}` }))
  })
}

const statuses = []
const credentialsSeen = []

// 1. 在另一台主机上被扫码的登录会在那里完成，而空的 `baseurl` 会回退到登录
//    基址，而不是产生一个空 URL。
{
  const confirm = {
    status: 'confirmed',
    bot_token: 'bot-token-abc',
    ilink_bot_id: 'bot-42',
    ilink_user_id: 'user-7',
    baseurl: '',
  }
  const second = await startServer([confirm])
  const first = await startServer([
    { status: 'wait' },
    { status: 'scaned' },
    { status: 'need_verifycode' }, // 参考枚举中不存在：绝不能抛异常
    { status: 'scaned_but_redirect', redirect_host: second.origin },
  ])

  const credentials = await loginFlow({
    baseUrl: first.origin,
    tokenPath,
    pollIntervalMs: 5,
    onQr: (content) => statuses.push(`qr:${content.slice(0, 24)}`),
    onStatus: (status) => statuses.push(status),
  })
  credentialsSeen.push(credentials)

  assert.equal(credentials.token, 'bot-token-abc')
  assert.equal(credentials.accountId, 'bot-42')
  assert.equal(credentials.userId, 'user-7')
  assert.equal(credentials.baseUrl, first.origin, 'an empty baseurl must fall back to the login base')
  assert.equal(second.state.polls >= 1, true, 'polling must continue on the redirect host')
  assert.equal(String(first.origin).length > 0, true)
  const stored = JSON.parse(await readFile(tokenPath, 'utf8'))
  assert.equal(stored.token, 'bot-token-abc')
  assert.equal(stored.baseUrl, first.origin)
  assert.deepEqual(
    statuses.filter((entry) => !entry.startsWith('qr:')),
    ['wait', 'scaned', 'need_verifycode', 'scaned_but_redirect', 'confirmed'],
    'every status reaches onStatus, including the ones the reference enum rejected',
  )

  first.server.close()
  second.server.close()
}

// 2. 带凭据的 `binded_redirect` 是一次已完成的登录。
{
  const third = await startServer([
    { status: 'binded_redirect', bot_token: 'bot-token-bound', ilink_bot_id: 'bot-99', ilink_user_id: 'user-99', baseurl: 'http://example.invalid' },
  ])
  const credentials = await loginFlow({ baseUrl: third.origin, tokenPath, pollIntervalMs: 5, force: true })
  assert.equal(credentials.token, 'bot-token-bound')
  assert.equal(credentials.baseUrl, 'http://example.invalid', 'an explicit baseurl is kept')
  third.server.close()
}

// 3. 过期的二维码会重新签发而不是失败，并且第二次扫码胜出。
{
  const fourth = await startServer([
    { status: 'expired' },
    { status: 'wait' },
    { status: 'confirmed', bot_token: 'bot-token-2', ilink_bot_id: 'bot-1', ilink_user_id: 'user-1' },
  ])
  const seen = []
  const credentials = await loginFlow({
    baseUrl: fourth.origin,
    tokenPath,
    pollIntervalMs: 5,
    force: true,
    onStatus: (status) => seen.push(status),
  })
  assert.equal(credentials.token, 'bot-token-2')
  assert.ok(seen.includes('expired'), 'the expiry must be reported')
  assert.ok(seen.includes('wait'), 'a fresh code must report wait again')
  assert.equal(fourth.state.polls >= 3, true)
  fourth.server.close()
}

await rm(root, { recursive: true, force: true })
console.log(`protocol QR test: all checks passed (${credentialsSeen.length + 2} scenarios)`)
