/**
 * 通过内联内嵌（vendored）的二维码编码器，从 `src/client.js` 构建 `client.js`。
 *
 * Harness 浏览器模块加载器只给客户端插件一个文件（`exports["./client"]`），
 * 并且它只能 `require` Host 浏览器模块表中的模块。因此二维码编码器是内嵌
 * （vendored）的，而不是通过 import 引入，而这个构建步骤就是把它放进发布文件的
 * 环节。
 *
 * 用法：node build.js
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const vendorPath = path.join(root, 'vendor', 'qrcode-generator.js')
const sourcePath = path.join(root, 'src', 'client.js')
const outputPath = path.join(root, 'client.js')
const marker = '/*__QRCODE_GENERATOR__*/ null'

const vendor = await readFile(vendorPath, 'utf8')
// vendor 文件是一个 UMD 打包产物。在这个包装内部它会走
// `typeof exports === 'object'` 分支，因此最终由 `module.exports` 持有编码器
// 函数，包装体将其返回——同时不会把 vendor 顶层的 `qrcode` 绑定泄漏到插件模块
// 中。
const wrapped = [
  '(function () {',
  '  const module = { exports: {} }',
  '  const exports = module.exports',
  vendor.replace(/^/gm, '  '),
  '  return module.exports',
  '})()',
].join('\n')

const source = await readFile(sourcePath, 'utf8')
if (!source.includes(marker)) throw new Error(`src/client.js no longer contains the ${marker} marker`)
// 这里用的是替换函数而非字符串：vendor 源码中包含 `$'` 和 `$&` 序列，
// 若用字符串替换，它们会被展开为匹配引用。
const built = source.replace(marker, () => wrapped)
await writeFile(outputPath, built)
console.log(`built ${path.relative(root, outputPath)} (${built.length} bytes)`)
