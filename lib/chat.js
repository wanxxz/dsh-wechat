/**
 * 频道的 Harness 侧：每个微信用户一个 Session、承载每条入站消息的轮次，
 * 以及从 Session 日志中读回的回复文本。
 *
 * Harness 没有“提问并返回答案”这类 API：`agent.followup()` 返回 void，
 * 因此本模块把入站消息映射到它开启的轮次，并以该轮次的 `turn/end` 结算。
 * 文本取自该轮次的 Session `assistant/message` 事件，这与
 * `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput` 遵循同一规则。
 *
 * 这里不导入任何 Harness 包：所有依赖都是通过 `ctx` 获取的服务，
 * 因此解析问题不会在导入阶段让插件崩溃。
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { detectLanguage, helpText, parseInbound, prefersChinese, whoamiText } from './commands.js'
import { createWriteQueue, loadState, saveState } from './store.js'

/** 本频道拥有的每个 Session 的前缀。 */
export const SESSION_ID_PREFIX = 'wechat-'

/** 单个轮次的默认时限，单位为毫秒。 */
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 拼接一条 assistant 消息各内容块中的文本。
 * 推理、工具调用、图片和文件会被跳过：只有 `text` 才是回答。
 * @param {Array<object>} content - assistant 消息的 `ContentBlock[]`。
 * @returns {string} 拼接后的文本，消息不含文本时为空串。
 */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * 拼接一次持久化的 assistant 结算所包含的流式文本。
 * 与 `@deepseek-ai/dsh-llm` 的 `joinAssistantStreamText` 行为一致。
 * @param {Array<object>} stream - `AssistantStreamRecord[]`。
 * @returns {string} 拼接后的流式文本。
 */
export function joinStreamText(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record?.type === 'text-chunks' && Array.isArray(record.texts)) parts.push(record.texts.join(''))
    else if (record?.type === 'chunk' && record.chunk?.type === 'text-delta') parts.push(String(record.chunk.text ?? ''))
  }
  return parts.join('')
}

/**
 * 构造入站微信文本所变成的用户消息。
 * 等价于 `@deepseek-ai/dsh-llm` 的 `createUserMessage`；在此实现，
 * 使插件无需为此导入 Harness。
 * @param {string} text - 消息正文。
 * @param {object} source - `source.kind` 以及需要一并持久化的其他信息。
 * @returns {object} 冻结的用户消息。
 */
export function wechatUserMessage(text, source) {
  return Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'wechat', ...source }),
  })
}

/** 某个 `turn/end` 原因对应的自然语言措辞。 */
function reasonText(reason, chinese) {
  const kind = reason?.kind ?? 'completed'
  switch (kind) {
    case 'completed':
      return ''
    case 'max-tokens':
      return chinese ? '（回答因达到长度上限被截断。）' : '(The answer hit the model token limit and was cut off.)'
    case 'aborted':
      return chinese ? '（本轮已中止。）' : '(This turn was aborted.)'
    case 'interrupted':
      return chinese ? '（本轮被中断。）' : '(This turn was interrupted.)'
    case 'blocked':
      return chinese ? '（本轮被阻止，可能需要审批或权限不足。）' : '(This turn was blocked — likely an approval or permission requirement.)'
    case 'forked':
      return chinese ? '（本轮被分叉。）' : '(This turn was forked.)'
    case 'error': {
      const message = reason?.error?.message ?? reason?.error?.code ?? 'unknown error'
      return chinese ? `（本轮出错：${message}）` : `(This turn failed: ${message})`
    }
    default:
      return chinese ? `（本轮结束：${kind}）` : `(Turn ended: ${kind})`
  }
}

/** 某种不含文本的入站消息类型对应的自然语言措辞。 */
function kindText(kind, chinese) {
  const labels = chinese
    ? { image: '图片', voice: '语音', file: '文件', video: '视频' }
    : { image: 'an image', voice: 'a voice message', file: 'a file', video: 'a video' }
  const label = labels[kind] ?? (chinese ? `暂不支持的${kind}` : `an unsupported ${kind}`)
  return chinese ? `目前只支持文字消息（收到的是${label}）。` : `Only text messages are supported so far (received ${label}).`
}

/**
 * 微信 ⇄ Session 桥接器。
 *
 * 负责维护按用户划分的 Session 映射、每个用户的串行队列、用于读取答案的
 * 待处理轮次表，以及设置页展示的用户/允许名单簿记。
 */
export class WeChatChats {
  /**
   * @param {object} options - 装配参数。
   * @param {object} options.ctx - 插件的 Cordis 上下文。
   * @param {object} options.config - 归一化后的插件配置。
   * @param {object} options.channel - 用于回复的 `WeChatChannel`。
   * @param {string} options.statePath - 状态文件的绝对路径。
   * @param {string} options.defaultWorkspacePath - 配置未指定工作区时使用的工作区。
   * @param {{debug: Function, info: Function, warn: Function, error: Function}} options.logger - 日志器。
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.channel = options.channel
    this.statePath = options.statePath
    this.defaultWorkspacePath = options.defaultWorkspacePath
    this.logger = options.logger
    this.state = null
    this.write = createWriteQueue()
    /** messageId → 待处理轮次。 */
    this.byMessage = new Map()
    /** sessionId → 待处理轮次。 */
    this.bySession = new Map()
    /** 微信 userId → 存活句柄及其预设作用域。 */
    this.agents = new Map()
    /** 微信 userId → 该用户串行队列的队尾。 */
    this.queues = new Map()
    this.disposers = []
  }

  /** 加载状态文件并注册 Harness 侧的监听器。 */
  async start() {
    this.state = await loadState(this.statePath, { warn: (message) => this.logger.warn(message) })
    this.disposers.push(this.#listen('agent/inbox/claimed', (payload) => this.#onClaimed(payload)))
    this.disposers.push(this.#listen('session/event', (session, event) => this.#onSessionEvent(session, event)))
    if (this.config.approvalFallback === 'reject') {
      this.disposers.push(this.#listen('approval/request', (request, next) => this.#onApproval(request, next)))
    }
  }

  /** 移除本桥接器注册的所有监听器。 */
  stop() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.logger.warn(`wechat: listener disposer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 通过 `ctx.on` 注册一个 Cordis 监听器并返回其注销函数。
   * @param {string} name - 事件名。
   * @param {Function} handler - 监听器。
   * @returns {Function} 注销函数。
   */
  #listen(name, handler) {
    const dispose = this.ctx.on(name, handler)
    return typeof dispose === 'function' ? dispose : () => {}
  }

  /** @returns {object} 设置页所需的计数。 */
  snapshot() {
    const sessions = this.state === null ? {} : this.state.sessions
    let active = 0
    for (const userId of Object.keys(sessions)) {
      if (this.agents.has(userId)) active += 1
    }
    return {
      userCount: this.state === null ? 0 : Object.keys(this.state.users).length,
      sessionCount: Object.keys(sessions).length,
      activeAgents: active,
      pendingTurns: this.byMessage.size,
      workspacePath: this.workspacePath(),
      statePath: this.statePath,
      allowedUserIds: [...this.config.allowedUserIds],
    }
  }

  /**
   * 设置页渲染的已知用户表。
   * @returns {Array<object>} 每个微信用户一行，最近的在前。
   */
  users() {
    if (this.state === null) return []
    return Object.entries(this.state.users)
      .map(([userId, entry]) => ({
        userId,
        messages: entry.messages ?? 0,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        sessionId: this.state.sessions[userId]?.sessionId ?? null,
        turns: this.state.sessions[userId]?.turns ?? 0,
        lang: entry.lang ?? null,
        allowed: this.isAllowed(userId),
        live: this.agents.has(userId),
      }))
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
  }

  /**
   * 该微信用户是否可以驱动 agent。
   *
   * 配置中的部署允许名单是基准；设置页保存的单用户覆盖优先级更高，
   * 因此运维无需修改 profile patch 即可封禁某个用户。
   * @param {string} userId - 微信用户 id。
   * @returns {boolean} 允许时返回 true。
   */
  isAllowed(userId) {
    const override = this.state?.allowOverrides?.[userId]
    if (override === true) return true
    if (override === false) return false
    if (this.config.allowedUserIds.length === 0) return true
    return this.config.allowedUserIds.includes(userId)
  }

  /**
   * 某个 Session 的归属微信用户（前提是本频道创建了它）。
   * @param {string | undefined} sessionId - 来自工具调用的 Session id。
   * @returns {string | undefined} 微信用户 id。
   */
  ownerOfSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || this.state === null) return undefined
    for (const [userId, entry] of Object.entries(this.state.sessions)) {
      if (entry?.sessionId === sessionId) return userId
    }
    return undefined
  }

  /**
   * 保存一条允许/封禁覆盖设置。
   * @param {string} userId - 微信用户 id。
   * @param {boolean} allowed - 该用户是否可以驱动 agent。
   */
  async setAllowed(userId, allowed) {
    await this.#mutate((state) => {
      state.allowOverrides = { ...(state.allowOverrides ?? {}), [userId]: allowed === true }
    })
  }

  /**
   * 忘掉某个用户的 Session，使下一条消息开启全新会话。
   * @param {string} userId - 微信用户 id。
   */
  async resetSession(userId) {
    await this.#releaseAgent(userId, { dispose: true })
    await this.#mutate((state) => {
      delete state.sessions[userId]
    })
  }

  /** 微信 Session 运行所在工作区的绝对路径。 */
  workspacePath() {
    if (this.config.workspacePath && this.config.workspacePath.length > 0) return this.config.workspacePath
    return this.defaultWorkspacePath
  }

  /**
   * 在写队列中读-改-写状态文件。
   * @param {(state: object) => void} mutate - 原地修改。
   */
  async #mutate(mutate) {
    await this.write(async () => {
      mutate(this.state)
      await saveState(this.statePath, this.state)
    })
  }

  /**
   * 处理一条入站微信消息。
   *
   * 命令在这里直接应答；其他内容会变成一个轮次，并按用户串行，
   * 因此两条消息绝不会争抢同一个 Session。
   * @param {object} message - 来自微信频道的入站消息。
   */
  async handleInbound(message) {
    const userId = message.userId
    if (this.state === null) return
    const parsed = parseInbound(message.text)
    // 裸命令本身不含语言信息：只有它的参数可能透露语言，
    // 否则由已记住的或部署默认的语言决定。
    const detected = parsed.kind === 'command' ? detectLanguage(parsed.argument) : detectLanguage(message.text)
    const chinese = (detected ?? this.state.users[userId]?.lang ?? this.config.defaultLanguage) !== 'en'

    await this.#mutate((state) => {
      const entry = state.users[userId] ?? { firstSeenAt: new Date().toISOString(), messages: 0 }
      entry.lastSeenAt = new Date().toISOString()
      entry.messages = (entry.messages ?? 0) + 1
      if (detected !== undefined) entry.lang = detected
      state.users[userId] = entry
    })

    if (!this.isAllowed(userId)) {
      this.logger.info(`wechat: dropped message from blocked user ${userId}`)
      await this.#reply(message, chinese ? '你不在允许名单里。' : 'You are not on the allowlist for this bot.')
      return
    }

    if (parsed.kind === 'command') {
      await this.#runCommand(userId, parsed, message, chinese)
      return
    }

    if (parsed.text.length === 0) {
      // 图片或文件会以无文本的带类型消息到达；回一句总比让发送者
      // 怀疑机器人是否还活着要好。
      if (message.type !== undefined && message.type !== 'text') {
        await this.#reply(message, kindText(message.type, chinese))
      }
      return
    }

    if (!this.config.autoReply) {
      await this.#reply(message, chinese ? '自动回复已关闭。' : 'Auto-reply is disabled.')
      return
    }

    await this.#enqueue(userId, async () => {
      await this.channel.showTyping(userId)
      try {
        const answer = await this.ask(userId, parsed.text, { form: 'wechat-message' })
        await this.#reply(message, answer)
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        this.logger.error(`wechat: turn for ${userId} failed: ${text}`)
        await this.#reply(message, chinese ? `处理失败：${text}` : `Failed: ${text}`)
      }
    })
  }

  /**
   * 应答一条命令且不唤醒 agent，`/compact` 除外。
   * @param {string} userId - 微信用户 id。
   * @param {{command: string, argument: string}} parsed - 解析后的命令。
   * @param {object} message - 入站消息。
   * @param {boolean} chinese - 应答语言。
   */
  async #runCommand(userId, parsed, message, chinese) {
    switch (parsed.command) {
      case '/help':
        await this.#reply(
          message,
          helpText(chinese, {
            prefix: chinese ? `工作区：${this.workspacePath()}` : `Workspace: ${this.workspacePath()}`,
          }),
        )
        return
      case '/whoami':
        await this.#reply(message, whoamiText(userId, chinese))
        return
      case '/status': {
        const entry = this.state.sessions[userId]
        const lines = chinese
          ? [
              '微信频道状态',
              '',
              `机器人：${this.channel.snapshot().state}`,
              `你的会话：${entry?.sessionId ?? '（尚未创建）'}`,
              `轮次：${entry?.turns ?? 0}`,
              `工作区：${this.workspacePath()}`,
            ]
          : [
              'WeChat channel status',
              '',
              `Bot: ${this.channel.snapshot().state}`,
              `Your Session: ${entry?.sessionId ?? '(not created yet)'}`,
              `Turns: ${entry?.turns ?? 0}`,
              `Workspace: ${this.workspacePath()}`,
            ]
        await this.#reply(message, lines.join('\n'))
        return
      }
      case '/new':
        await this.resetSession(userId)
        await this.#reply(message, chinese ? '已开新会话，请直接提问。' : 'Started a fresh Session. Ask away.')
        return
      case '/compact': {
        await this.#enqueue(userId, async () => {
          try {
            const text = await this.#compact(userId, chinese)
            await this.#reply(message, text)
          } catch (error) {
            await this.#reply(message, error instanceof Error ? error.message : String(error))
          }
        })
        return
      }
      default:
        await this.#reply(message, chinese ? `未知命令：${parsed.command}` : `Unknown command: ${parsed.command}`)
    }
  }

  /**
   * 运行 Session 自带的 `/compact` 命令。
   *
   * 压缩由 Harness 负责，因此频道通过 `ctx.commands.execute()` 调用已注册的
   * 命令，而不是自己另造一个提示词；未装配命令服务时，退化为用自然语言
   * 请求 agent。
   * @param {string} userId - 微信用户 id。
   * @param {boolean} chinese - 应答语言。
   * @returns {Promise<string>} 回复正文。
   */
  async #compact(userId, chinese) {
    const { agent } = await this.#ensureAgent(userId)
    const commands = this.ctx.get('commands')
    if (commands === undefined || typeof commands.execute !== 'function') {
      const answer = await this.ask(userId, chinese ? '请压缩当前上下文。' : 'Compact the current context.', {
        form: 'wechat-command',
      })
      return answer.length > 0 ? answer : chinese ? '已完成压缩。' : 'Compaction finished.'
    }

    const settled = await commands.execute(agent, '/compact', [], new AbortController().signal)
    if (settled === undefined) {
      return chinese ? '这个部署没有注册 /compact 命令。' : 'This deployment registers no /compact command.'
    }
    const result = settled.result ?? {}
    if (result.kind === 'error') {
      return chinese ? `压缩失败：${result.text ?? '未知错误'}` : `Compaction failed: ${result.text ?? 'unknown error'}`
    }
    const text = typeof result.text === 'string' && result.text.length > 0 ? result.text : undefined
    return text ?? (chinese ? '已完成压缩。' : 'Compaction finished.')
  }

  /**
   * 在同一用户此前所有任务之后运行一个任务。
   * @param {string} userId - 微信用户 id。
   * @param {() => Promise<void>} task - 排队的工作。
   * @returns {Promise<void>} 该任务运行完毕后 resolve。
   */
  async #enqueue(userId, task) {
    const previous = this.queues.get(userId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(userId, tail)
    try {
      await run
    } finally {
      if (this.queues.get(userId) === tail) this.queues.delete(userId)
    }
  }

  /**
   * 通过入站消息自身的上下文 token 回复。
   * @param {object} message - 入站消息。
   * @param {string} text - 回复正文。
   */
  async #reply(message, text) {
    try {
      await this.channel.replyTo(message, text)
    } catch (error) {
      this.logger.error(`wechat: reply failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 向某个用户主动发送消息（agent 工具的入口）。
   * @param {string} userId - 微信用户 id。
   * @param {string} text - 消息正文。
   */
  async sendToUser(userId, text) {
    await this.channel.sendText(userId, text)
  }

  /**
   * 向该用户的 Session 提问并返回其回答文本。
   * @param {string} userId - 微信用户 id。
   * @param {string} text - 提示词正文。
   * @param {object} [source] - 随消息一并持久化的额外 `source` 字段。
   * @returns {Promise<string>} 回答文本。
   */
  async ask(userId, text, source = {}) {
    const { agent } = await this.#ensureAgent(userId)
    const chinese = prefersChinese(text)
    const message = wechatUserMessage(text, { userId, ...source })
    const pending = this.#arm(message, agent.session.id)

    try {
      agent.followup(message)
    } catch (error) {
      this.#disarm(pending)
      throw error
    }

    await this.#mutate((state) => {
      const entry = state.sessions[userId]
      if (entry !== undefined) {
        entry.lastAt = new Date().toISOString()
        entry.turns = (entry.turns ?? 0) + 1
      }
    })

    const result = await pending.settled
    const suffix = reasonText(result.reason, chinese)
    if (result.text.length === 0) {
      return suffix.length > 0 ? suffix : chinese ? '（本轮没有产生文本回答。）' : '(The turn produced no text answer.)'
    }
    return suffix.length > 0 ? `${result.text}\n${suffix}` : result.text
  }

  /**
   * 为一条消息装上待处理轮次并返回其结算句柄。
   * @param {object} message - 即将被受理的用户消息。
   * @param {string} sessionId - 将要运行它的 Session。
   * @returns {object} 待处理记录，其 `settled` 会以答案为结果 resolve。
   */
  #arm(message, sessionId) {
    const timeoutMs = Number.isSafeInteger(this.config.turnTimeoutMs) && this.config.turnTimeoutMs > 0 ? this.config.turnTimeoutMs : DEFAULT_TURN_TIMEOUT_MS
    let settle
    const settled = new Promise((resolve) => {
      settle = resolve
    })
    const pending = {
      messageId: message.id,
      sessionId,
      turn: null,
      text: '',
      partial: [],
      settled,
      settle,
      timer: null,
    }
    pending.timer = setTimeout(() => {
      this.logger.warn(`wechat: turn did not end within ${timeoutMs} ms for session ${sessionId}`)
      this.#settle(pending, { kind: 'interrupted' })
    }, timeoutMs)
    pending.timer.unref?.()
    this.byMessage.set(message.id, pending)
    this.bySession.set(sessionId, pending)
    return pending
  }

  /**
   * 丢弃一个待处理轮次且不结算它。
   * @param {object} pending - 待处理记录。
   */
  #disarm(pending) {
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    this.byMessage.delete(pending.messageId)
    if (this.bySession.get(pending.sessionId) === pending) this.bySession.delete(pending.sessionId)
  }

  /**
   * 结算一个待处理轮次并发布其答案。
   * @param {object} pending - 待处理记录。
   * @param {object} reason - `turn/end` 原因。
   */
  #settle(pending, reason) {
    if (pending.done === true) return
    pending.done = true
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending.timer = null
    this.byMessage.delete(pending.messageId)
    if (this.bySession.get(pending.sessionId) === pending) this.bySession.delete(pending.sessionId)
    const streamed = pending.partial.join('').trim()
    pending.settle({ reason, text: pending.text.length > 0 ? pending.text : streamed })
  }

  /**
   * 把已受理的消息映射到它的轮次。
   * @param {{agent: object, message: object, turn: number}} payload - 事件负载。
   */
  #onClaimed(payload) {
    const pending = this.byMessage.get(payload?.message?.id)
    if (pending === undefined) return
    if (payload.agent?.session?.id !== pending.sessionId) return
    if (Number.isSafeInteger(payload.turn)) pending.turn = payload.turn
  }

  /**
   * 归拢待处理轮次的事件，并在 `turn/end` 时结算它。
   * @param {object} session - 事件所属的 Session。
   * @param {object} event - 会话事件。
   */
  #onSessionEvent(session, event) {
    const sessionId = session?.id ?? session?.header?.id
    const pending = this.bySession.get(sessionId)
    if (pending === undefined) return

    if (event.type === 'turn/start') {
      if (pending.turn === null && Number.isSafeInteger(event.data?.turn)) pending.turn = event.data.turn
      return
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      if (pending.turn === null || event.data?.turn !== pending.turn) return
      if (event.type === 'assistant/message') {
        const text = textOfContent(event.data?.message?.content)
        if (text.length > 0) pending.text = text
      }
      const streamed = joinStreamText(event.data?.stream)
      if (streamed.length > 0) pending.partial.push(streamed)
      return
    }
    if (event.type === 'turn/end') {
      if (pending.turn === null || event.data?.turn !== pending.turn) return
      this.#settle(pending, event.data?.reason)
    }
  }

  /**
   * 拒绝在微信 Session 内发起的审批请求。
   *
   * 微信对话没有审批界面，因此等待只会挂住整个轮次。
   * 对其他所有 Session 都返回 `next()`。
   * @param {object} request - 审批请求。
   * @param {Function} next - 下一个 waterfall 步骤。
   * @returns {Promise<string>} 审批结果。
   */
  async #onApproval(request, next) {
    const sessionId = request?.agent?.session?.id
    const pending = this.bySession.get(sessionId)
    const ours = pending !== undefined || String(sessionId ?? '').startsWith(SESSION_ID_PREFIX)
    if (!ours) return next()
    this.logger.warn(`wechat: refusing approval for ${request?.toolName ?? 'a tool'} in ${sessionId}`)
    if (pending !== undefined) {
      pending.notice = `approval:${request?.toolName ?? 'tool'}`
    }
    return 'rejected'
  }

  /**
   * 获取或创建某个微信用户的 Session agent。
   * @param {string} userId - 微信用户 id。
   * @returns {Promise<{agent: object, sessionId: string, created: boolean}>} 存活的 agent。
   */
  async #ensureAgent(userId) {
    const entry = this.state.sessions[userId]
    const existingId = entry?.sessionId

    if (typeof existingId === 'string' && existingId.length > 0) {
      const live = this.#liveAgent(existingId)
      if (live !== undefined) return { agent: live, sessionId: existingId, created: false }
    }

    const workspace = await this.#workspace()
    const presetId = await this.#presetId()
    const agentOptions = this.#agentOptions()

    if (typeof existingId === 'string' && existingId.length > 0) {
      try {
        const resumed = await this.ctx.agents.resume({
          resumeSessionId: existingId,
          agentOptions,
          setup: (agentCtx) => this.#mountAgentPreset(agentCtx, presetId),
        })
        await this.#tagSession(resumed.agent, userId)
        await workspace.attachSession(existingId)
        this.agents.set(userId, resumed)
        this.logger.info(`wechat: resumed Session ${existingId} for ${userId}`)
        return { agent: resumed.agent, sessionId: existingId, created: false }
      } catch (error) {
        this.logger.warn(`wechat: could not resume ${existingId} (${error instanceof Error ? error.message : String(error)}); starting a new Session`)
      }
    }

    const sessionId = `${SESSION_ID_PREFIX}${randomUUID()}`
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
      agentOptions,
      setup: (agentCtx) => this.#mountAgentPreset(agentCtx, presetId),
    })
    await this.#tagSession(handle.agent, userId)
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      this.logger.warn(`wechat: workspace attach failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.agents.set(userId, handle)
    await this.#mutate((state) => {
      state.sessions[userId] = {
        sessionId,
        createdAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
        turns: state.sessions[userId]?.turns ?? 0,
      }
    })
    this.logger.info(`wechat: created Session ${sessionId} for ${userId}`)
    return { agent: handle.agent, sessionId, created: true }
  }

  /**
   * 某个 Session id 对应的存活 agent，可能来自本频道或其他归属方。
   * @param {string} sessionId - 要查找的 Session id。
   * @returns {object | undefined} 存活的 agent。
   */
  #liveAgent(sessionId) {
    for (const handle of this.agents.values()) {
      if (handle?.agent?.session?.id === sessionId) return handle.agent
    }
    const registry = this.ctx.get('agents')
    if (registry === undefined || typeof registry.get !== 'function') return undefined
    try {
      return registry.get(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * 解析并创建微信 Session 运行所在的工作区。
   * @returns {Promise<object>} 工作区实体。
   */
  async #workspace() {
    const target = this.workspacePath()
    await mkdir(target, { recursive: true })
    return await this.ctx.workspaceRegistry.create(target, 'WeChat')
  }

  /**
   * 新 Session 挂载的 agent 预设 id，使用默认预设时为 `undefined`。
   * @returns {Promise<string | undefined>} 预设 id。
   */
  async #presetId() {
    const registry = this.ctx.get('agentPresets')
    if (registry === undefined) return undefined
    const requested = this.config.agentPreset && this.config.agentPreset.length > 0 ? this.config.agentPreset : undefined
    const preset = await registry.resolve(requested)
    return preset?.id
  }

  /**
   * 微信 Session 的模型选择：优先用显式配置，否则用部署当前默认值。
   * @returns {object} agent 选项。
   */
  #agentOptions() {
    const explicit = this.config.model
    if (explicit !== null && typeof explicit === 'object' && typeof explicit.provider === 'string' && typeof explicit.model === 'string') {
      return { provider: explicit.provider, model: explicit.model }
    }
    const defaults = this.ctx.get('agentDefaultModel')
    if (defaults === undefined || typeof defaults.currentSelection !== 'function') return {}
    const selection = defaults.currentSelection()
    return { provider: selection.provider, model: selection.model }
  }

  /**
   * 每个 agent 的初始化，在 agent 尚未发布时运行。
   *
   * 这里只应挂载预设：此时 Session 尚未在存储中生效，因此任何查找它的
   * 操作（`sessionTitle.rename`、`permissionPresets.set`）都会抛错。
   * 这些操作放在发布之后的 {@link #tagSession} 中执行，这也是随附
   * webhook 运行时采用的顺序。
   * @param {object} agentCtx - agent 自身的上下文。
   * @param {string | undefined} presetId - 要挂载的预设。
   */
  async #mountAgentPreset(agentCtx, presetId) {
    const presets = this.ctx.get('agentPresets')
    if (presets !== undefined) await presets.mount(agentCtx, presetId)
  }

  /**
   * 在 Session 生效后固定其权限预设与标题。
   * @param {object} agent - 已发布的 agent。
   * @param {string} userId - 拥有该 Session 的微信用户 id。
   */
  async #tagSession(agent, userId) {
    if (this.config.permissionPreset && this.config.permissionPreset.length > 0) {
      const permissions = this.ctx.get('permissionPresets')
      if (permissions !== undefined) {
        try {
          permissions.resolve(this.config.permissionPreset)
          permissions.set(agent.session, this.config.permissionPreset)
        } catch (error) {
          this.logger.warn(`wechat: permission preset "${this.config.permissionPreset}" not applied: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const titles = this.ctx.get('sessionTitle')
    if (titles !== undefined && typeof titles.rename === 'function') {
      try {
        titles.rename(agent.session, `WeChat · ${userId}`)
      } catch (error) {
        // 标题只是装饰：绝不为它让一次对话失败。
        this.logger.warn(`wechat: could not title the Session: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * 若本频道拥有某个用户的存活 agent，则销毁它。
   * @param {string} userId - 微信用户 id。
   * @param {{ dispose?: boolean }} [options] - `dispose` 为真时拆掉该 agent。
   */
  async #releaseAgent(userId, options = {}) {
    const handle = this.agents.get(userId)
    if (handle === undefined) return
    this.agents.delete(userId)
    if (options.dispose === true && typeof handle.dispose === 'function') {
      try {
        await handle.dispose()
      } catch (error) {
        this.logger.warn(`wechat: agent disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 销毁本频道创建的所有存活 agent。 */
  async dispose() {
    this.stop()
    for (const userId of [...this.agents.keys()]) await this.#releaseAgent(userId, { dispose: true })
  }

  /** 配置未指定时状态文件的绝对路径。 */
  static defaultStatePath(dshHome) {
    return path.join(dshHome, 'plugins', '@wanxxz', 'dsh-wechat', 'state.json')
  }
}
