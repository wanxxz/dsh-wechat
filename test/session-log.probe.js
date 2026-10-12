/**
 * 读取一份持久化的 Session 日志，并汇总一轮真实对话。
 *
 * 存储保留的是 `session.v4.jsonl.zstd`，因此这里用 Node 内置的 zstd 支持解压它，
 * 并且只报告消息事件：足以证明入站的微信文本到达了日志，且 agent 作出了回答。
 *
 * 用法：node test/session-log.probe.js <path-to-session.v4.jsonl.zstd> [text-limit]
 */
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

const [file, limitArg] = process.argv.slice(2)
if (file === undefined) {
  console.error('usage: node test/session-log.probe.js <session.v4.jsonl.zstd> [text-limit]')
  process.exit(2)
}
const limit = Number(limitArg ?? 400)

const raw = zstdDecompressSync(await readFile(file))
const lines = raw.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
console.log(`events: ${lines.length}`)

const counts = new Map()
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  const event = record.event ?? record
  const type = event?.type ?? 'unknown'
  counts.set(type, (counts.get(type) ?? 0) + 1)

  if (type === 'user/message') {
    const data = event.data ?? {}
    const text = (data.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
    console.log(`\n[user/message]  source.kind=${data.source?.kind ?? '?'}  chars=${text.length}`)
    console.log(`  text: ${JSON.stringify(text.slice(0, limit))}`)
  }
  if (type === 'assistant/message') {
    const content = event.data?.message?.content ?? []
    const text = content
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
    const tools = content.filter((block) => block?.type === 'tool-call').map((block) => block.name)
    console.log(`\n[assistant/message]  turn=${event.data?.turn} step=${event.data?.step}  chars=${text.length}  tools=${tools.join(',') || 'none'}`)
    console.log(`  text: ${JSON.stringify(text.slice(0, limit))}`)
  }
  if (type === 'turn/end') {
    console.log(`\n[turn/end]  turn=${event.data?.turn}  reason=${JSON.stringify(event.data?.reason)}`)
  }
}

console.log('\nevent counts:')
for (const [type, count] of [...counts].sort((left, right) => right[1] - left[1])) {
  console.log(`  ${String(count).padStart(4)}  ${type}`)
}
