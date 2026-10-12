/**
 * 探测正在运行的 Harness 实例的微信频道 HTTP 接口面。
 *
 * 它检查 `/state` 的形态（计数加上用户行），以及 Host 渲染的降级登录页面和
 * 它的 SVG 是否存在。把它用于从 `_recon/selfcheck-home` 启动的一次性实例；
 * 针对桌面 profile 使用时，它还能说明较新的 Host 半边是否已经加载。
 *
 * 用法：node test/host-routes.probe.js [base-url]
 */
import assert from 'node:assert/strict'

const base = process.argv[2] ?? 'http://127.0.0.1:19387'

const stateResponse = await fetch(`${base}/wechat-channel/state`)
const state = await stateResponse.json()
assert.equal(stateResponse.status, 200, 'GET /state must answer 200')
assert.equal(state.ok, true, 'GET /state must answer the ok envelope')
const channel = state.value.channel
const chat = state.value.chat

console.log(`state          : ${channel.state}`)
console.log(`account        : ${channel.userId ?? '(none)'}`)
console.log(`qr             : ${channel.qr === null ? '(none)' : `${channel.qr.status}, ${channel.qr.content.length} chars`}`)
console.log(`token path     : ${channel.tokenPath}`)
console.log(`chat keys      : ${Object.keys(chat).join(', ')}`)
console.log(`counts         : users=${chat.userCount} sessions=${chat.sessionCount} active=${chat.activeAgents}`)
console.log(`user rows      : ${Array.isArray(chat.users) ? chat.users.length : 'NOT AN ARRAY (older Host half)'}`)

const svgResponse = await fetch(`${base}/wechat-channel/qr.svg`)
if (svgResponse.status === 404) {
  console.log('qr.svg         : 404 (no code in flight, or older Host half)')
} else {
  assert.equal(svgResponse.status, 200, 'GET /qr.svg must answer 200 when a code exists')
  assert.match(svgResponse.headers.get('content-type') ?? '', /image\/svg\+xml/u)
  const svg = await svgResponse.text()
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/u.exec(svg)
  assert.ok(viewBox !== null, 'the SVG must declare a viewBox')
  const side = Number(viewBox[1]) - 8
  assert.equal((side - 1) % 4, 0, `QR side must be 4n+1, got ${side}`)
  const dark = (svg.match(/h1v1h-1z/gu) ?? []).length
  assert.ok(dark > 200, `expected a dense matrix, got ${dark}`)
  console.log(`qr.svg         : 200, ${svg.length} bytes, side=${side}, dark=${dark}`)
}

const pageResponse = await fetch(`${base}/wechat-channel/qr`)
console.log(`qr page        : ${pageResponse.status} ${(pageResponse.headers.get('content-type') ?? '').split(';')[0]}`)
if (pageResponse.status === 200) {
  const html = await pageResponse.text()
  assert.match(html, /<!doctype html>/u)
  assert.match(html, /http-equiv="refresh"/u)
  console.log(`qr page embed  : svg=${html.includes('<svg')} autoRefresh=${html.includes('http-equiv="refresh"')}`)
  const status = /Status: <b>([^<]+)<\/b>/u.exec(html)
  if (status !== null) console.log(`qr page status : ${status[1]}`)
}

console.log('host routes probe: OK')
