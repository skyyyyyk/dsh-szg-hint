# dsh-szg-hint

旁路提示插件：任务执行中插一句话，AI **下一步**即刻参考——**不打断任务、不污染对话历史**。

用户在一次任务执行的过程中插一句话，AI **下一步**就参考到，任务不被打断、主对话历史不被污染。
提示只随某一步请求出现一次，随后标记为已参考（前端收到回执）。

与官方 `Agent.steer()` / `Agent.inject()` 的区别：那两条通道的消息会进入会话历史（见
`agent/inbox/claimed`），本插件的注入走 `agent/pre-step` 只追加进**当前这一步**的请求，
不调 `session.append`——所以刷新页面后聊天区看不到它，模型也只看到一次。

安装（任选其一）：

```sh
# 从 npm（发布后）
dsh plugin --profile web add dsh-szg-hint

# 从 GitHub 源码（pnpm ≥10 需按提示授权构建脚本，首次 add 会失败并给出确切包键）
dsh plugin --profile web add github:<owner>/dsh-szg-hint

# 本地 checkout
dsh plugin --profile web add /path/to/dsh-szg-hint
```

装完重启 `dsh web`。只想先验证层是否被识别，用 `dsh --profile web --dump-config | grep dsh-szg-hint`。

## 半边职责

| 半边 | 职责 |
|---|---|
| Host（`src/index.ts` + `src/store.ts` + `src/protocol.ts`） | 队列（JSONL 落盘）、数据面路由 `/szg-hint/*`、`agent/pre-step` 注入、运行态订阅（`turn/start` / `turn/end`）、`hint_send` / `hint_status` 工具 |
| Client（`src/client/`） | `./link.ts` 一条宿主链路（SSE + 降级轮询 + 写操作），`HintBar.tsx` 工具行右侧的紧凑入口（`conversation.input.right`，28px 圆钮 + 上弹面板）：待参考计数角标、输入面板（Enter 发送 / Shift+Enter 换行）、待参考列表与撤销、最近已参考、右上角轻提示 |

两侧共用 `src/protocol.ts` 的类型契约（只有类型，没有运行时代码）。

数据落 `$DSH_HOME/szg-hint/hints.jsonl`（append-only 事件流：`put` / `del` 两态，启动回放即得当前
状态；行数超过 2000 自动压缩成「待消费 + 最近 20 条已消费」）。`consumed` 落盘的意义是**重启不重复
消费**：模型已经看过的提示不会再灌一遍。

## 数据通道

| 通道 | 用途 | 行为 |
|---|---|---|
| `GET /szg-hint/events`（SSE） | 主通道 | 状态一变推一帧 `event: state`（完整快照，含 `revision`）；动作推一帧 `event: hint`（`added` / `consumed` / `cancelled`，供轻提示）；开通道先写注释行与 `retry`，之后每 25 秒一条 `: ping`。空闲时零流量 |
| `GET /szg-hint/state` | 轮询兜底 | 返回**同一个**快照，供 SSE 不可用（老宿主 / 代理干扰）时降级；4 秒一次，连续失败降频到 12 秒 |
| `POST /szg-hint` | 入队 | 同源校验；body `{ text, sessionId? }`（`sessionId` 留空 = 全局）；返回 `{ ok, hintId, running, dropped }`；`running` 说明「该会话此刻是否在跑回合」，前端据此选文案 |
| `DELETE /szg-hint`（body `{ id }`）| 撤销 | 待参考可撤；已被参考返回 409、不存在返回 404（中文原因，前端直接展示）。`DELETE /szg-hint/<id>` 是同一动作的路径形式，方便 curl |

浏览器半边只有一条应用路径（`normalizeSnapshot` + 状态替换），「推来的」与「拉来的」在组件看来完全一样；
动作帧只用于弹轻提示（按提示 id 去重，SSE 重放不会重复弹）。页面不可见时整条链路断开（不占浏览器每源连接配额）。

## 注入语义

- 扩展点：`agent/pre-step` waterfall——与记忆插件的逐轮段同一个钩子（系统提示词装配之后、模型请求之前），
  但**每一步都检查**：任务跑着的时候用户随时可能发提示，下一步就该看到它，无论那是第几步。
- 注入形态：一条 `plugin` 来源的 user 消息（`source.plugin = 'szg-hint'`，`form: snapshot`，段名「旁路提示」），
  追加进本步消息序列；**它不写进对话历史**，只在这一步出现。
- 归属：按 pre-step 负载里的会话取（`payload.agent.session`），命中该会话的与全局（`sessionId = ''`）提示，
  最旧优先，单步最多 20 条。拿不到会话 id 时**只取全局**——「拿不到归属」不等于「可以把别的会话的提示喂过来」。
- 原子性：取走即标记 `consumed`（同步执行、中途无 await，等价于源侧的事务 SELECT+UPDATE）；
  构造注入消息失败会**回滚成待消费**，下一步重试——绝不出现「标了已参考、模型却没看到」。
- 回执：注入成功推 `hint` 帧（`kind: consumed`），前端弹「AI 已参考你的提示」。

## Model Experience

- **模型看到什么**：一条用户角色消息，正文形如

  ```text
  📌 旁路提示（用户在任务执行过程中插入，不占对话历史，仅本条可见）
  请在本步参考下面的要求，然后继续原来的任务；不要停下来等待确认，也不要把它当作新的用户回合。
  1. <提示正文>
  ```

  单条正文超过 600 字会截断展示（队列里保留全文，上限 2000 字）。
- **token 成本**：只在有提示的那一步增加一条消息（空队列时不注入任何东西，也不会造成「每步都变」的
  缓存抖动）。多条同时到达时合并成一条消息，最多 20 条。
- **KV 缓存**：未消费队列为空时，本插件对请求**零影响**；有提示时该步的消息序列尾部多一条，之后各步
  恢复到原序列（提示不再出现第二次）。
- **模型可用的动作**：`hint_send`（向指定会话投递提示，默认落到自己所在会话）、`hint_status`（查看
  待参考与最近已参考）。

## 工具（模型侧）

| 工具 | 用途 |
|---|---|
| `hint_send` | 投递一条提示到某会话（留空 `sessionId` = 当前会话）：`{ text, sessionId? }`。返回 id、是否即刻生效（目标会话是否在跑）、以及是否因该会话积压上限挤掉了最旧一条 |
| `hint_status` | 查看队列：`{ sessionId? }`（留空 = 当前会话，`*` = 全部会话）。返回待参考明细、该会话是否在跑、最近被参考的提示 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关闭则不注册路由、工具与事件订阅 |
| `dshHome` | `''` | 留空取 `DSH_HOME`，再退回 `~/.dsh` |
| `maxPerStep` | `20` | 单步最多消费几条（与源侧一致，防队列积压刷爆上下文） |
| `maxContentChars` | `2000` | 单条正文上限（码点，超出截断） |
| `maxPendingPerSession` | `20` | 单会话待消费上限；超出挤掉最旧一条并在写入响应里报告 |
| `keepConsumed` | `20` | 快照里保留的最近已参考条数（也是压缩时保留的条数） |
| `heartbeatMs` | `25000` | SSE 注释心跳间隔 |

## 挂载与重建

`$DSH_HOME/profiles/web/cordis.patch.yml` 的 insert 行（`id: szg-hint`），依赖记在
`profiles/web/package.json` 的 `link:` 条目上；**新增条目不会被 patchReload 热更新，必须重启 dsh**。

```sh
pnpm --filter @szg/dsh-szg-hint exec tsc -b        # lib/types（host + client 两个编译面）
pnpm --filter @szg/dsh-szg-hint exec tsdown        # lib/index.js（宿主）+ lib/client.js（浏览器）
```

- 改 `src/client/`：重建 `lib/client.js` 即按内容哈希热更新，不必刷新页面。
- 改 `src/index.ts` / `src/store.ts`（宿主半边）：**必须重启 dsh 宿主**。

## 测试

| 用例 | 覆盖 | 命令 |
|---|---|---|
| `tests/store.spec.ts` | 队列契约（12 例）：原子消费不重复、最旧优先与单步上限、会话/全局作用域、拿不到会话时只取全局、撤销三态、注入失败回滚、单会话上限与 `dropped` 报告、空白拒绝与截断、运行态信号、重启后不重复消费、坏行跳过、快照口径 | `pnpm exec vitest run packages/szg/hint/tests/store.spec.ts` |

## Known Limitations and Deferred Work

- **UI 文案是中文硬编码**，与同目录的 `@szg/dsh-szg-pet` / `@szg/dsh-szg-token-report` 一致。
  `verify-client-ui-i18n` 会把这些 szg 包判红（既存状态，非本包引入）；若要绿灯需整体走 locales 抽取。
- 只做文本提示：szg 侧「图片/录音转文字再发提示」依赖那边的附件管道，dsh 侧输入区槽位没有对应能力，
  先用 dsh 自带的输入附件通道。
- 提示**不进对话历史**，因此刷新页面后聊天区看不到它；待参考与「最近已参考」由快照提供（不落前端历史，
  与 szg 的 localStorage 记录相比少了跨浏览器持久化）。
- 运行态来自 `turn/start` / `turn/end`：宿主重启后内存里的「在跑」集合清空，第一次 turn 事件前
  `running` 为假（文案退化为「下个任务参考」，提示本身照常入队）。
- 多会话并行时 SSE 推的是全局快照，前端按自己的会话过滤；跨会话的动作帧（别的标签页发的提示）
  不会在本标签页弹提示。

## 许可

MIT（见 `LICENSE`）。插件按 dsh 的插件协议扩展宿主，不改任何官方源码；宿主升级时以
`agent/pre-step` 与 `ctx.tools` / `webServer` 的公开契约为界。