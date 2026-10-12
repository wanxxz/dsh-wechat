/**
 * 微信频道设置页（浏览器侧）。
 *
 * 作为一个标签页注册到「设置 → 插件」区域。页面展示扫码登录、实时连接状态以及
 * 每个用户的会话映射，并通过 Host 侧注册的 `/wechat-channel` HTTP 路由与 Host
 * 侧通信。
 *
 * `client.js` 由 `build.js` 从本文件生成，构建过程会在 `__QRCODE_GENERATOR__`
 * 标记处内联内嵌（vendored）的 MIT 二维码编码器。请编辑本文件，然后运行
 * `node build.js`。
 */
window.__ModuleLoader__.load({
  id: '@wanxxz/dsh-wechat',
  factory(require) {
    const React = require('react')

    /** 内嵌（vendored）的二维码编码器（MIT，Kazuhiko Arase）——由构建步骤替换。 */
    const QRCODE = /*__QRCODE_GENERATOR__*/ null

    /** 本插件所拥有的语言区域命名空间。 */
    const NS = 'settings.wechat'

    /** Host 侧注册的路由前缀。 */
    const API = '/wechat-channel'

    const zh = {
      tab: '微信',
      title: '微信频道',
      subtitle: '通过微信官方 iLink Bot（微信 ClawBot）通道，把微信消息接到 Harness 会话。',
      stateIdle: '未启动',
      stateLogin: '等待扫码',
      stateOnline: '已连接',
      stateError: '出错',
      stateStopped: '已停止',
      account: '机器人账号',
      noAccount: '未登录',
      login: '扫码登录',
      relogin: '重新扫码登录',
      logout: '断开连接',
      logoutHint: '断开只停止接收消息，本地凭据保留。',
      qrTitle: '用手机微信扫码完成绑定',
      qrHint: '打开微信 → 扫一扫。扫码后此页面会自动更新。',
      qrWaiting: '等待二维码…',
      qrScan: '已扫码，请在手机上确认',
      qrExpired: '二维码已过期，正在重新获取',
      openQr: '在新标签页打开二维码（备用登录页）',
      staleHostTitle: '请先重启 DeepSeek Harness',
      staleHostBody:
        '当前运行的 Host 还是安装插件时的那一版代码，它建立会话的顺序有已知缺陷：扫码后每条消息都会以「session … is not live in this store」失败。请完全退出并重新打开应用，然后回到这个页面扫码；页面数据（凭据、会话映射）不会丢失。',
      staleHostButton: '已暂停扫码，重启后再试',
      error: '错误',
      refresh: '刷新',
      loading: '读取中…',
      unavailable: 'Host 未响应：插件可能尚未在本 profile 加载，或 Web 服务未运行。',
      errorTitle: '错误',
      lastInbound: '最后收到消息',
      lastOutbound: '最后发出消息',
      inboundCount: '收到',
      outboundCount: '发出',
      tokenPath: '凭据文件',
      allowlist: '允许的微信用户',
      allowlistEmpty: '未设置白名单：任何人都可以触发智能体。建议先用 /whoami 拿到 ID 再加入白名单。',
      users: '已知用户',
      noUsers: '还没有人给机器人发过消息。',
      userId: '用户 ID',
      session: '会话',
      messages: '消息数',
      lastSeen: '最后活跃',
      allowed: '允许',
      blocked: '已禁止',
      allow: '允许',
      block: '禁止',
      resetSession: '重置会话',
      resetHint: '重置后该用户的下一条消息会开启一个新会话。',
      send: '发送测试消息',
      sendHint: '以机器人身份给该用户主动推送一条消息（需要对方先发过消息）。',
      sendPlaceholder: '要发送的内容',
      sendAction: '发送',
      sent: '已发送',
      commands: '命令',
      commandsHint: '/new 新会话 · /compact 压缩上下文 · /status 状态 · /whoami 我的 ID · /help 帮助',
    }

    const en = {
      tab: 'WeChat',
      title: 'WeChat channel',
      subtitle: 'Bridge WeChat into Harness Sessions through the official WeChat iLink Bot (ClawBot) channel.',
      stateIdle: 'Not started',
      stateLogin: 'Waiting for scan',
      stateOnline: 'Connected',
      stateError: 'Error',
      stateStopped: 'Stopped',
      account: 'Bot account',
      noAccount: 'Not signed in',
      login: 'Sign in with QR',
      relogin: 'Sign in again',
      logout: 'Disconnect',
      logoutHint: 'Disconnecting only stops polling; credentials stay on disk.',
      qrTitle: 'Scan with WeChat on your phone',
      qrHint: 'Open WeChat → Scan. This page updates by itself once you confirm.',
      qrWaiting: 'Requesting a QR code…',
      qrScan: 'Scanned — confirm on your phone',
      qrExpired: 'QR code expired, requesting a new one',
      openQr: 'Open the QR in a new tab (fallback login page)',
      staleHostTitle: 'Restart DeepSeek Harness first',
      staleHostBody:
        'The running Host half is still the build from when the plugin was installed, and its Session setup order has a known defect: after you scan, every message fails with "session … is not live in this store". Quit and reopen the application, then come back and scan. No page data (credentials, Session map) is lost.',
      staleHostButton: 'Login paused until restart',
      error: 'Error',
      refresh: 'Refresh',
      loading: 'Loading…',
      unavailable: 'The Host did not answer: the plugin may not be loaded in this profile, or the web server is not running.',
      errorTitle: 'Error',
      lastInbound: 'Last inbound',
      lastOutbound: 'Last outbound',
      inboundCount: 'Received',
      outboundCount: 'Sent',
      tokenPath: 'Credential file',
      allowlist: 'Allowed WeChat users',
      allowlistEmpty: 'No allowlist set: anyone who can message the bot can drive the agent. Use /whoami to get an id, then add it here.',
      users: 'Known users',
      noUsers: 'Nobody has messaged the bot yet.',
      userId: 'User id',
      session: 'Session',
      messages: 'Messages',
      lastSeen: 'Last seen',
      allowed: 'Allowed',
      blocked: 'Blocked',
      allow: 'Allow',
      block: 'Block',
      resetSession: 'Reset Session',
      resetHint: 'The next message from this user starts a fresh Session.',
      send: 'Send a test message',
      sendHint: 'Push a message to this user as the bot (they must have messaged it first).',
      sendPlaceholder: 'Message text',
      sendAction: 'Send',
      sent: 'Sent',
      commands: 'Commands',
      commandsHint: '/new new Session · /compact compact context · /status state · /whoami my id · /help help',
    }

    const CSS = `
.dshWeChat_tab{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.dshWeChat_card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.dshWeChat_row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshWeChat_rowEnd{margin-left:auto;display:flex;align-items:center;gap:8px}
.dshWeChat_title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dshWeChat_sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshWeChat_label{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshWeChat_value{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshWeChat_pill{display:inline-flex;align-items:center;gap:6px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);padding:2px 8px;font-size:12px;line-height:18px}
.dshWeChat_dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.dshWeChat_dot[data-state=online]{background:var(--dsw-alias-state-success-primary,#07C160)}
.dshWeChat_dot[data-state=login]{background:var(--dsw-alias-state-business-primary,#247bbf)}
.dshWeChat_dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.dshWeChat_button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;cursor:pointer}
.dshWeChat_button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshWeChat_button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshWeChat_button[disabled]{opacity:.5;cursor:default}
.dshWeChat_buttonPrimary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
.dshWeChat_qr{display:flex;flex-direction:column;align-items:center;gap:10px;padding:14px 0 4px}
.dshWeChat_qrBox{border-radius:var(--dsw-radius-lg);background:#fff;padding:10px;line-height:0}
.dshWeChat_error{border-radius:var(--dsw-radius-lg);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);padding:8px 10px;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-line;margin:0}
.dshWeChat_grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 10px;margin:0}
.dshWeChat_grid dt{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshWeChat_grid dd{margin:0;min-width:0}
.dshWeChat_users{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);overflow:hidden}
.dshWeChat_user{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshWeChat_user:first-child{border-top:0}
.dshWeChat_userMain{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshWeChat_input{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;min-width:220px;flex:1}
.dshWeChat_input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none}
.dshWeChat_code{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dshWeChat_link{color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px}
.dshWeChat_cardWarning{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
`

    /**
     * 将二维码渲染为 SVG 路径。
     * @param {{ value: string, size?: number }} props - 载荷与像素尺寸。
     * @returns {object} React 元素。
     */
    function QrCode(props) {
      const value = props.value
      const size = props.size ?? 236
      const model = React.useMemo(() => {
        const code = QRCODE(0, 'M')
        code.addData(value)
        code.make()
        const count = code.getModuleCount()
        const segments = []
        for (let row = 0; row < count; row += 1) {
          for (let col = 0; col < count; col += 1) {
            if (code.isDark(row, col)) segments.push(`M${col} ${row}h1v1h-1z`)
          }
        }
        return { count, path: segments.join('') }
      }, [value])
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: `0 0 ${model.count} ${model.count}`,
          shapeRendering: 'crispEdges',
          role: 'img',
          'aria-label': 'QR code',
        },
        React.createElement('rect', { width: model.count, height: model.count, fill: '#ffffff' }),
        React.createElement('path', { d: model.path, fill: '#000000' }),
      )
    }

    /**
     * 调用一个 Host 路由。
     * @param {string} path - API 前缀之下的路由路径。
     * @param {object} [body] - JSON 请求体；同时将该调用标记为会修改状态。
     * @returns {Promise<object>} Host 应答中的 `value` 字段。
     */
    async function callHost(path, body) {
      const mutate = body !== undefined
      const response = await fetch(`${API}${path}`, {
        method: mutate ? 'POST' : 'GET',
        headers: mutate
          ? { 'content-type': 'application/json', 'x-dsh-wechat': '1' }
          : { accept: 'application/json' },
        body: mutate ? JSON.stringify(body) : undefined,
      })
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error(`HTTP ${response.status}`)
      if (payload.ok !== true) throw new Error(payload.error?.message ?? `HTTP ${response.status}`)
      return payload.value
    }

    /**
     * 启动一次登录，但不等待它完成。
     *
     * 扫码流程只有在用户在手机上确认后才会结束，因此等待它会让按钮冻结数分钟。
     * 页面改为通过自身的 `/state` 轮询得知结果。
     * @param {boolean} force - 要求获取一个全新的二维码。
     */
    function startLogin(force) {
      return fetch(`${API}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-wechat': '1' },
        body: JSON.stringify({ force: force === true }),
      })
        .then((response) => response.json().catch(() => null))
        .then((payload) => {
          if (payload !== null && payload.ok !== true) throw new Error(payload.error?.message ?? 'login failed')
        })
    }

    /**
     * 在页面可见时轮询 Host 状态。
     * @param {number} intervalMs - 轮询间隔。
     * @returns {{loading: boolean, data?: object, error?: string}} 视图状态。
     */
    function useHostState(intervalMs) {
      const [view, setView] = React.useState({ loading: true })
      const [nonce, setNonce] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const data = await callHost('/state')
            // 只上报计数的 Host 侧仍能让页面保持可用：改为从它们各自的路由
            // 读取用户行并合并进来。
            if (!Array.isArray(data?.chat?.users)) {
              try {
                const rows = await callHost('/users')
                if (Array.isArray(rows?.users)) data.chat = { ...(data.chat ?? {}), users: rows.users }
              } catch {
                /* 上面的计数即使没有行列表也仍会渲染 */
              }
            }
            if (alive) setView({ loading: false, data })
          } catch (error) {
            if (alive) setView({ loading: false, error: error instanceof Error ? error.message : String(error) })
          }
        }
        void tick()
        timer = setInterval(() => void tick(), intervalMs)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [intervalMs, nonce])
      return { view, refresh: () => setNonce((value) => value + 1) }
    }

    /** @param {string | null} iso - 时间戳。 @returns {string} 本地时间或一个短横线。 */
    function formatTime(iso) {
      if (typeof iso !== 'string' || iso.length === 0) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleString()
    }

    /**
     * 微信设置标签页。
     * @param {{ t: Function }} props - 由注册过程注入的业务 props。
     * @returns {object} React 元素。
     */
    function WeChatTab(props) {
      const t = props.t
      const { view, refresh } = useHostState(3000)
      const [busy, setBusy] = React.useState(false)
      const [actionError, setActionError] = React.useState(null)
      const [sendText, setSendText] = React.useState('')
      const [sendTarget, setSendTarget] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const run = React.useCallback(
        async (path, body, message) => {
          setBusy(true)
          setActionError(null)
          setNotice(null)
          try {
            await callHost(path, body ?? {})
            if (typeof message === 'string') setNotice(message)
            refresh()
          } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        },
        [refresh],
      )

      const channel = view.data?.channel ?? null
      const chat = view.data?.chat ?? null
      // 早于本页面构建版本的 Host 侧只上报计数。它建立会话的顺序是坏的，
      // 因此页面直接说明这一点，而不是让用户扫码后进入必然失败的对话。
      const staleHost = chat !== null && !('userCount' in chat)
      const state = channel?.state ?? 'idle'
      const stateLabel =
        state === 'online'
          ? t('stateOnline')
          : state === 'login'
            ? t('stateLogin')
            : state === 'error'
              ? t('stateError')
              : state === 'stopped'
                ? t('stateStopped')
                : t('stateIdle')

      const qr = channel?.qr ?? null
      const users = chat?.users ?? []

      return React.createElement(
        'div',
        { className: 'dshWeChat_tab' },
        React.createElement('style', null, CSS),
        React.createElement(
          'div',
          null,
          React.createElement('h3', { className: 'dshWeChat_title' }, t('title')),
          React.createElement('p', { className: 'dshWeChat_sub' }, t('subtitle')),
        ),
        view.error !== undefined
          ? React.createElement('p', { className: 'dshWeChat_error' }, `${t('unavailable')}\n${view.error}`)
          : null,
        staleHost
          ? React.createElement(
              'section',
              { className: 'dshWeChat_card dshWeChat_cardWarning' },
              React.createElement('h4', { className: 'dshWeChat_title' }, t('staleHostTitle')),
              React.createElement('p', { className: 'dshWeChat_sub' }, t('staleHostBody')),
            )
          : null,
        React.createElement(
          'section',
          { className: 'dshWeChat_card' },
          React.createElement(
            'div',
            { className: 'dshWeChat_row' },
            React.createElement('span', { className: 'dshWeChat_dot', 'data-state': state }),
            React.createElement('span', { className: 'dshWeChat_pill' }, `${stateLabel}`),
            React.createElement('span', { className: 'dshWeChat_label' }, channel?.userId ? `${t('account')}: ${channel.userId}` : t('noAccount')),
            React.createElement(
              'span',
              { className: 'dshWeChat_rowEnd' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshWeChat_button dshWeChat_buttonPrimary',
                  disabled: busy || staleHost,
                  title: staleHost ? t('staleHostButton') : undefined,
                  onClick: async () => {
                    setBusy(true)
                    setActionError(null)
                    setNotice(null)
                    try {
                      await startLogin(false)
                      refresh()
                    } catch (error) {
                      setActionError(error instanceof Error ? error.message : String(error))
                    } finally {
                      setBusy(false)
                    }
                  },
                },
                staleHost ? t('staleHostButton') : channel?.userId ? t('relogin') : t('login'),
              ),
              channel?.userId
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dshWeChat_button',
                      disabled: busy,
                      onClick: () => void run('/logout', {}, t('logoutHint')),
                    },
                    t('logout'),
                  )
                : null,
              React.createElement(
                'button',
                { type: 'button', className: 'dshWeChat_button', disabled: busy, onClick: () => refresh() },
                t('refresh'),
              ),
            ),
          ),
          channel === null
            ? React.createElement('p', { className: 'dshWeChat_sub' }, view.loading ? t('loading') : t('unavailable'))
            : React.createElement(
                'dl',
                { className: 'dshWeChat_grid' },
                React.createElement('dt', null, t('tokenPath')),
                React.createElement('dd', { className: 'dshWeChat_code' }, channel.tokenPath ?? '—'),
                React.createElement('dt', null, t('inboundCount')),
                React.createElement('dd', { className: 'dshWeChat_value' }, `${channel.inboundCount ?? 0} / ${t('outboundCount')} ${channel.outboundCount ?? 0}`),
                React.createElement('dt', null, t('lastInbound')),
                React.createElement('dd', { className: 'dshWeChat_value' }, formatTime(channel.lastInboundAt)),
                React.createElement('dt', null, t('lastOutbound')),
                React.createElement('dd', { className: 'dshWeChat_value' }, formatTime(channel.lastOutboundAt)),
              ),
          channel?.lastError
            ? React.createElement('p', { className: 'dshWeChat_error' }, `${t('error')}: ${channel.lastError}`)
            : null,
          actionError !== null ? React.createElement('p', { className: 'dshWeChat_error' }, actionError) : null,
          notice !== null ? React.createElement('p', { className: 'dshWeChat_sub' }, notice) : null,
          qr !== null
            ? React.createElement(
                'div',
                { className: 'dshWeChat_qr' },
                React.createElement('span', { className: 'dshWeChat_title' }, t('qrTitle')),
                React.createElement('div', { className: 'dshWeChat_qrBox' }, React.createElement(QrCode, { value: qr.content })),
                React.createElement(
                  'span',
                  { className: 'dshWeChat_sub' },
                  qr.status === 'scaned' ? t('qrScan') : qr.status === 'expired' ? t('qrExpired') : t('qrHint'),
                ),
                React.createElement(
                  'a',
                  { className: 'dshWeChat_link', href: `${API}/qr`, target: '_blank', rel: 'noreferrer' },
                  t('openQr'),
                ),
              )
            : state === 'login'
              ? React.createElement('p', { className: 'dshWeChat_sub' }, t('qrWaiting'))
              : null,
        ),
        React.createElement(
          'section',
          { className: 'dshWeChat_card' },
          React.createElement('h4', { className: 'dshWeChat_title' }, t('allowlist')),
          (channel?.allowedUserIds ?? []).length === 0
            ? React.createElement('p', { className: 'dshWeChat_sub' }, t('allowlistEmpty'))
            : React.createElement('p', { className: 'dshWeChat_code' }, (channel?.allowedUserIds ?? []).join(', ')),
          React.createElement('h4', { className: 'dshWeChat_title' }, t('users')),
          users.length === 0
            ? React.createElement('p', { className: 'dshWeChat_sub' }, t('noUsers'))
            : React.createElement(
                'div',
                { className: 'dshWeChat_users' },
                users.map((user) =>
                  React.createElement(
                    'div',
                    { className: 'dshWeChat_user', key: user.userId },
                    React.createElement(
                      'div',
                      { className: 'dshWeChat_userMain' },
                      React.createElement('span', { className: 'dshWeChat_code' }, user.userId),
                      React.createElement(
                        'span',
                        { className: 'dshWeChat_label' },
                        `${t('messages')}: ${user.messages} · ${t('lastSeen')}: ${formatTime(user.lastSeenAt)}${user.sessionId ? ` · ${t('session')}: ${user.sessionId}` : ''}`,
                      ),
                    ),
                    React.createElement(
                      'span',
                      { className: 'dshWeChat_rowEnd' },
                      React.createElement('span', { className: 'dshWeChat_pill' }, user.allowed ? t('allowed') : t('blocked')),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshWeChat_button',
                          disabled: busy,
                          onClick: () => void run('/allow', { userId: user.userId, allowed: !user.allowed }),
                        },
                        user.allowed ? t('block') : t('allow'),
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshWeChat_button',
                          disabled: busy,
                          onClick: () => void run('/reset', { userId: user.userId }, t('resetHint')),
                        },
                        t('resetSession'),
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dshWeChat_button',
                          disabled: busy,
                          onClick: () => {
                            setSendTarget(user.userId)
                            setNotice(null)
                          },
                        },
                        t('send'),
                      ),
                    ),
                  ),
                ),
              ),
          sendTarget !== null
            ? React.createElement(
                'div',
                { className: 'dshWeChat_row' },
                React.createElement('span', { className: 'dshWeChat_code' }, sendTarget),
                React.createElement('input', {
                  className: 'dshWeChat_input',
                  placeholder: t('sendPlaceholder'),
                  value: sendText,
                  onChange: (event) => setSendText(event.target.value),
                }),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dshWeChat_button',
                    disabled: busy || sendText.trim().length === 0,
                    onClick: async () => {
                      await run('/send', { userId: sendTarget, text: sendText }, t('sent'))
                      setSendText('')
                    },
                  },
                  t('sendAction'),
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dshWeChat_button', onClick: () => setSendTarget(null) },
                  '✕',
                ),
              )
            : null,
          React.createElement('p', { className: 'dshWeChat_sub' }, `${t('sendHint')} ${t('commandsHint')}`),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.locale.register(NS, {
              zh,
              en,
            }),
          'dsh-wechat: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            {
              name: 'settings.plugins.tab',
              id: 'wechat',
              order: 30,
              label: () => t('tab'),
              locale: NS,
              inject: () => ({ t }),
            },
            WeChatTab,
          ),
        )
      },
    }
  },
})
