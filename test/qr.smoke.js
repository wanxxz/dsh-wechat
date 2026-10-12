/**
 * Host QR 渲染测试：编码真实的登录载荷形状，并检查降级页面所提供的标记。
 *
 * 运行：`node test/qr.smoke.js`。
 */
import assert from 'node:assert/strict'

import { qrPage, qrSvg } from '../lib/qr.js'

const payload = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=27d22d9174a85633bc5e611e1f15ab79&bot_type=3'

const svg = await qrSvg(payload, { size: 260 })
const viewBox = /viewBox="0 0 (\d+) (\d+)"/u.exec(svg)
assert.ok(viewBox !== null, 'the SVG must declare a viewBox')
const span = Number(viewBox[1])
assert.equal(span, Number(viewBox[2]), 'the QR must be square')
// 模块数 + 2 * 4 个模块的静默区
const modules = span - 8
assert.ok(modules >= 21 && modules <= 57, `module count out of range: ${modules}`)
assert.equal(modules % 4, 1, 'a QR side is 4n+1 modules')

const segments = svg.match(/M\d+ \d+h1v1h-1z/gu) ?? []
assert.ok(segments.length > 200, `expected a dense matrix, got ${segments.length} dark modules`)
assert.ok(svg.includes('fill="#ffffff"'), 'the quiet zone must stay white for scanners')
assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'the SVG must be standalone')

// 相同载荷，相同矩阵：编码器不得依赖时间或随机性。
assert.equal(await qrSvg(payload, { size: 260 }), svg)

// 非 ASCII 载荷绝不能抛异常（UTF-8 字节编码器分支）。
const cjk = await qrSvg('微信机器人绑定：测试', { size: 200 })
assert.ok(cjk.includes('<path d="M'), 'a CJK payload must still encode')

// 降级页面内嵌二维码，并在扫描待处理期间自行刷新。
const page = qrPage({ svg, status: 'wait', account: null, prefix: '/wechat-channel', error: null })
assert.ok(page.startsWith('<!doctype html>'), 'the page must be a full document')
assert.ok(page.includes('<svg'), 'the page must embed the code')
assert.ok(page.includes('http-equiv="refresh" content="3"'), 'the page must refresh itself')
assert.ok(page.includes('/wechat-channel/qr.svg'), 'the page must link the raw SVG route')
assert.ok(!page.includes('Signed in as'), 'an anonymous page must not claim an account')

// 没有二维码时页面会说明该怎么做；出错时则展示错误。
const empty = qrPage({ svg: null, status: 'idle', account: null, prefix: '/wechat-channel', error: null })
assert.ok(empty.includes('No QR code yet'), 'an idle page must tell the user what to press')
const failed = qrPage({ svg: null, status: 'error', account: null, prefix: '/wechat-channel', error: 'login failed: <boom>' })
assert.ok(failed.includes('&lt;boom&gt;'), 'the error must be escaped')
assert.ok(!failed.includes('<boom>'), 'raw markup must never reach the page')

// 已登录的页面会给出账号名。
const online = qrPage({ svg: null, status: 'online', account: 'wx-abcdef123456', prefix: '/wechat-channel', error: null })
assert.ok(online.includes('wx-abcdef123456'), 'the signed-in page must name the account')

console.log('qr test: all checks passed')
