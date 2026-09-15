/**
 * 旁路提示 · 宿主链路（浏览器半边）。
 *
 * 与桌宠链路同构：一条链路把宿主状态送进 React，组件只负责渲染。
 *  - **首选 SSE**（`/dsh-szg-hint/events`）：`state` 帧是完整快照，`hint` 帧是动作语义
 *    （added/consumed/cancelled，toast 用它）。空闲时除注释心跳外没有流量。
 *  - **失败自动降级**：路由缺席（老宿主）、代理干扰、连接被掐，一律退回轮询
 *    `/dsh-szg-hint/state`，并按退避周期尝试回到 SSE。
 *  - **页面不可见时断开**：不占浏览器「每源 6 条连接」的配额，也不在后台空转。
 *
 * 写操作（发提示 / 撤销）也走这条链路，组件因此完全不碰 fetch：它拿到的是
 * `send` / `cancel` 两个回调（`apply` 的 inject 面）。
 *
 * @module dsh-szg-hint/client/link
 */

import type { HintEventFrame, HintSnapshot } from '../protocol.ts'

/** 通道形态：连接中 / SSE / 轮询 / 页面不可见暂停 / 已释放。 */
export type HintTransport = 'connecting' | 'sse' | 'poll' | 'paused' | 'offline'

/** 链路快照（React 读取的不可变值：只有引用变化才算变化）。 */
export interface HintLinkState {
  /** 最近一次宿主快照；从未连上时为 null。 */
  snapshot: HintSnapshot | null
  /** 当前通道。 */
  transport: HintTransport
  /** 最近一次动作事件（去重键是 `event.seq`）：组件据此弹 toast。 */
  event: HintActionEvent | null
}

/** 带本地序号的动作事件（同一帧重复应用不会重复弹提示）。 */
export interface HintActionEvent extends HintEventFrame {
  /** 本地递增序号（每次收到动作帧 +1）。 */
  seq: number
}

/** 写操作结果。 */
export interface HintWriteResult {
  ok: boolean
  /** 失败原因（中文，可直接展示）。 */
  error?: string
  /** 服务端返回的提示 id（发送成功时）。 */
  hintId?: number
}

/** 链路的对外能力面（由 `apply` 交给组件）。 */
export interface HintLink {
  /** 交给 React 的裸 observable（经 inject 的 hooks 隔间绑成 `useHintState`）。 */
  readonly state: {
    getSnapshot(): HintLinkState
    subscribe(listener: () => void): () => void
  }
  /** 发一条提示。 */
  send(text: string, sessionId: string): Promise<HintWriteResult>
  /** 撤销一条待消费的提示。 */
  cancel(id: number): Promise<HintWriteResult>
  /** 释放连接与全部计时器。 */
  dispose(): void
}

/** 与宿主半边同一个路径前缀（`src/index.ts` 的 `ROUTE_PREFIX`），改一处必须两边同步。 */
const QUEUE_URL = '/dsh-szg-hint'
const EVENTS_URL = `${QUEUE_URL}/events`
const STATE_URL = `${QUEUE_URL}/state`
/** SSE 断线后的轮询间隔（降级态：够用即可）。 */
const POLL_FAST_MS = 4000
/** 连续失败多次后的轮询间隔（宿主不在时别刷屏）。 */
const POLL_SLOW_MS = 12000
const POLL_SLOW_AFTER = 4
const SSE_RETRY_MIN_MS = 2000
const SSE_RETRY_MAX_MS = 30000
/** 订阅者归零后延迟多久真正断开：React 严格模式的挂载-卸载-挂载摆动不该断链。 */
const IDLE_STOP_MS = 3000

/**
 * 把 unknown 收窄成普通对象。
 * @param value - 待收窄的值。
 * @returns 对象视图；非对象时返回空对象。
 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * 读一个有限数。
 * @param value - 原始值。
 * @param fallback - 兜底值。
 * @returns 有限数或兜底值。
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 读一个字符串。
 * @param value - 原始值。
 * @param fallback - 兜底值。
 * @returns 字符串或兜底值。
 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 把宿主响应收窄成快照。字段逐个兜底：老宿主的快照缺字段时用中性默认值，绝不整体丢弃。
 *
 * 导出给同包测试直接喂旧形状载荷——「客户端先热更新、宿主后重启」这个中间态的护栏。
 * @param raw - `/dsh-szg-hint/state` 或 SSE `state` 帧的载荷。
 * @returns 快照；不是有效载荷（如 404 的 `ok:false`）时返回 null。
 */
export function normalizeSnapshot(raw: unknown): HintSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = asRecord(raw)
  if (rec['ok'] === false) return null
  const pending = Array.isArray(rec['pending']) ? rec['pending'] : []
  const consumed = Array.isArray(rec['recentConsumed']) ? rec['recentConsumed'] : []
  const stats = asRecord(rec['stats'])
  return {
    now: numberOr(rec['now'], Date.now()),
    // 老宿主没有序号：给 -1 表示「未知」，链路那边就不会拿它去重（否则会永久停在首帧）。
    revision: typeof rec['revision'] === 'number' ? rec['revision'] : -1,
    runningSessions: Array.isArray(rec['runningSessions'])
      ? rec['runningSessions'].filter((value): value is string => typeof value === 'string')
      : [],
    pending: pending.map(item => {
      const row = asRecord(item)
      return {
        id: Math.trunc(numberOr(row['id'], 0)),
        sessionId: stringOr(row['sessionId'], ''),
        content: stringOr(row['content'], ''),
        createdAt: numberOr(row['createdAt'], 0),
      }
    }).filter(item => item.id > 0),
    recentConsumed: consumed.map(item => {
      const row = asRecord(item)
      return {
        id: Math.trunc(numberOr(row['id'], 0)),
        sessionId: stringOr(row['sessionId'], ''),
        text: stringOr(row['text'], ''),
        consumedAt: numberOr(row['consumedAt'], 0),
      }
    }).filter(item => item.id > 0),
    stats: {
      pending: Math.max(0, Math.trunc(numberOr(stats['pending'], 0))),
      consumed: Math.max(0, Math.trunc(numberOr(stats['consumed'], 0))),
      total: Math.max(0, Math.trunc(numberOr(stats['total'], 0))),
    },
    maxContentChars: Math.max(1, Math.trunc(numberOr(rec['maxContentChars'], 2000))),
  }
}

/**
 * 收窄一次动作事件帧。
 * @param raw - SSE `hint` 帧的载荷。
 * @returns 动作事件；形状不合时返回 null。
 */
function normalizeEvent(raw: unknown): HintEventFrame | null {
  const rec = asRecord(raw)
  const kind = stringOr(rec['kind'], '')
  if (kind !== 'added' && kind !== 'consumed' && kind !== 'cancelled') return null
  const ids = Array.isArray(rec['ids'])
    ? rec['ids'].filter((value): value is number => typeof value === 'number')
    : []
  if (ids.length === 0) return null
  return {
    kind,
    ids: ids.map(value => Math.trunc(value)),
    sessionId: stringOr(rec['sessionId'], ''),
    text: stringOr(rec['text'], ''),
  }
}

/**
 * 创建一条宿主链路。生命周期归调用方（客户端插件的 `apply`）：{@link HintLink.dispose}
 * 之后不再重连。
 * @returns 链路能力面。
 */
export function createHintLink(): HintLink {
  const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined'
  const listeners = new Set<() => void>()
  let snapshot: HintSnapshot | null = null
  let event: HintActionEvent | null = null
  let eventSeq = 0
  let mode: HintTransport = 'connecting'
  let state: HintLinkState = { snapshot: null, transport: 'connecting', event: null }
  let running = false
  let disposed = false
  let source: EventSource | null = null
  let pollTimer: number | null = null
  let retryTimer: number | null = null
  let idleTimer: number | null = null
  let retryAttempt = 0
  let pollFailures = 0

  const publish = (): void => {
    if (state.snapshot === snapshot && state.transport === mode && state.event === event) return
    state = { snapshot, transport: mode, event }
    for (const listener of [...listeners]) listener()
  }

  const setMode = (next: HintTransport): void => {
    mode = next
    publish()
  }

  const stopTimers = (): void => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const closeSource = (): void => {
    if (source === null) return
    source.onopen = null
    source.onerror = null
    source.close()
    source = null
  }

  const applySnapshot = (raw: unknown): void => {
    const next = normalizeSnapshot(raw)
    if (next === null) return
    snapshot = next
    publish()
  }

  const applyEvent = (raw: unknown): void => {
    const next = normalizeEvent(raw)
    if (next === null) return
    eventSeq += 1
    event = { ...next, seq: eventSeq }
    publish()
  }

  const startPoll = (intervalMs: number): void => {
    if (disposed || !running || pollTimer !== null) return
    setMode('poll')
    const tick = async (): Promise<void> => {
      try {
        const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        applySnapshot(await response.json())
        pollFailures = 0
      } catch {
        pollFailures += 1
        if (pollFailures === POLL_SLOW_AFTER) {
          if (pollTimer !== null) window.clearInterval(pollTimer)
          pollTimer = null
          startPoll(POLL_SLOW_MS)
        }
      }
    }
    pollTimer = window.setInterval(() => { void tick() }, intervalMs)
    void tick()
  }

  const scheduleSseRetry = (): void => {
    if (disposed || !running || retryTimer !== null) return
    retryAttempt += 1
    const delay = Math.min(SSE_RETRY_MAX_MS, SSE_RETRY_MIN_MS * 2 ** (retryAttempt - 1))
    retryTimer = window.setTimeout(() => {
      retryTimer = null
      if (disposed || !running) return
      if (hasWindow && document.hidden) return
      openSse()
    }, delay)
  }

  function openSse(): void {
    if (disposed || !running) return
    if (hasWindow && document.hidden) {
      setMode('paused')
      return
    }
    if (typeof EventSource !== 'function') {
      startPoll(POLL_FAST_MS)
      return
    }
    closeSource()
    const stream = new EventSource(EVENTS_URL)
    source = stream
    setMode('connecting')
    stream.addEventListener('state', (message: Event) => {
      try {
        applySnapshot(JSON.parse((message as MessageEvent).data as string))
      } catch {
        // 坏帧直接丢：下一帧与轮询兜底都会补上完整状态。
      }
    })
    stream.addEventListener('hint', (message: Event) => {
      try {
        applyEvent(JSON.parse((message as MessageEvent).data as string))
      } catch {
        // 同上：动作帧丢一帧只会少一次 toast，不影响列表。
      }
    })
    stream.onopen = () => {
      retryAttempt = 0
      pollFailures = 0
      if (pollTimer !== null) {
        window.clearInterval(pollTimer)
        pollTimer = null
      }
      setMode('sse')
    }
    stream.onerror = () => {
      // 双通道并存会同时占用连接数，也让「现在走哪条路」不可解释：收回来、轮询顶上、按退避重试。
      closeSource()
      if (disposed || !running) return
      startPoll(POLL_FAST_MS)
      scheduleSseRetry()
    }
  }

  const visibility = (): void => {
    if (!hasWindow || disposed || !running) return
    if (document.hidden) {
      stopTimers()
      closeSource()
      setMode('paused')
      return
    }
    openSse()
  }

  if (hasWindow) document.addEventListener('visibilitychange', visibility)

  const ensureRunning = (): void => {
    if (disposed) return
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer)
      idleTimer = null
    }
    if (running) return
    running = true
    openSse()
  }

  const releaseRunning = (): void => {
    if (disposed || listeners.size > 0 || idleTimer !== null) return
    idleTimer = window.setTimeout(() => {
      idleTimer = null
      if (listeners.size > 0 || disposed) return
      running = false
      stopTimers()
      closeSource()
      setMode('offline')
    }, IDLE_STOP_MS)
  }

  /**
   * 写一次宿主接口（发提示 / 撤销）。
   * @param init - fetch 参数。
   * @param failure - 兜底错误文案。
   * @returns 结果（含服务端给的中文错误）。
   */
  const write = async (init: RequestInit, failure: string): Promise<HintWriteResult> => {
    try {
      const response = await fetch(QUEUE_URL, init)
      const body = asRecord(await response.json().catch(() => ({})))
      if (!response.ok || body['ok'] === false) {
        const error = stringOr(body['error'], '')
        return { ok: false, error: error.length > 0 ? error : `${failure}（HTTP ${String(response.status)}）` }
      }
      const hintId = Math.trunc(numberOr(body['hintId'], 0))
      return hintId > 0 ? { ok: true, hintId } : { ok: true }
    } catch (error) {
      return { ok: false, error: `${failure}：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  return {
    state: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        ensureRunning()
        return () => {
          listeners.delete(listener)
          releaseRunning()
        }
      },
    },
    send: (text: string, sessionId: string) => write({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    }, '发送失败'),
    cancel: (id: number) => write({
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }, '撤销失败'),
    dispose: (): void => {
      disposed = true
      running = false
      stopTimers()
      closeSource()
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer)
        idleTimer = null
      }
      if (hasWindow) document.removeEventListener('visibilitychange', visibility)
      listeners.clear()
    },
  }
}
