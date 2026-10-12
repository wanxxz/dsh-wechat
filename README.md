# @wanxxz/dsh-wechat — 微信频道插件（DeepSeek Harness）

把**微信官方 iLink Bot / 微信 ClawBot 通道**接到 DeepSeek Harness（DSH）：

- 手机微信扫码登录，DSH 获得一个自己的微信机器人身份；
- 微信里的消息 → DSH 会话 → 智能体的回答自动发回微信；
- 智能体可以用 `wechat_send` 工具**主动推送**消息（配合定时任务做提醒/日报）；
- 每个微信用户一个独立会话，支持 `/new`、`/compact`、`/status`、`/whoami`、`/help`；
- 白名单/拉黑、会话重置、测试发送都在 Harness Web 的**设置 → 内置插件 → 微信**页面里完成（含二维码）。

实现方式参考 Cherry Studio 的微信频道（[CherryHQ/cherry-studio#13714](https://github.com/CherryHQ/cherry-studio/pull/13714)）：同样直连腾讯 iLink Bot API（`https://ilinkai.weixin.qq.com`），协议部分由该 PR 的 `WeChatProtocol.ts` 移植为**零依赖** ESM 模块。

---

## 1. 安装

插件就在本工作区，安装 = 把它作为 bundle 加进 desktop profile：

```powershell
$dsh = "<DeepSeek Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile desktop add "<本仓库路径>"
```

这条命令会用 DSH 自带的 pnpm 在 profile 目录安装为**链接（Junction）**，并自动把包名追加进 profile `package.json` 的 `dsh.profile.bundles`。

- 由于是本地链接，**改代码后重启应用即可生效**（HMR 只热挂新 bundle，不热替换已加载模块）。
- 卸载：`& $dsh plugin --profile desktop remove @wanxxz/dsh-wechat`。
- 需要手写 profile（不跑 pnpm）时的等价做法见 `_recon/notes/install-path.md` 的"方案 B"。

卸载/停用不会删除已保存的凭据与会话映射，它们分别在：

- `$DSH_HOME\plugins\@wanxxz\dsh-wechat\weixin_bot.json`（微信登录凭据，0600）
- `$DSH_HOME\plugins\@wanxxz\dsh-wechat\state.json`（微信用户 ↔ 会话映射、白名单覆盖）

## 2. 配置

插件行由本包自带的 `cordis.patch.yml` 插入（id `wechat`）。要改配置，**在 profile 的 `cordis.patch.yml` 里按 id 覆盖整行 config**（loader 是整体替换，不是合并）：

```yaml
- id: wechat
  name: '@wanxxz/dsh-wechat'
  config:
    autoStart: if-credentials      # always | if-credentials | never
    autoReply: true                # false = 只允许 /命令 与主动推送
    allowedUserIds: []             # 空 = 允许所有人；填了就只允许这些微信用户
    workspacePath: ''              # 空 = $DSH_HOME\plugins\@wanxxz\dsh-wechat\workspace
    agentPreset: ''                # 空 = 当前默认预设（desktop 默认 standard）
    permissionPreset: ''           # 空 = 继承部署默认；可填 read-only / danger-full-access 等
    tokenPath: ''                  # 空 = $DSH_HOME\plugins\@wanxxz\dsh-wechat\weixin_bot.json
    statePath: ''                  # 空 = $DSH_HOME\plugins\@wanxxz\dsh-wechat\state.json
    baseUrl: ''                    # 空 = https://ilinkai.weixin.qq.com
    typingIndicator: true
    agentTool: true                # 注册 wechat_send 工具
    approvalFallback: reject       # reject = 微信会话里的审批请求自动拒绝；default = 走部署策略
    model: null                    # 例如 { provider: deepseek, model: deepseek-chat }
    turnTimeoutMs: 900000          # 单轮上限（毫秒），超时回一句错误并结束等待
    httpPrefix: /wechat-channel    # 设置页用的 Host HTTP 前缀
    qrAutoLogin: true              # 打开 /wechat-channel/qr 备用页时自动开始登录
    defaultLanguage: zh            # 命令回复默认语言；用户发过中文/英文后按该用户记住
```

**`agentPreset` 必须能解析**：`setup` 里会 `ctx.agentPresets.mount(...)`，不挂预设的会话在第一次请求就会失败（DSH 的 invariant 会直接报错）。空值走默认预设，通常不用改。

## 3. 使用

1. 打开 Harness Web → **设置 → 内置插件 → 微信**。
2. 点【扫码登录】→ 用手机微信扫码并在手机上确认。
3. 页面显示"已连接"后，在微信里给机器人发消息即可。
4. 首次收到消息后，页面"已知用户"里会出现你的 ID；点【禁止】可以拉黑，点【重置会话】可以让下一条消息开新会话。

> 如果页面显示**「请先重启 DeepSeek Harness」**并禁用了扫码按钮，说明运行中的 Host 还是安装插件时那版代码（它的会话建立顺序有已知缺陷，扫码后每条消息都会以 `session … is not live in this store` 失败）。完全退出并重新打开应用后再回来扫码即可；凭据与会话映射不会丢。

**备用登录页**：Host 侧另外提供了不依赖客户端插件的扫码页面——

- `http://127.0.0.1:19387/wechat-channel/qr` —— 可直接在浏览器打开，内嵌二维码并每 3 秒自动刷新，设置页加载不出来时用它；
- `http://127.0.0.1:19387/wechat-channel/qr.svg` —— 裸 SVG（还没开始登录时返回 404）；
- `http://127.0.0.1:19387/wechat-channel/state` —— JSON 状态，便于脚本排查。

微信侧命令：

| 命令 | 作用 |
|---|---|
| 直接发消息 | 在属于你的会话里向智能体提问 |
| `/new` | 开新会话（丢弃当前上下文） |
| `/compact` | 调用 DSH 自己的 `/compact` 命令压缩当前会话上下文 |
| `/status` | 显示机器人状态、你的会话 id、轮次、工作区 |
| `/whoami` | 显示你的微信用户 ID（用于白名单） |
| `/help` | 帮助 |

长回答会按微信 2000 字上限切分成多条发送。

发图片/文件/视频（这类消息没有文字内容）时，机器人会回一句"目前只支持文字消息"，而不是沉默——这样你能分清"它不支持"和"它挂了"。语音消息若平台带回了转写文字，会按文字处理。

命令回复的语言：插件会**按用户记住**他写的是中文还是英文，`/whoami` 这类不带语言的命令就用记住的语言回答；从没发过消息的用户用 `defaultLanguage`（默认中文）。

## 4. 结构与实现要点

```
index.js                  Host 插件入口：配置归一化、生命周期、工具注册、HTTP 挂载
lib/channel.js            WeChatChannel：登录/长轮询/状态快照/发送（含分片）
lib/wechat-protocol.js    iLink Bot 协议（移植自 cherry-studio，零依赖）
lib/chat.js               WeChatChats：微信用户 ↔ 会话、轮次读取、命令、白名单
lib/store.js              状态文件读写（原子写 + 串行队列）
lib/commands.js           命令解析与本地化文案
lib/web.js                设置页用的 Host HTTP API（含 /qr 备用登录页）
lib/qr.js                 Host 侧二维码渲染（复用同一个 vendored 编码器）
src/client.js             设置页源码（浏览器侧，React）
build.js                 src/client.js + vendor → client.js
vendor/qrcode-generator.js  二维码生成器（MIT，Kazuhiro Arase，见文件头许可）
client.js                 构建产物（不要直接编辑）
test/*.js                冒烟测试（假 Harness ctx / 假微信服务端 / 假 React）
```

关键实现说明：

- **读取智能体回答**：DSH 没有"提问 → 返回文本"的 API，`agent.followup()` 返回 `void`。本插件用
  `ctx.on('agent/inbox/claimed')` 把发出的 `message.id` 映射到它开启的 `turn`，再用
  `ctx.on('session/event')` 等这一轮的 `turn/end`，并从该轮 `assistant/message` 的 `content` 里取
  `type === 'text'` 的块（与 `@deepseek-ai/dsh-subagent` 的 `finalAssistantOutput` 同一规则）。
- **会话复用**：同一微信用户始终复用同一个会话；应用重启后优先 `ctx.agents.resume({ resumeSessionId })`
  恢复持久化会话，恢复失败才新建。`create({sessionId})` 不能用来继续旧会话（会被拒绝）。
- **零 Harness import**：插件只 import Node 内置模块，所有能力通过 `ctx` 上的服务获取，避免第三方
  bundle 的模块解析问题把插件整体拖垮。
- **安全边界**：设置页的变更类接口要求 `x-dsh-wechat` 请求头，跨站页面带该头会触发 CORS 预检而本服务
  不响应预检；Host HTTP 服务默认只监听回环地址。
- **审批**：微信里没有审批界面，默认（`approvalFallback: reject`）会拒绝微信会话内发起的工具审批并在
  日志里记录，避免整轮卡死。需要完全放开请改 `permissionPreset` 并自行评估风险。

## 5. 自检与验证

```powershell
cd <本仓库路径>
node test\host.smoke.js           # 会话桥接：建会话/复用/取回答/命令/语言记忆/白名单/状态文件/审批兜底
node test\plugin.smoke.js         # 插件装配：工具契约 + 10 条 HTTP 路由 + 鉴权与方法校验
node test\client.smoke.js         # 设置页：模块加载/槽注册/二维码渲染/新旧 Host 兼容/按钮动作
node test\qr.smoke.js             # Host 侧二维码 SVG 与备用登录页（含转义与空态）
node test\protocol.qr.smoke.js    # 登录流程：重定向主机 / binded_redirect / 空 baseurl / 过期重发 / 未知状态
node build.js                     # 重新生成 client.js（改了 src/client.js 之后）

# 需要真实运行的实例（见下文"完全隔离的自检实例"）
node test\host-routes.probe.js <base-url>          # /state 结构、/qr、/qr.svg
node test\served-module.js <base-url> <token>      # 浏览器模块图是否含本插件
node test\mock-ilink.js 45999                      # 模拟微信 iLink 服务端
node test\mock-openai.js 45998                     # 模拟 OpenAI 兼容模型（只回一句固定文本）
```

前面五个用假的 Harness ctx / 假微信服务端 / 假 React 跑通全链路，不依赖真实应用与外网。

### 已在本机验证

| 项 | 结果 |
|---|---|
| bundle 安装进 desktop profile | ✅ `dsh plugin --profile desktop add …` 成功，`node_modules/@wanxxz/dsh-wechat` 为 Junction，`dsh.profile.bundles` 已追加 |
| 插件热挂载 | ✅ 安装后 `wechat_send` 工具出现在运行中的 Harness 会话里 |
| Host HTTP API | ✅ `GET http://127.0.0.1:19387/wechat-channel/state` 返回 200 与真实快照 |
| 微信 iLink 接口连通 | ✅ 登录流程触发成功，腾讯返回了真实二维码载荷（`https://liteapp.weixin.qq.com/q/...`） |
| 冒烟测试 | ✅ host / plugin / client / qr / protocol.qr 五套全部通过（多次运行稳定） |
| **完整回路（隔离实例，修复后代码）** | ✅ 模拟微信投递「请只回复这一句话：插件自检通过」→ DSH 建会话 → 智能体一轮（真实 OpenAI 兼容流式协议，`stream=true`）→ 回答文本 `插件自检通过（来自本地模拟模型）` 回传到微信侧 |
| **重启后会话延续** | ✅ 主机重启后复用同一 `sessionId`（`wechat-b7d4211d-…`），轮次 1→2，回答照常回传 |
| **命令面（真实主机）** | ✅ `/whoami` 立即回 ID 且不消耗智能体轮次；`/new` 清空会话映射（`sessions: {}`）；中文用户收到中文命令回复（`lang: zh`） |
| **新 Host 面（隔离实例）** | ✅ `/state` 已是新结构（`userCount`/`sessionCount`/`users` 数组）；`/qr.svg` 返回真实 SVG（37 模块、702 个黑块）；`/qr` 返回带自动刷新的 HTML |
| **浏览器模块图** | ✅ 索引页的合并脚本里含本插件客户端代码（`@wanxxz/dsh-wechat/client.js`），即设置页会拿到并加载它 |
| **真机扫码登录** | ✅ 手机微信扫码成功，频道 `online`，机器人账号 `<机器人账号>@im.bot`，凭据写入 `$DSH_HOME\plugins\@wanxxz\dsh-wechat\weixin_bot.json` |
| **真机完整闭环** | ✅ 微信发「42」→ 会话日志出现 `user/message` 且 `source.kind=wechat` → 智能体一轮 `assistant/message`（166 字，`turn/end` reason `completed`）→ 频道 `outbound: 1`，回答已发回微信 |
| 真机上的命令 / 主动推送 | ⏳ 命令面与 `wechat_send` 已在隔离实例验证；真机上只跑过普通问答 |
| 设置页在浏览器里的目视效果 | ⏳ 模块已被证实送达，未逐项目视核对 |
| desktop 实例加载新 Host 代码 | ✅ 已重启，`/state` 为新结构、`/qr` 路由存在 |

### 重启与热加载说明

- **浏览器侧（`client.js`）**：刷新页面即可拿到最新版本，不需要重启。
- **Host 侧（`index.js` / `lib/*`）**：模块不在 HMR 监听范围内，改动要**重启应用**才生效。

profile 的 `cordis.patch.yml` 里追加过一行 `hmr` 覆盖，本意是把插件目录加入模块监听：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - '<本仓库路径>'
```

**实测该热加载没有生效**（改 `index.js` 后运行中的实例仍跑旧代码；推测是运行中的 HMR 不会为新增的 root 重建模块监听）。要彻底确认需要重启一次应用再看。原文件备份在 `cordis.patch.yml.bak-dsh-wechat`，不需要这行时可以删掉。

### 在真实应用里做端到端自检（不需要微信）

`test/mock-ilink.js` 是一个本地模拟的 iLink 服务端：它发一个二维码、立刻"确认"、投递一条消息，并把频道发回的内容打印出来。把插件临时指向它，整条链路（频道 → 会话 → 智能体一轮 → 回答回传）就会在**正在运行的 Harness 里真实跑一遍**：

```powershell
# 1) 启动模拟服务端（另开一个终端，或作为后台任务）
cd <本仓库路径>
node test\mock-ilink.js 45999

# 2) 在 profile 的 cordis.patch.yml 里加一行临时覆盖（注意：行覆盖是整块替换 config）
#    - id: wechat
#      name: '@wanxxz/dsh-wechat'
#      config:
#        autoStart: always
#        autoReply: true
#        allowedUserIds: []
#        workspacePath: ''
#        agentPreset: ''
#        permissionPreset: ''
#        tokenPath: '<本仓库路径>/.selfcheck/weixin_bot.json'
#        statePath:  '<本仓库路径>/.selfcheck/state.json'
#        baseUrl: 'http://127.0.0.1:45999'
#        typingIndicator: true
#        agentTool: true
#        approvalFallback: reject

# 3) 约 3 秒后配置热重载，观察模拟端输出；也可以直接查状态：
#    http://127.0.0.1:19387/wechat-channel/state
# 4) 自检完删除那行覆盖，恢复真实配置
```

凭据与状态都落在工作区的 `.selfcheck/` 下，不会覆盖你真实的微信登录凭据。

**这次自检的收获（已修）**：第一次跑通时微信侧收到的是
`处理失败：session "wechat-…" is not live in this store` —— 因为我把
`sessionTitle.rename` / `permissionPresets.set` 放进了 `setup`（agent 尚未发布，会话还没上架），
而官方 `webhook` 运行时的顺序是 **create 之后**再设标题与权限。修复后 `test/host.smoke.js`
里的假 Session 服务会像真实现一样拒绝"未上架"的会话，因此这类顺序错误不会再悄悄溜过去。

### 完全隔离的自检实例（推荐做法）

上面的做法会临时改你正在用的实例。更干净的做法是**另起一个临时 Harness 实例**：

1. 在工作区里造一个临时 `DSH_HOME`：`<home>\profiles\selfcheck\{package.json,cordis.patch.yml}` + `node_modules\@wanxxz\dsh-wechat` 联接（package.json 的 `dsh.profile.bundles` 与 desktop 一样是 base + web-app + 本插件）；
2. 把真实 `$DSH_HOME\.credentials.yaml` 与 `.env` 复制进临时 home（**自检后务必删除**）；
3. 模拟模型 + 模拟微信一起跑：`node test\mock-openai.js 45998` 与 `node test\mock-ilink.js 45999`；
4. `$env:DSH_HOME='<home>'; & dsh.cmd --profile selfcheck --port 19587 --no-open`。

`mock-ilink.js` 的开关：`MOCK_INBOUND_TEXT`（单条内容）、`MOCK_INBOUND_TEXTS`（用 `||` 分隔的多条脚本，按顺序投递）、`MOCK_QR_STATUS=wait`（停在扫码状态，用来验证 `/qr` 页面）、`MOCK_MESSAGE_ID`（默认每次运行唯一，否则会被客户端去重拦下）。

配套探针：

```powershell
node test\host-routes.probe.js http://127.0.0.1:19587     # /state 结构、/qr、/qr.svg
node test\served-module.js http://127.0.0.1:19587 <token>  # 浏览器模块图里是否含本插件（token 由 dsh 启动时打印）
```

这次就是用这套环境验证了：完整回路、重启后会话延续、`/whoami` 与 `/new`、新的 `/qr` 路由、以及客户端模块确实被送进浏览器。

### 待办 / 已知限制

- 首次登录必须在设置页点【扫码登录】（或打开 `/wechat-channel/qr`，或把 `autoStart` 设为 `always`）；`if-credentials` 默认策略在无凭据时不会自己弹二维码。
- `context_token` 只存在内存里，重启后需要该用户**先给机器人发一条消息**，智能体才能主动推送。
- 图片、文件、视频**只做友好提示，不会真正下载或交给模型**；语音依赖平台返回的转写文字。
- 扫码状态里 `need_verifycode` / `verify_code_blocked` 只会透出给状态回调（不再抛错打断登录），但**没有**实现"用验证码重试"的流程；遇到这类账号需要另行处理。
- 会话标题统一为 `WeChat · <用户 ID>`，工作区默认 `$DSH_HOME\plugins\@wanxxz\dsh-wechat\workspace`（会出现在 Harness 的工作区列表里）。
- 每个微信用户对应一个常驻会话；目前没有空闲回收（个人使用无所谓，多用户部署可以按需加 TTL）。

## 6. 协议来源与许可

- 协议与命令面参考 Cherry Studio 的 `WeChatProtocol.ts` / `WeChatAdapter.ts`（PR #13714，MIT）。
- `vendor/qrcode-generator.js`：qrcode-generator 1.4.4，Copyright (c) 2009 Kazuhiko Arase，MIT。
- 本插件：MIT，Copyright (c) 2026 Yiwan Zhou &lt;mail@yiwan.me&gt;。
