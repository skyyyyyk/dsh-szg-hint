/**
 * 旁路提示 · 宿主半边（`dsh-szg-hint`）。
 *
 * 迁移自 szg 的「提示干预」（`szg/gui/server.py` 的 `/api/chat/hint`、
 * `szg/memory/db.py` 的 `hint_queue`、`szg/core/agent.py` 的 `hint_fetcher_fn`）：
 * 用户在执行任务的过程中插一句话，AI 下一步就参考到，任务不被打断、主对话历史不被污染。
 * dsh 侧的落点是四个现成扩展点：
 *
 * - **队列 + 数据面**：{@link HintStore}（JSONL 落盘，见 `./store.ts`）与 PLUGIN_ID 前缀的数据面
 *   （SSE `state`/`hint` 帧 + 轮询兜底 + 写入 + 撤销）。
 * - **注入**：`agent/pre-step` waterfall——与记忆插件的逐轮段同一个扩展点，但**每一步都
 *   检查**（任务跑着的时候用户随时可能发提示，不像「本轮提问」只在首步有意义）。提示作为
 *   一条 `plugin` 来源的 user 消息追加进本步；注入成功即标记 consumed 并推 `hint` 事件帧
 *   （前端据此弹「AI 已参考」）。构造消息失败会**回滚成待消费**，下一步重试。
 * - **运行态**：订阅 `session/event` 的 `turn/start` / `turn/end`，按会话记录「是否在跑
 *   回合」——前端据此选文案（「下一步参考」还是「排队等下个任务」）。
 * - **工具**：`hint_send`（模型也能投递提示，默认落到自己所在的会话）、`hint_status`。
 *
 * @module dsh-szg-hint
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { HintEventFrame, HintItem, HintSnapshot } from './protocol.ts'
import { DEFAULT_STORE_OPTIONS, HintStore } from './store.ts'

/**
 * 插件 id：Cordis 插件名、路由前缀、消息来源与数据目录共用，**必须等于包名**。
 * 声明在引用之前——打包器会内联尾部的常量声明，留下的引用就会变成
 * 「未定义」。
 */
const PLUGIN_ID = 'dsh-szg-hint'

/** Cordis 插件名（loader 诊断用）。 */
export const name = PLUGIN_ID

/**
 * 硬依赖：`tools` 用于注册提示工具，`webServer` 用于挂数据面路由。
 *
 * ★两条纪律：① `webServer` 必须是**硬依赖**而不是软获取——宿主服务在插件 apply 之后才挂载，
 * 软获取会拿到 undefined，症状是页面有提示栏却全部 404；② 取服务走**已声明的属性**（`ctx.webServer`），
 * 而不是 `ctx.get('webServer')`：声明过的依赖在属性上是就绪的，缺席时得到 undefined 能被下面的
 * 分支明确报告，而 `ctx.get` 对未就绪服务是挂起语义、路径不可控。
 */
export const inject = ['tools', 'webServer']

/** 插件配置。 */
export interface Config {
  /** 关掉即不注册路由、工具与事件订阅。 */
  enabled: boolean
  /** dsh home；留空取 `DSH_HOME`，再退回 `~/.dsh`。 */
  dshHome: string
  /** 单步最多消费几条提示（源侧为 20，同样防队列积压刷爆上下文）。 */
  maxPerStep: number
  /** 单条提示正文上限（码点）。 */
  maxContentChars: number
  /** 单会话待消费提示上限（超出挤掉最旧一条并在写入响应里报告）。 */
  maxPendingPerSession: number
  /** 快照里保留的最近已消费条数。 */
  keepConsumed: number
  /** SSE 注释心跳间隔（毫秒）。 */
  heartbeatMs: number
}

/** 插件配置 schema（schemastery，loader 会补默认值）。 */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  dshHome: z.string().default(''),
  maxPerStep: z.number().default(20),
  maxContentChars: z.number().default(DEFAULT_STORE_OPTIONS.maxContentChars),
  maxPendingPerSession: z.number().default(DEFAULT_STORE_OPTIONS.maxPendingPerSession),
  keepConsumed: z.number().default(DEFAULT_STORE_OPTIONS.keepConsumed),
  heartbeatMs: z.number().default(25000),
})

/** 数据面路由前缀（webServer.register 的路径，必须带前导斜杠）。 */
const ROUTE_PREFIX = `/${PLUGIN_ID}`
/** SSE 主通道。 */
const EVENTS_PATH = `${ROUTE_PREFIX}/events`
/** 轮询兜底。 */
const STATE_PATH = `${ROUTE_PREFIX}/state`
/** 断线后浏览器半边的重连建议（毫秒）。 */
const SSE_RETRY_MS = 3000
/** 回放守卫（毫秒）：会话恢复/重放会把历史事件再发一遍，不该让「在跑」状态跟着回退。 */
const REPLAY_GUARD_MS = 60000
/** 注入正文里单条提示的展示上限（模型侧另受 maxContentChars 限制）。 */
const RENDER_PER_ITEM_MAX = 600

/** 路由注册所需的最小 webServer 形状（结构型约束，避免跨包类型依赖）。 */
interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** `agent/pre-step` 事件负载的结构化最小子集。 */
interface PreStepPayload {
  step?: number
  agent?: unknown
  messages?: readonly unknown[]
  signal?: AbortSignal
}

/** `PreStepDecision` 的结构化最小子集（enter / reject）。 */
interface PreStepDecisionLike {
  kind?: string
  messages?: readonly unknown[]
  [key: string]: unknown
}

/** pre-step 监听器签名。 */
type PreStepHandler = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecisionLike>,
) => Promise<PreStepDecisionLike>

/**
 * 解析 dsh home。
 * @param configured - 配置里的显式值。
 * @returns 绝对路径。
 */
function resolveDshHome(configured: string): string {
  const explicit = configured.trim()
  if (explicit.length > 0) return resolve(explicit.replace(/^~(?=$|[\\/])/, homedir()))
  const env = process.env['DSH_HOME']?.trim()
  if (env !== undefined && env.length > 0) return resolve(env.replace(/^~(?=$|[\\/])/, homedir()))
  return resolve(homedir(), '.dsh')
}

/**
 * 把 unknown 收窄成普通对象。
 * @param value - 待收窄的值。
 * @returns 对象视图；非对象时返回空对象。
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * 读数并夹取到区间；非有限数返回兜底值。
 * @param value - 原始值。
 * @param min - 下界。
 * @param max - 上界。
 * @param fallback - 兜底值。
 * @returns 夹取后的数。
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 从 pre-step 负载里取会话 id（宿主结构，防御式读取）。
 * @param payload - pre-step 负载。
 * @returns 会话标识；取不到返回空串。
 */
function sessionIdOfPayload(payload: unknown): string {
  return sessionIdOfAgent(asRecord(payload)['agent'])
}

/**
 * 从 Agent 对象里取会话 id（payload.agent 与工具 exec.agent 同源）。
 * @param agent - Agent 实例或等价结构。
 * @returns 会话标识；取不到返回空串。
 */
function sessionIdOfAgent(agent: unknown): string {
  const rec = asRecord(agent)
  const session = asRecord(rec['session'])
  for (const key of ['id', 'sessionId', 'name']) {
    const value = session[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  for (const key of ['sessionId', 'id']) {
    const value = rec[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 从 Session 对象里取会话 id（`session/event` 的第一个参数）。
 * @param session - 会话对象。
 * @returns 会话标识；取不到返回空串。
 */
function sessionIdOfSession(session: unknown): string {
  const rec = asRecord(session)
  for (const key of ['id', 'sessionId', 'name']) {
    const value = rec[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 渲染注入给模型的正文。
 * @param items - 本步取走的提示。
 * @returns 注入文本（作为一条 plugin 消息的正文）。
 */
function renderInjection(items: readonly HintItem[]): string {
  const lines = items.map((item, index) => {
    const text = item.content.length > RENDER_PER_ITEM_MAX
      ? `${item.content.slice(0, RENDER_PER_ITEM_MAX)}…（已截断）`
      : item.content
    return `${index + 1}. ${text}`
  })
  return [
    '📌 旁路提示（用户在任务执行过程中插入，不占对话历史，仅本条可见）',
    '请在本步参考下面的要求，然后继续原来的任务；不要停下来等待确认，也不要把它当作新的用户回合。',
    ...lines,
  ].join('\n')
}

/** 一帧 SSE。 */
function sseFrame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * 事件通道：持有 SSE 订阅者。状态变更合并成一帧 `state` 推出去（microtask 级合并），
 * 动作事件（入队 / 被参考 / 撤销）另推一帧 `hint` 供前端弹提示。
 */
class HintHub {
  private readonly clients = new Set<ServerResponse>()

  private readonly beatTimer: NodeJS.Timeout

  private scheduled = false

  private disposed = false

  /**
   * @param store - 队列（快照来源）。
   * @param heartbeatMs - 注释心跳间隔。
   */
  constructor(
    private readonly store: HintStore,
    heartbeatMs: number,
  ) {
    this.beatTimer = setInterval(() => { this.beat() }, clampNumber(heartbeatMs, 5000, 300000, 25000))
    this.beatTimer.unref()
  }

  /** 当前订阅者数量（诊断用）。 */
  get size(): number {
    return this.clients.size
  }

  /** 处理 EVENTS_PATH：握手、投首帧、登记订阅。 */
  open(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, error: '只支持 GET' })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(`: dsh-szg-hint · events\n\nretry: ${SSE_RETRY_MS}\n\n`)
    res.write(sseFrame('state', this.frame()))
    // 断链时 Node 会在响应对象上抛错，没人接就是进程级异常：这里既记账也兜住。
    res.on('error', () => { this.clients.delete(res) })
    res.on('close', () => { this.clients.delete(res) })
    this.clients.add(res)
  }

  /** 删订阅、停心跳（插件卸载/宿主退出时调用）。 */
  dispose(): void {
    this.disposed = true
    clearInterval(this.beatTimer)
    for (const res of this.clients) {
      try {
        res.end()
      } catch {
        // 连接已经断了：end() 的失败就是「已经关掉了」，无需处理。
      }
    }
    this.clients.clear()
  }

  /** 状态变更：合并到同一拍只推一帧。 */
  invalidate(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.disposed || this.clients.size === 0) return
      this.broadcast(sseFrame('state', this.frame()))
    })
  }

  /**
   * 推一帧动作事件（立即，不合并：三次动作就是三次 toast）。
   * @param frame - 动作语义载荷。
   */
  announce(frame: HintEventFrame): void {
    if (this.disposed || this.clients.size === 0) return
    this.broadcast(sseFrame('hint', frame))
  }

  /**
   * 广播一段文本。
   * @param text - 完整帧。
   */
  private broadcast(text: string): void {
    for (const res of this.clients) {
      try {
        res.write(text)
      } catch {
        this.clients.delete(res)
      }
    }
  }

  /** 心跳：注释行不触发客户端事件，只用来探活。 */
  private beat(): void {
    this.broadcast(': ping\n\n')
  }

  /** 一帧的完整载荷（`ok` 与轮询响应同形，浏览器半边只有一条应用路径）。 */
  private frame(): { ok: true } & HintSnapshot {
    return { ok: true, ...this.store.snapshot() }
  }
}

/**
 * 写 JSON 响应。
 * @param res - 响应对象。
 * @param status - 状态码。
 * @param body - 可序列化正文。
 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 读请求体并解析 JSON。
 * @param req - 请求对象。
 * @param maxBytes - 上限；超限按解析失败处理。
 * @returns 解析结果；失败返回 null。
 */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        resolveBody(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolveBody(null)
      }
    })
    req.on('error', () => resolveBody(null))
  })
}

/**
 * 同源校验：浏览器发的跨站表单/脚本 POST 会带外站 Origin，直接拒掉。
 * @param req - 请求对象。
 * @returns 是否同源。
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 处理 PLUGIN_ID 前缀下的全部请求（路径分派）。 */
async function handleHintRequest(
  deps: { store: HintStore; hub: HintHub; maxBodyBytes: number; maxContentChars: number },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path === EVENTS_PATH) {
    deps.hub.open(req, res)
    return
  }
  if (path === STATE_PATH) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, error: '只支持 GET' })
      return
    }
    writeJson(res, 200, { ok: true, ...deps.store.snapshot() })
    return
  }
  if (path === ROUTE_PREFIX) {
    if (req.method === 'POST') {
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
        return
      }
      const body = asRecord(await readJsonBody(req, deps.maxBodyBytes))
      const content = typeof body['text'] === 'string' ? body['text'] : ''
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
      const pushed = deps.store.push(sessionId, content, 'web')
      if (pushed.item === null) {
        writeJson(res, 400, { ok: false, error: '提示内容为空' })
        return
      }
      deps.hub.announce({
        kind: 'added',
        ids: [pushed.item.id],
        sessionId: pushed.item.sessionId,
        text: pushed.item.content.slice(0, 80),
      })
      writeJson(res, 200, {
        ok: true,
        hintId: pushed.item.id,
        running: pushed.running,
        dropped: pushed.dropped,
        maxContentChars: deps.maxContentChars,
      })
      return
    }
    if (req.method === 'DELETE') {
      if (!sameOrigin(req)) {
        writeJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
        return
      }
      const body = asRecord(await readJsonBody(req, deps.maxBodyBytes))
      const id = Math.trunc(clampNumber(body['id'], 0, Number.MAX_SAFE_INTEGER, 0))
      const result = id > 0 ? deps.store.cancel(id) : 'missing'
      if (result === 'missing') {
        writeJson(res, 404, { ok: false, error: '这条提示不存在（可能已被撤销）' })
        return
      }
      if (result === 'consumed') {
        writeJson(res, 409, { ok: false, error: '这条提示 AI 已经参考过了，撤不回来' })
        return
      }
      deps.hub.announce({ kind: 'cancelled', ids: [id], sessionId: '', text: '' })
      writeJson(res, 200, { ok: true, hintId: id })
      return
    }
    writeJson(res, 405, { ok: false, error: '只支持 POST / DELETE' })
    return
  }
  // `/<PLUGIN_ID>/<id>`：撤销的路径形式（curl 调试方便；浏览器半边走 DELETE body）。
  if (path.startsWith(`${ROUTE_PREFIX}/`) && req.method === 'DELETE') {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      return
    }
    const id = Math.trunc(clampNumber(Number(path.slice(ROUTE_PREFIX.length + 1)), 0, Number.MAX_SAFE_INTEGER, 0))
    const result = id > 0 ? deps.store.cancel(id) : 'missing'
    if (result !== 'ok') {
      writeJson(res, result === 'consumed' ? 409 : 404, {
        ok: false,
        error: result === 'consumed' ? '这条提示 AI 已经参考过了，撤不回来' : '这条提示不存在（可能已被撤销）',
      })
      return
    }
    deps.hub.announce({ kind: 'cancelled', ids: [id], sessionId: '', text: '' })
    writeJson(res, 200, { ok: true, hintId: id })
    return
  }
  writeJson(res, 404, { ok: false, error: 'not-found' })
}

/**
 * 注册旁路提示的宿主能力：数据面路由、pre-step 注入、运行态订阅、两个工具。
 * @param ctx - 插件上下文（需已注入 `tools` 与 `webServer`）。
 * @param config - 插件配置（schemastery 已补默认值）。
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Config
  if (!resolved.enabled) return

  const dshHome = resolveDshHome(resolved.dshHome)
  const maxContentChars = Math.trunc(clampNumber(resolved.maxContentChars, 1, 20000, DEFAULT_STORE_OPTIONS.maxContentChars))
  const maxPerStep = Math.trunc(clampNumber(resolved.maxPerStep, 1, 100, DEFAULT_STORE_OPTIONS.maxPendingPerSession))
  const store = new HintStore(dshHome, {
    maxContentChars,
    maxPendingPerSession: Math.trunc(clampNumber(
      resolved.maxPendingPerSession, 1, 200, DEFAULT_STORE_OPTIONS.maxPendingPerSession,
    )),
    keepConsumed: Math.trunc(clampNumber(resolved.keepConsumed, 1, 200, DEFAULT_STORE_OPTIONS.keepConsumed)),
  })
  const hub = new HintHub(store, resolved.heartbeatMs)
  store.onChange = () => { hub.invalidate() }
  ctx.effect(() => () => hub.dispose(), 'szg-hint:hub')

  // ── 数据面路由 ──
  const webServer = ctx.webServer as unknown as WebServerLike | undefined
  if (webServer === undefined) {
    // 硬依赖成立时不该发生；真发生就明说，别再静默退化成「页面有提示栏却全部 404」。
    process.stderr.write('[dsh-szg-hint] webServer 服务缺席，数据面路由未注册\n')
  } else {
    try {
      ctx.effect(() => {
        const dispose = webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => handleHintRequest({
            store,
            hub,
            maxBodyBytes: 64 * 1024,
            maxContentChars,
          }, req, res),
        })
        return () => dispose()
      }, 'szg-hint:routes')
    } catch (error) {
      // 挂路由失败不影响宿主启动：提示是辅助通道，题材缺失时退化成「没有提示栏」。
      process.stderr.write(`[dsh-szg-hint] 路由注册失败：${String(error)}\n`)
    }
  }

  // ── 运行态：哪个会话在跑回合 ──
  // 用会话事件（turn/start / turn/end）而不是工具流水线：这里只要「在跑 / 跑完了」一个布尔量。
  ctx.on('session/event', ((session: unknown, event: unknown) => {
    try {
      const rec = asRecord(event)
      // 回放守卫：恢复/重放会把历史事件再发一遍，不该让「在跑」判断跟着回退。
      const time = typeof rec['time'] === 'number' ? rec['time'] : 0
      if (time > 0 && Date.now() - time > REPLAY_GUARD_MS) return
      const type = typeof rec['type'] === 'string' ? rec['type'] : ''
      if (type !== 'turn/start' && type !== 'turn/end') return
      store.setRunning(sessionIdOfSession(session), type === 'turn/start')
    } catch {
      // 观察者绝不影响会话主流程。
    }
  }) as unknown as never)

  // ── 注入：agent/pre-step 每步检查队列 ──
  // 与记忆插件的逐轮段同一个扩展点，但**不做 step===1 限制**：任务执行中用户随时可能插入
  // 提示，下一步就该看到它，无论那是第几步。无待消费提示时完全不改宿主决策。
  const events = ctx as unknown as { on: (event: string, handler: PreStepHandler) => () => void }
  const preStep: PreStepHandler = async (payload, next) => {
    const decision = await next()
    if (decision === undefined || decision.kind !== 'enter') return decision
    if (payload.signal?.aborted === true) return decision
    const taken = store.consume(sessionIdOfPayload(payload), maxPerStep)
    if (taken.length === 0) return decision
    if (decision.kind === 'reject') {
      // 拒绝 = 这一步不会发出请求（拿不到会话 id 时只取全局）：把它取走就等于永久丢提示。
      // 这里按「注入失败」同一条纪律回滚，绝不出现「标了已参考、模型却没看到」。
      const restored = store.restore(taken.map(item => item.id))
      process.stderr.write(`[dsh-szg-hint] 本步被拒绝，已回滚 ${String(restored)} 条提示待下一步\n`)
      return decision
    }
    let message: unknown
    try {
      const text = renderInjection(taken)
      message = createUserMessage({
        content: [{ type: 'text' as const, text }],
        source: {
          kind: 'plugin' as const,
          plugin: PLUGIN_ID,
          form: 'snapshot' as const,
          sections: [{ name: '旁路提示', text }],
        },
      })
    } catch (error) {
      // 构造失败 = 这一步没能真看到提示：回滚成待消费，下一步重试（绝不静默丢弃）。
      const restored = store.restore(taken.map(item => item.id))
      process.stderr.write(`[dsh-szg-hint] 注入构造失败（已回滚 ${String(restored)} 条）：${String(error)}\n`)
      return decision
    }
    hub.announce({
      kind: 'consumed',
      ids: taken.map(item => item.id),
      sessionId: taken[0]?.sessionId ?? '',
      text: taken[0]?.content.slice(0, 80) ?? '',
    })
    const messages = decision.messages ?? []
    return { ...decision, messages: [...messages, message] }
  }
  ctx.effect(() => events.on('agent/pre-step', preStep), 'szg-hint:pre-step')

  // ── 工具 ──
  try {
    ctx.tools.register(defineTool({
      name: 'hint_send',
      description: '向某个正在执行的会话投递一条提示：该会话在下一步请求里会看到它，用来纠偏方向、'
        + '补充约束、追加要求，而**不打断**它当前的任务（不同于再发一条用户消息）。'
        + '用户说「给它提个醒」「让它换个方向」「补充一句要求」时用它；不传 sessionId 即投给当前会话。',
      parameters: {
        text: { type: 'string', description: '提示正文；会被注入目标会话的下一步请求（超长截断到 2000 字）' },
        sessionId: { type: 'string', description: '目标会话 id；留空 = 当前会话' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => {
        const text = typeof args.text === 'string' ? args.text : ''
        const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        const scope = explicit.length > 0 ? explicit : sessionIdOfAgent(asRecord(exec)['agent'])
        const pushed = store.push(scope, text, 'tool')
        if (pushed.item === null) return Promise.resolve('未投递：text 为空。')
        const where = scope.length > 0 ? `会话 ${scope}` : '全局队列'
        const when = pushed.running ? '该会话正在执行，下一步就会参考到' : '该会话当前不在执行，将在下个任务开始时参考'
        const dropped = pushed.dropped === null ? '' : `（该会话待消费已达上限，挤掉了最旧的一条「${pushed.dropped}」）`
        return Promise.resolve(`已投递到${where}（id=${String(pushed.item.id)}）；${when}。${dropped}`)
      },
    }))

    ctx.tools.register(defineTool({
      name: 'hint_status',
      description: '查看旁路提示队列现状：某会话（或全局）还有哪些提示没被参考、最近参考过哪些。'
        + '想知道「用户有没有在我干活时插话」或确认自己刚投递的提示到没到时用它。',
      parameters: {
        sessionId: { type: 'string', description: '会话 id；留空 = 当前会话，传 `*` = 全部会话' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute: (args, exec) => {
        const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        const all = raw === '*'
        const scope = all ? '' : (raw.length > 0 ? raw : sessionIdOfAgent(asRecord(exec)['agent']))
        const stats = store.stats()
        const lines = [
          `队列：待参考 ${String(stats.pending)} 条 / 已参考 ${String(stats.consumed)} 条（总计 ${String(stats.total)} 条）`,
        ]
        if (all) {
          const snapshot = store.snapshot()
          lines.push(`正在执行的会话：${snapshot.runningSessions.length > 0 ? snapshot.runningSessions.join('、') : '（无）'}`)
          if (snapshot.pending.length === 0) lines.push('当前没有待参考的提示。')
          for (const item of snapshot.pending) {
            lines.push(`  · id=${String(item.id)} [${item.sessionId.length > 0 ? item.sessionId : '全局'}] ${item.content.slice(0, 60)}`)
          }
        } else if (scope.length === 0) {
          lines.push('未指定会话、也取不到当前会话：只能看到全局统计。')
        } else {
          const pending = store.pendingFor(scope)
          lines.push(`会话 ${scope}：${store.isRunning(scope) ? '正在执行' : '不在执行'}`)
          lines.push(pending.length === 0 ? '  没有待参考的提示。' : `  待参考 ${String(pending.length)} 条：`)
          for (const item of pending) {
            lines.push(`    · id=${String(item.id)}${item.sessionId.length === 0 ? '（全局）' : ''} ${item.content.slice(0, 60)}`)
          }
        }
        const recent = store.recentConsumed(5)
        if (recent.length > 0) {
          lines.push('最近被参考的提示：')
          for (const item of recent) lines.push(`  · id=${String(item.id)} ${item.text.slice(0, 60)}`)
        }
        return Promise.resolve(lines.join('\n'))
      },
    }))
  } catch (error) {
    process.stderr.write(`[dsh-szg-hint] 工具注册失败：${String(error)}\n`)
  }
}
