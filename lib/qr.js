/**
 * Host 侧的二维码渲染。
 *
 * 设置页在浏览器中自行绘制二维码，但 Host 也会提供一个带同一二维码的纯页面：
 * 它在客户端部分加载之前就能工作，适用于任何浏览器，也正是它让登录无需浏览器
 * 会话 cookie 即可验证。
 *
 * 编码器是内嵌（vendored）的 UMD 文件，在一个私有函数作用域中求值，因此它结尾的
 * `module.exports = factory()` 不会影响本模块自身的导出。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 缓存的编码器函数；vendor 文件每个进程只读取一次。 */
let encoderPromise = null

/**
 * 加载内嵌（vendored）的二维码编码器。
 * @returns {Promise<Function>} `qrcode(typeNumber, errorCorrectionLevel)`。
 */
async function loadEncoder() {
  if (encoderPromise === null) {
    encoderPromise = (async () => {
      const here = path.dirname(fileURLToPath(import.meta.url))
      const code = await readFile(path.join(here, '..', 'vendor', 'qrcode-generator.js'), 'utf8')
      const factory = new Function('module', 'exports', 'define', `${code}\nreturn module.exports`)
      const encoder = factory({ exports: {} }, {}, undefined)
      if (typeof encoder !== 'function') throw new Error('vendored qrcode-generator did not export an encoder')
      // 非 ASCII 载荷（微信 id、中文备注）需要 UTF-8 字节编码器；
      // 默认的是 Latin-1。
      if (encoder.stringToBytesFuncs?.['UTF-8'] !== undefined) encoder.stringToBytes = encoder.stringToBytesFuncs['UTF-8']
      return encoder
    })()
  }
  return encoderPromise
}

/**
 * 将一段载荷渲染为 SVG 二维码。
 * @param {string} text - 要编码的载荷。
 * @param {{ size?: number, margin?: number, level?: string, dark?: string }} [options] - 渲染选项。
 * @returns {Promise<string>} 一个独立的 SVG 文档。
 */
export async function qrSvg(text, options = {}) {
  const size = Number.isSafeInteger(options.size) ? options.size : 260
  const margin = Number.isSafeInteger(options.margin) ? options.margin : 4
  const level = typeof options.level === 'string' ? options.level : 'M'
  const dark = typeof options.dark === 'string' ? options.dark : '#000000'
  const encode = await loadEncoder()
  const code = encode(0, level)
  code.addData(text)
  code.make()
  const count = code.getModuleCount()
  const span = count + margin * 2
  const segments = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) segments.push(`M${col + margin} ${row + margin}h1v1h-1z`)
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="WeChat login QR code">`,
    `<rect width="${span}" height="${span}" fill="#ffffff"/>`,
    `<path d="${segments.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('')
}

/**
 * Host 在 `<prefix>/qr` 提供的独立页面。
 * @param {{ svg: string | null, status: string, account: string | null, prefix: string, error: string | null }} input - 页面信息。
 * @returns {string} 一个 HTML 文档。
 */
export function qrPage(input) {
  const body =
    input.svg === null
      ? `<p class="hint">${input.error === null ? 'No QR code yet — it appears here as soon as the platform issues one, and this page refreshes by itself. If nothing appears, check the channel log for a login error.' : escapeHtml(input.error)}</p>`
      : `${input.svg}<p class="hint">Open WeChat → Scan. Status: <b>${escapeHtml(input.status)}</b>. This page refreshes itself every 3 seconds.</p>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>WeChat channel login</title>
<style>
  :root { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7f9; color: #1b1d21 }
  .card { background: #fff; border: .5px solid #e3e5e8; border-radius: 16px; padding: 20px 22px; display: flex; flex-direction: column; align-items: center; gap: 12px; max-width: 420px }
  h1 { font-size: 15px; font-weight: 600; margin: 0 }
  .hint { margin: 0; color: #6b7280; font-size: 12px; text-align: center }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px }
  @media (prefers-color-scheme: dark) { body { background: #17181b; color: #e8eaed } .card { background: #202124; border-color: #303134 } .hint { color: #9aa0a6 } }
</style></head>
<body><div class="card">
  <h1>WeChat channel — QR login</h1>
  ${body}
  ${input.account === null ? '' : `<p class="hint">Signed in as <code>${escapeHtml(input.account)}</code></p>`}
  <p class="hint">Endpoint: <code>${escapeHtml(`${input.prefix}/state`)}</code> · code: <code>${escapeHtml(`${input.prefix}/qr.svg`)}</code></p>
</div></body></html>
`
}

/**
 * 转义用于 HTML 文本节点与属性值的文本。
 * @param {string} value - 原始文本。
 * @returns {string} 转义后的文本。
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}
