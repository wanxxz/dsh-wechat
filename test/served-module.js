/**
 * 验证 Host 确实把这个插件的浏览器半边提供给某个页面。
 *
 * 它用 `dsh web` 启动令牌换取鉴权 cookie，读取索引，然后抓取索引中列出的每一个
 * 预加载 combo 脚本，并报告本插件的客户端模块是否在其中一个之内。这正是
 * “设置标签页应该能渲染”与“设置标签页已被投递”之间的差别。
 *
 * 用法：node test/served-module.js <base-url> <launch-token>
 */
import assert from 'node:assert/strict'

const [base, token] = process.argv.slice(2)
if (base === undefined || token === undefined) {
  console.error('usage: node test/served-module.js <base-url> <launch-token>')
  process.exit(2)
}

const first = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const setCookies = typeof first.headers.getSetCookie === 'function' ? first.headers.getSetCookie() : []
const cookie = setCookies
  .filter(Boolean)
  .map((entry) => entry.split(';')[0])
  .join('; ')
assert.ok(cookie.startsWith('dsh-auth-'), `the launch token must set the auth cookie (status ${first.status})`)
console.log(`auth cookie acquired (index status ${first.status})`)

const index = await (await fetch(`${base}/`, { headers: { cookie } })).text()
assert.ok(index.length > 1000, 'the index must be a real document')
const combos = [...index.matchAll(/href="(plugins\/[^"]+)"/gu)].map((match) => match[1].replaceAll('&amp;', '&'))
assert.ok(combos.length > 0, 'the index must preload at least one combo script')
assert.ok(
  index.includes('@wanxxz/dsh-wechat/client.js'),
  'this plugin must appear in the index preload graph',
)
console.log(`index names ${combos.length} combo script(s) and lists this plugin`)

let served = false
for (const combo of combos) {
  const response = await fetch(`${base}/${combo}`, { headers: { cookie } })
  const body = await response.text()
  const mine = body.includes('settings.plugins.tab') && body.includes('wechat-channel')
  console.log(`  ${response.status} ${body.length} bytes  mine=${mine}  ${combo.slice(0, 70)}…`)
  if (response.ok && mine) served = true
}
assert.ok(served, "the plugin's client module must be served inside a combo script")
console.log('served-module check: the browser graph carries this plugin')
