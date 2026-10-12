/**
 * Host 半边冒烟测试：针对伪造的 Harness 上下文驱动 `WeChatChats`。
 *
 * 它覆盖那些只在真实应用中运行时才会失败的环节：Session 的创建与恢复、把
 * 入站消息映射到它的轮次、从 `assistant/message` 中读取答案、命令、允许名单
 * 以及状态文件。运行：`node test/host.smoke.js`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { WeChatChats } from '../lib/chat.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-wechat-smoke-'))
const statePath = path.join(root, 'state.json')
const workspacePath = path.join(root, 'workspace')

/** 收集到的监听器与服务调用，供断言检查。 */
const calls = { create: [], resume: [], mount: [], rename: [], permission: [], followups: [], compact: [] }
const listeners = new Map()

function makeCtx() {
  const agents = new Map()
  const registry = {
    async create(options) {
      const agent = {
        id: options.sessionId,
        session: { id: options.sessionId },
        status: 'idle',
        followup(message) {
          calls.followups.push({ sessionId: options.sessionId, message })
        },
      }
      await options.setup?.({}, agent)
      const handle = { agent, dispose: async () => {} }
      agents.set(options.sessionId, agent)
      calls.create.push(options.sessionId)
      return handle
    },
    async resume(options) {
      calls.resume.push(options.resumeSessionId)
      throw new Error('no persisted session in this test')
    },
    get: (id) => agents.get(id),
  }
  /**
   * 真实的 Session 存储会拒绝它并不持有的 Session。在这里伪造这一点，才能让
   * “在发布之后给 Session 打标签，而绝不在建立过程中打”变得可观测，而不是
   * 一个静默的顺序 bug。
   * @param {object} session - 交给某个服务的 Session。
   */
  const requireLive = (session) => {
    if (agents.get(session?.id) === undefined) throw new Error(`session "${session?.id}" is not live in this store`)
  }
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    agents: registry,
    workspaceRegistry: { create: async (target) => ({ path: target, attachSession: async () => {} }) },
    get: (name) =>
      ({
        agents: registry,
        agentPresets: {
          resolve: async (id) => ({ id: id ?? 'standard' }),
          mount: async (_agentCtx, id) => calls.mount.push(id),
        },
        permissionPresets: {
          resolve: (id) => id,
          set: (session, id) => {
            requireLive(session)
            calls.permission.push(id)
          },
        },
        sessionTitle: {
          rename: (session, title) => {
            requireLive(session)
            calls.rename.push(title)
          },
        },
        agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
        commands: {
          async execute(agent, line) {
            calls.compact.push({ sessionId: agent?.session?.id, line })
            return { commandId: 'cmd-1', result: { kind: 'success', text: '已压缩上下文（模拟）' } }
          },
        },
      })[name],
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
    effect(factory) {
      const dispose = factory()
      return () => dispose?.()
    },
    inject: (_names, callback) => callback({ webServer: undefined }),
  }
}

const ctx = makeCtx()

const replies = []
const channel = {
  snapshot: () => ({ state: 'online', allowedUserIds: [], inboundCount: 0, outboundCount: 0 }),
  replyTo: async (_message, text) => replies.push(text),
  sendText: async (_userId, text) => replies.push(text),
  showTyping: async () => {},
}

const chats = new WeChatChats({
  ctx,
  config: {
    autoReply: true,
    allowedUserIds: [],
    permissionPreset: 'workspace-write',
    agentPreset: '',
    model: null,
    turnTimeoutMs: 5000,
    approvalFallback: 'reject',
    defaultLanguage: 'en',
  },
  channel,
  statePath,
  defaultWorkspacePath: workspacePath,
  logger: ctx.logger,
})

await chats.start()

const inbound = (text, userId = 'wx-user-1', type = 'text') => ({
  userId,
  text,
  type,
  contextToken: 'ctx-token',
  timestamp: new Date(),
})

/**
 * 轮询某个条件，而不是固定睡一段时间：Session 创建会访问文件系统，因此在
 * 负载下固定延时是不稳定的。
 * @param {() => boolean} check - 等待的条件。
 * @param {string} label - 超时报错中使用的描述。
 * @param {number} [timeoutMs] - 等待的上限。
 */
async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** 为最后一次 followup 发出完整的一轮，就像 agent 循环所做的那样。 */
function completeTurn(answer, reason = { kind: 'completed' }, sessionId) {
  const followup = calls.followups.at(-1)
  assert.ok(followup, 'an agent.followup() call is required before completing a turn')
  const target = sessionId ?? followup.sessionId
  const event = listeners.get('session/event')
  assert.ok(event, 'the bridge must listen on session/event')
  const claimed = listeners.get('agent/inbox/claimed')
  assert.ok(claimed, 'the bridge must listen on agent/inbox/claimed')
  claimed({ agent: { session: { id: target } }, message: followup.message, turn: 1 })
  event({ id: target }, { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } })
  event(
    { id: target },
    {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: answer }] },
        stream: [],
      },
    },
  )
  event({ id: target }, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason } })
}

// 1. 一条普通提示会创建 Session、跑完一轮，并回复它的文本。
{
  const pending = chats.handleInbound(inbound('你好，帮我看看今天有什么新闻'))
  await waitFor(() => calls.followups.length === 1, 'the first followup')
  assert.equal(calls.create.length, 1, 'the first message must create exactly one Session')
  assert.match(calls.create[0], /^wechat-/u)
  assert.deepEqual(calls.mount, ['standard'], 'setup must mount the resolved agent preset')
  assert.deepEqual(calls.rename, ['WeChat · wx-user-1'])
  completeTurn('今天没有新闻。')
  await pending
  assert.equal(replies.at(-1), '今天没有新闻。')
}

// 2. 下一条消息复用存活的 agent，而不是创建 Session。
{
  const before = calls.create.length
  const pending = chats.handleInbound(inbound('那明天呢'))
  await waitFor(() => calls.followups.length === 2, 'the second followup')
  assert.equal(calls.create.length, before, 'a second message must reuse the live agent')
  completeTurn('明天也没有。')
  await pending
  assert.equal(replies.at(-1), '明天也没有。')
}

// 3. 异常结束的一轮仍会作答，并附带原因后缀。
{
  const pending = chats.handleInbound(inbound('跑一个很长的任务'))
  await waitFor(() => calls.followups.length === 3, 'the third followup')
  completeTurn('', { kind: 'error', error: { message: 'provider exploded' } })
  await pending
  assert.match(replies.at(-1), /provider exploded/u)
}

// 4. 命令会在不唤醒 agent 的情况下作答，语言使用发送者被记住的语言——该用户
//    已经写过中文——而从未写过任何内容的用户则得到部署默认值。
{
  const beforeFollowups = calls.followups.length
  await chats.handleInbound(inbound('/whoami'))
  assert.match(replies.at(-1), /wx-user-1/u)
  assert.match(replies.at(-1), /你的微信用户 ID/u, 'a Chinese-speaking user is answered in Chinese')
  assert.equal(chats.users().find((row) => row.userId === 'wx-user-1').lang, 'zh')
  await chats.handleInbound(inbound('/help'))
  assert.match(replies.at(-1), /\/new/u)
  await chats.handleInbound(inbound('/status'))
  assert.match(replies.at(-1), /wechat-/u)
  await chats.handleInbound(inbound('/whoami', 'wx-fresh'))
  assert.match(replies.at(-1), /Your WeChat user id/u, 'an unheard-from user gets the deployment default')
  assert.equal(calls.followups.length, beforeFollowups, 'commands must not open turns')
}

// 4b. 图片或文件会被应答，而不是被静默丢弃。
{
  const before = calls.followups.length
  await chats.handleInbound(inbound('', 'wx-user-1', 'image'))
  assert.match(replies.at(-1), /只支持文字消息/u, 'a non-text message must be acknowledged')
  assert.equal(calls.followups.length, before, 'a non-text message must not open a turn')
}

// 4c. /compact 运行 Session 自身的命令，而不是一个编造出来的提示。
{
  await chats.handleInbound(inbound('/compact'))
  assert.equal(calls.compact.length, 1, '/compact must reach the command service')
  assert.equal(calls.compact[0].line, '/compact')
  assert.equal(calls.compact[0].sessionId, calls.create.at(-1), 'the command must run on the sender Session')
  assert.match(replies.at(-1), /已压缩上下文（模拟）/u)
}

// 5. /new 会遗忘该 Session，因此下一条提示会创建一个全新的。
{
  const before = calls.create.length
  const followupsBefore = calls.followups.length
  await chats.handleInbound(inbound('/new'))
  assert.match(replies.at(-1), /新会话|fresh Session/u)
  const pending = chats.handleInbound(inbound('新会话第一句'))
  await waitFor(() => calls.followups.length === followupsBefore + 1, 'the followup after /new')
  assert.equal(
    calls.create.length,
    before + 1,
    `/new must force a new Session (creates=${JSON.stringify(calls.create)}, replies=${JSON.stringify(replies.slice(-3))})`,
  )
  completeTurn('好。')
  await pending
}

// 6. 禁止某个用户会阻止 agent 被唤醒。
{
  await chats.setAllowed('wx-blocked', false)
  const beforeFollowups = calls.followups.length
  await chats.handleInbound(inbound('放我进去', 'wx-blocked'))
  assert.match(replies.at(-1), /allowlist|允许名单/u)
  assert.equal(calls.followups.length, beforeFollowups)
  assert.equal(chats.isAllowed('wx-blocked'), false)
  assert.equal(chats.isAllowed('wx-user-1'), true)
}

// 7. 已知用户表与状态文件保持一致。
{
  const users = chats.users()
  const row = users.find((entry) => entry.userId === 'wx-user-1')
  assert.ok(row, 'the sender must appear in the user table')
  assert.ok(row.messages >= 6, `expected at least 6 messages, got ${row.messages}`)
  assert.equal(row.sessionId, calls.create.at(-1))
  assert.equal(row.allowed, true)
  const stored = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(stored.sessions['wx-user-1'].sessionId, row.sessionId)
  assert.equal(stored.allowOverrides['wx-blocked'], false)
}

// 8. agent 工具从调用方的 Session 解析出它的默认接收者。
{
  assert.equal(chats.ownerOfSession(calls.create.at(-1)), 'wx-user-1')
  assert.equal(chats.ownerOfSession('someone-else'), undefined)
}

// 9. 审批降级策略会直接拒绝，而不是把一轮微信对话挂住。
{
  const handler = listeners.get('approval/request')
  assert.equal(typeof handler, 'function', 'approvalFallback=reject must install a listener')
  let nextCalled = false
  const outcome = await handler({ agent: { session: { id: calls.create.at(-1) } }, toolName: 'pwsh' }, async () => {
    nextCalled = true
    return 'unavailable'
  })
  assert.equal(outcome, 'rejected')
  assert.equal(nextCalled, false)
  const foreign = await handler({ agent: { session: { id: 'other-session' } }, toolName: 'pwsh' }, async () => 'unavailable')
  assert.equal(foreign, 'unavailable', 'other Sessions keep the default policy')
}

await chats.dispose()
await rm(root, { recursive: true, force: true })

console.log('host smoke test: all checks passed')
