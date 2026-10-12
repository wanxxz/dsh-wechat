/**
 * 微信频道的持久化记录。
 *
 * 这里的一切都是微信侧所告知信息的*派生缓存*：哪个微信用户映射到哪个 Harness
 * 会话，以及我们最后一次收到其消息的时间。会话日志始终是对话内容的事实来源，
 * 因此状态文件丢失或损坏只会让每个用户重新开一个会话，绝不会丢失历史记录。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 当前磁盘上的数据结构。只有在 `normalizeState` 中配套迁移时才递增。 */
export const STATE_VERSION = 1

/** 首次运行时的空状态。 */
export function emptyState() {
  return { version: STATE_VERSION, sessions: {}, users: {} }
}

/**
 * 把从磁盘读到的任何内容强制转换为当前结构。
 * 未知或格式错误的条目会被丢弃，而不是让整个频道失败。
 * @param {unknown} raw - 从状态文件解析出的 JSON。
 * @returns {{version: number, sessions: Record<string, object>, users: Record<string, object>}}
 */
export function normalizeState(raw) {
  const state = emptyState()
  if (raw === null || typeof raw !== 'object') return state
  const sessions = raw.sessions
  if (sessions !== null && typeof sessions === 'object' && !Array.isArray(sessions)) {
    for (const [userId, entry] of Object.entries(sessions)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) continue
      state.sessions[userId] = {
        sessionId: entry.sessionId,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        lastAt: typeof entry.lastAt === 'string' ? entry.lastAt : new Date().toISOString(),
        turns: Number.isSafeInteger(entry.turns) && entry.turns >= 0 ? entry.turns : 0,
      }
    }
  }
  const users = raw.users
  if (users !== null && typeof users === 'object' && !Array.isArray(users)) {
    for (const [userId, entry] of Object.entries(users)) {
      if (entry === null || typeof entry !== 'object') continue
      state.users[userId] = {
        firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : new Date().toISOString(),
        lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : new Date().toISOString(),
        messages: Number.isSafeInteger(entry.messages) && entry.messages >= 0 ? entry.messages : 0,
      }
    }
  }
  return state
}

/**
 * 加载或创建频道状态文件。
 *
 * 文件缺失、JSON 无效或路径不可读，都会得到一份全新的状态：
 * 即使文件被手工改成了乱码，频道也必须能启动。
 * @param {string} filePath - 状态文件的绝对路径。
 * @param {{ warn?: (message: string) => void }} [hooks] - 诊断信息输出目标。
 * @returns {Promise<object>} 规范化后的状态。
 */
export async function loadState(filePath, hooks = {}) {
  try {
    const text = await readFile(filePath, 'utf8')
    return normalizeState(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') hooks.warn?.(`wechat: state file unusable (${error?.message ?? error}); starting empty`)
    return emptyState()
  }
}

/**
 * 以原子方式写入状态文件（临时文件 + rename），且仅授予所有者访问权限。
 * @param {string} filePath - 状态文件的绝对路径。
 * @param {object} state - 要持久化的状态。
 */
export async function saveState(filePath, state) {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${filePath}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, filePath)
}

/**
 * 串行化各写入方，使两条入站消息不会交错执行读-改-写。
 * @returns {(task: () => Promise<unknown>) => Promise<unknown>} 队列执行函数。
 */
export function createWriteQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
