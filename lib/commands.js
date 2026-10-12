/**
 * 微信用户可以发给 bot 的斜杠命令。
 *
 * 对应 Cherry Studio 微信通道暴露的命令面
 * （`/new`、`/compact`、`/help`、`/whoami`），让在两者之间迁移的用户保持
 * 相同的肌肉记忆。命令只匹配第一个以空白分隔的 token，
 * 其他任何内容都视为普通提问。
 */

/** 通道自行应答、不唤醒 Agent 的全部命令。 */
export const COMMANDS = Object.freeze(['/new', '/compact', '/help', '/whoami', '/status'])

/**
 * 解析一条入站文本正文。
 * @param {string} text - 原始消息文本。
 * @returns {{kind: 'command', command: string, argument: string} | {kind: 'prompt', text: string}}
 */
export function parseInbound(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const match = /^(\/[A-Za-z]+)\s*([\s\S]*)$/.exec(trimmed)
  if (match !== null && COMMANDS.includes(match[1].toLowerCase())) {
    return { kind: 'command', command: match[1].toLowerCase(), argument: match[2].trim() }
  }
  return { kind: 'prompt', text: trimmed }
}

/**
 * `/help` 回复，按用户书写所用语言本地化。
 * @param {boolean} chinese - 是否用中文作答。
 * @param {{ prefix?: string, commands?: string[] }} [facts] - 要提及的部署信息。
 * @returns {string} 纯文本帮助正文。
 */
export function helpText(chinese, facts = {}) {
  const prefix = facts.prefix ?? ''
  const extra = Array.isArray(facts.commands) && facts.commands.length > 0 ? facts.commands.join(', ') : ''
  const lines = chinese
    ? [
        '微信 × DeepSeek Harness',
        '',
        '直接发消息就是提问，Harness 会在一个独立会话里处理并回复。',
        '',
        '/new     开一个新会话（丢弃当前上下文）',
        '/compact 压缩当前会话的上下文',
        '/status  显示当前会话状态',
        '/whoami  显示你的微信用户 ID（用于白名单）',
        '/help    显示这条说明',
      ]
    : [
        'WeChat × DeepSeek Harness',
        '',
        'Just send a message: Harness answers it in a dedicated Session.',
        '',
        '/new     Start a fresh Session (drops the current context)',
        '/compact Compact the current Session context',
        '/status  Show the current Session state',
        '/whoami  Show your WeChat user id (for the allowlist)',
        '/help    Show this text',
      ]
  if (extra !== '') lines.push('', extra)
  if (prefix !== '') lines.push('', prefix)
  return lines.join('\n')
}

/**
 * `/whoami` 回复：运维者必须加入 `allowedUserIds` 的那个确切值。
 * @param {string} userId - 发送者的微信用户 id。
 * @param {boolean} chinese - 是否用中文作答。
 * @returns {string} 纯文本回复正文。
 */
export function whoamiText(userId, chinese) {
  if (chinese) {
    return [
      '你的微信用户 ID：',
      '',
      userId,
      '',
      '把它填进 profile 的 cordis.patch.yml：',
      '- id: wechat',
      "  name: '@wanxxz/dsh-wechat'",
      '  config:',
      '    allowedUserIds:',
      `      - '${userId}'`,
    ].join('\n')
  }
  return [
    'Your WeChat user id:',
    '',
    userId,
    '',
    'Add it to the profile cordis.patch.yml:',
    '- id: wechat',
    "  name: '@wanxxz/dsh-wechat'",
    '  config:',
    '    allowedUserIds:',
    `      - '${userId}'`,
  ].join('\n')
}

/**
 * 检测一条消息使用的语言。
 *
 * 命令本身不带语言（`/whoami` 既不是中文也不是英文），
 * 所以通道记住每个用户实际写的内容，并用该语言应答裸命令。
 * @param {string} text - 消息文本。
 * @returns {'zh' | 'en' | undefined} 文本不含任何书写系统时为 undefined。
 */
export function detectLanguage(text) {
  const body = typeof text === 'string' ? text : ''
  const cjk = (body.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length
  const latin = (body.match(/[A-Za-z]/g) ?? []).length
  if (cjk === 0 && latin === 0) return undefined
  return cjk > 0 && cjk >= latin ? 'zh' : 'en'
}

/**
 * 根据用户发送的字符，推测是否用中文应答该用户。
 * @param {string} text - 用户的消息。
 * @returns {boolean} 文本以 CJK 为主时为 true。
 */
export function prefersChinese(text) {
  return detectLanguage(text) === 'zh'
}
