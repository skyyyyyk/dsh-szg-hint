/**
 * 旁路提示 · 队列存储（宿主半边）。
 *
 * 迁移自 szg `szg/memory/db.py` 的 `hint_queue`（`push_hint` / `pop_hint` / `peek_hints`）
 * 与 `szg/core/agent.py` 的 `hint_fetcher_fn`，落点从 SQLite 换成 **append-only JSONL**
 * （`$DSH_HOME/dsh-szg-hint/hints.jsonl`）：提示是低频小数据，一个文件就够，也不必为它引入库。
 *
 * 三条与源侧一致的语义：
 *  - **原子消费**：`consume()` 在一次同步调用里挑出并标记 `consumed`，中途没有 await，
 *    Node 单线程下不可能被别的步骤重复取走（源侧靠事务 SELECT+UPDATE 达到同一效果）。
 *  - **作用域**：提示属于某个会话，或者属于全局（`sessionId === ''`）。取的时候两者都算，
 *    最旧优先；因此「用户发提示时会话换了」也不会把提示丢在队列里。
 *  - **不污染主历史**：提示只存在于这里，随模型请求注入一次即完成使命。
 *
 * 一条有意收紧的差异：源侧 `pop_hint('')` 会在拿不到会话 id 时取**任意**会话的待消费提示；
 * 这里改为只取全局提示（`sessionId === ''`）——「拿不到归属」不等于「可以把别人的提示喂给
 * 这个会话」，宁可让它等下一轮。
 *
 * @module dsh-szg-hint/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  HintConsumedView,
  HintImageRef,
  HintItem,
  HintPendingView,
  HintPushResult,
  HintSnapshot,
} from './protocol.ts'

/** 存储参数。 */
export interface HintStoreOptions {
  /** 单条正文上限（码点，超出截断）。 */
  maxContentChars: number
  /** 单个会话的待消费提示上限（超出挤掉最旧一条，并在结果里报告）。 */
  maxPendingPerSession: number
  /** 快照里保留的最近已消费条数（也是压缩时保留的条数）。 */
  keepConsumed: number
  /** 待消费列表在快照里的条数上限（统计仍按全量算）。 */
  snapshotPendingMax: number
  /** JSONL 行数超过它时压缩重写（只留待消费 + 最近已消费）。 */
  compactThreshold: number
}

/** 缺省参数（部署可用 cordis 配置覆盖）。 */
export const DEFAULT_STORE_OPTIONS: HintStoreOptions = {
  maxContentChars: 2000,
  maxPendingPerSession: 20,
  keepConsumed: 20,
  snapshotPendingMax: 50,
  compactThreshold: 2000,
}

/** 落盘的一行（append-only 事件流，回放即得当前状态）。 */
type HintLogLine =
  | { op: 'put'; item: HintItem }
  | { op: 'del'; id: number }

/**
 * 把一行日志里的条目收窄成当前形状。
 *
 * 老日志（本插件还没有图片能力时写的行）没有 `images` 字段，直接读会让下游到处判 undefined；
 * 这里统一补成空数组，**只做形状补齐、不做业务判断**：坏字段一律当「没有」。
 * @param raw - 日志里反序列化出来的条目。
 * @returns 补全后的条目；`id` 不合法时返回 null（该行作废）。
 */
function reviveItem(raw: unknown): HintItem | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const id = rec['id']
  if (typeof id !== 'number' || !Number.isFinite(id)) return null
  const images = Array.isArray(rec['images'])
    ? rec['images'].filter((value): value is HintImageRef => {
      const image = value as Record<string, unknown> | null
      return typeof image === 'object' && image !== null
        && typeof image['attachmentId'] === 'string' && image['attachmentId'].length > 0
        && typeof image['mediaType'] === 'string'
    })
    : []
  return {
    id,
    sessionId: typeof rec['sessionId'] === 'string' ? rec['sessionId'] : '',
    content: typeof rec['content'] === 'string' ? rec['content'] : '',
    images,
    meta: typeof rec['meta'] === 'string' ? rec['meta'] : '',
    status: rec['status'] === 'consumed' ? 'consumed' : 'pending',
    createdAt: typeof rec['createdAt'] === 'number' ? rec['createdAt'] : 0,
    consumedAt: typeof rec['consumedAt'] === 'number' ? rec['consumedAt'] : null,
  }
}

/**
 * 一条提示的一句话摘要（列表、回执、`dropped` 报告共用）。
 * @param item - 条目或其投影。
 * @returns 正文前 40 字；纯图提示给「（图片 ×N）」。
 */
export function summarizeHint(item: { content: string, images?: readonly HintImageRef[] }): string {
  const text = item.content.trim()
  if (text.length > 0) return text.slice(0, 40)
  const count = item.images?.length ?? 0
  return count > 0 ? `（图片 ×${String(count)}）` : ''
}


/**
 * 旁路提示队列。
 *
 * 内存态是唯一读写面（路由、pre-step 注入、工具都走它），磁盘只是它的重放日志：
 * 每次变更追加一行，启动时按顺序回放。`consumed` 因此能跨宿主重启保持——
 * 重启后不会把「模型已经看过的提示」再灌一遍。
 */
export class HintStore {
  private readonly items = new Map<number, HintItem>()

  private readonly running = new Set<string>()

  private readonly options: HintStoreOptions

  private readonly file: string

  private nextId = 1

  private revision = 0

  private logLines = 0

  private writeFailures = 0

  /** 任何状态变更后的通知（事件通道据此合并推送）。 */
  onChange: () => void = () => {}

  /**
   * @param dshHome - dsh home 绝对路径（数据落 `${dshHome}/dsh-szg-hint/hints.jsonl`）。
   * @param options - 存储参数（缺省见 {@link DEFAULT_STORE_OPTIONS}）。
   */
  constructor(dshHome: string, options: Partial<HintStoreOptions> = {}) {
    this.options = { ...DEFAULT_STORE_OPTIONS, ...options }
    this.file = `${dshHome}/dsh-szg-hint/hints.jsonl`.replace(/\\/g, '/')
    this.load()
  }

  /** 数据文件绝对路径（诊断用）。 */
  get path(): string {
    return this.file
  }

  /** 落盘失败次数（诊断用：失败只记日志，功能继续按内存态跑）。 */
  get failures(): number {
    return this.writeFailures
  }

  /**
   * 读一次磁盘上的日志并重建内存态。
   *
   * 坏行直接跳过：提示是辅助信息，绝不为一行坏数据拖垮宿主启动。
   */
  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const text = readFileSync(this.file, 'utf8')
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        this.logLines += 1
        try {
          const parsed = JSON.parse(trimmed) as HintLogLine
          if (parsed.op === 'del') {
            this.items.delete(parsed.id)
            continue
          }
          if (parsed.op === 'put') {
            const item = reviveItem(parsed.item)
            if (item !== null) {
              this.items.set(item.id, item)
              if (item.id >= this.nextId) this.nextId = item.id + 1
            }
          }
        } catch {
          // 坏行（截断写入/手工改坏）：跳过即可，后面每次变更都会追加新行。
        }
      }
      this.revision = 1
    } catch (error) {
      process.stderr.write(`[dsh-szg-hint] 队列日志读取失败（按空队列继续）：${String(error)}\n`)
    }
  }

  /**
   * 追加一行日志；失败只记一次日志并计数，不影响内存态。
   * @param line - 待追加的事件行。
   */
  private append(line: HintLogLine): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, `${JSON.stringify(line)}\n`, 'utf8')
      this.logLines += 1
      if (this.logLines > this.options.compactThreshold) this.compact()
    } catch (error) {
      this.writeFailures += 1
      if (this.writeFailures === 1) {
        process.stderr.write(`[dsh-szg-hint] 队列日志写入失败（内存态继续）：${String(error)}\n`)
      }
    }
  }

  /** 压缩：把当前状态重写成全量日志（只保留待消费 + 最近若干条已消费）。 */
  private compact(): void {
    try {
      const keep = this.retained()
      const lines = keep.map(item => JSON.stringify({ op: 'put', item } satisfies HintLogLine))
      writeFileSync(this.file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
      for (const item of [...this.items.values()]) {
        if (!keep.some(kept => kept.id === item.id)) this.items.delete(item.id)
      }
      this.logLines = keep.length
    } catch (error) {
      this.writeFailures += 1
      process.stderr.write(`[dsh-szg-hint] 队列压缩失败（保持原文件）：${String(error)}\n`)
    }
  }

  /** 压缩时要保留的条目：全部待消费 + 最近 N 条已消费（按 id 降序取）。 */
  private retained(): HintItem[] {
    const pending = [...this.items.values()].filter(item => item.status === 'pending')
    const consumed = [...this.items.values()]
      .filter(item => item.status === 'consumed')
      .sort((left, right) => right.id - left.id)
      .slice(0, this.options.keepConsumed)
    return [...pending, ...consumed].sort((left, right) => left.id - right.id)
  }

  /** 记一次变更并通知事件通道。 */
  private touch(): void {
    this.revision += 1
    this.onChange()
  }

  /**
   * 入队一条提示。
   *
   * **正文与附图至少要有一样**：纯图提示（只发一张截图、不打字）是合法输入，
   * 此时正文存空串，注入时渲染成「（无文字说明，见附图）」，模型不会看到一条空气泡。
   * @param sessionId - 归属会话；空串 = 全局。
   * @param content - 提示正文；与 `images` 同时为空时拒绝入队。
   * @param meta - 来源标记（如 `web` / `tool`）。
   * @param images - 已落库的图片引用（准入与限额在路由层完成）。
   * @returns 入队结果（正文与附图都为空时 `item` 为 null）。
   */
  push(sessionId: string, content: string, meta: string, images: readonly HintImageRef[] = []): HintPushResult {
    const text = (content ?? '').trim().slice(0, this.options.maxContentChars)
    const refs = images.map(image => ({ ...image }))
    if (text.length === 0 && refs.length === 0) {
      return { item: null, running: this.isRunning(sessionId), dropped: null }
    }
    const scope = String(sessionId ?? '')
    let dropped: string | null = null
    const own = [...this.items.values()]
      .filter(item => item.status === 'pending' && item.sessionId === scope)
    if (own.length >= this.options.maxPendingPerSession) {
      const oldest = own.sort((left, right) => left.id - right.id)[0]
      if (oldest !== undefined) {
        dropped = summarizeHint(oldest)
        this.items.delete(oldest.id)
        this.append({ op: 'del', id: oldest.id })
      }
    }
    const item: HintItem = {
      id: this.nextId,
      sessionId: scope,
      content: text,
      images: refs,
      meta: (meta ?? '').slice(0, 200),
      status: 'pending',
      createdAt: Date.now(),
      consumedAt: null,
    }
    this.nextId += 1
    this.items.set(item.id, item)
    this.append({ op: 'put', item })
    this.touch()
    return { item: { ...item }, running: this.isRunning(scope), dropped }
  }

  /**
   * 原子取走该会话（含全局）最旧的若干条待消费提示，并标记为已消费。
   *
   * 同步执行、中途无 await：与源侧的事务 SELECT+UPDATE 等价，不会重复消费。
   * @param sessionId - 会话 id；空串只取全局提示（见模块说明）。
   * @param limit - 单次最多消费条数（<=0 视为不消费）。
   * @returns 被取走的提示（快照副本，调用方可安全序列化）。
   */
  consume(sessionId: string, limit: number): HintItem[] {
    const take = Math.max(0, Math.floor(limit))
    if (take === 0) return []
    const picked = this.pickPending(sessionId, take)
    if (picked.length === 0) return []
    const now = Date.now()
    for (const item of picked) {
      const stored = this.items.get(item.id)
      if (stored === undefined) continue
      stored.status = 'consumed'
      stored.consumedAt = now
      this.append({ op: 'put', item: stored })
    }
    this.touch()
    return picked.map(item => ({ ...item, status: 'consumed' as const, consumedAt: now }))
  }

  /**
   * 注入失败时回滚：把刚消费的条目标回待消费，让下一步再取。
   * @param ids - 要回滚的提示 id。
   * @returns 实际回滚的条数。
   */
  restore(ids: readonly number[]): number {
    let restored = 0
    for (const id of ids) {
      const item = this.items.get(id)
      if (item === undefined || item.status !== 'consumed') continue
      item.status = 'pending'
      item.consumedAt = null
      this.append({ op: 'put', item })
      restored += 1
    }
    if (restored > 0) this.touch()
    return restored
  }

  /**
   * 撤销一条仍待消费的提示。
   * @param id - 提示 id。
   * @returns `ok` 已撤销（附条目快照，供回执按真实会话归属广播）；
   *   `consumed` 已被参考（不可撤销）；`missing` 不存在。
   */
  cancel(id: number): { status: 'ok', entry: HintItem } | { status: 'consumed' } | { status: 'missing' } {
    const item = this.items.get(id)
    if (item === undefined) return { status: 'missing' }
    if (item.status !== 'pending') return { status: 'consumed' }
    const entry = { ...item }
    this.items.delete(id)
    this.append({ op: 'del', id })
    this.touch()
    return { status: 'ok', entry }
  }

  /**
   * 挑选待消费提示（不改状态）。
   * @param sessionId - 会话 id；空串只取全局。
   * @param limit - 条数上限。
   * @returns 最旧优先的条目引用。
   */
  private pickPending(sessionId: string, limit: number): HintItem[] {
    const scope = String(sessionId ?? '')
    const matches = [...this.items.values()]
      .filter(item => item.status === 'pending'
        && (scope.length === 0 ? item.sessionId.length === 0 : item.sessionId === scope || item.sessionId.length === 0))
      .sort((left, right) => left.id - right.id)
    return matches.slice(0, limit)
  }

  /**
   * 记一次回合运行态（`turn/start` / `turn/end` 驱动）。
   * @param sessionId - 会话 id。
   * @param running - 是否在跑。
   * @returns 状态是否真的变了（没变就不必推帧）。
   */
  setRunning(sessionId: string, running: boolean): boolean {
    if (sessionId.length === 0) return false
    const changed = running ? !this.running.has(sessionId) : this.running.delete(sessionId)
    if (running) this.running.add(sessionId)
    if (changed) this.touch()
    return changed
  }

  /**
   * 该会话是否在跑回合。
   * @param sessionId - 会话 id；空串恒为 false（无从判断）。
   * @returns 是否在跑。
   */
  isRunning(sessionId: string): boolean {
    return sessionId.length > 0 && this.running.has(sessionId)
  }

  /**
   * 某会话（含全局）的待消费提示。
   * @param sessionId - 会话 id；空串只列全局。
   * @returns 待消费条目副本。
   */
  pendingFor(sessionId: string): HintItem[] {
    return this.pickPending(sessionId, Number.MAX_SAFE_INTEGER).map(item => ({ ...item }))
  }

  /**
   * 某条提示的第 n 张附图（图片路由按 id + 序号取图，**不按 attachmentId 暴露**：
   * 否则这个路由就变成了「按内容哈希读附件库」的通用出口）。
   * @param id - 提示 id。
   * @param index - 图序号（从 0 开始）。
   * @returns 图片引用；条目不存在或序号越界返回 undefined。
   */
  imageAt(id: number, index: number): HintImageRef | undefined {
    const item = this.items.get(id)
    if (item === undefined) return undefined
    return item.images[index]
  }

  /**
   * 最近的已消费提示。
   * @param limit - 条数上限。
   * @returns 最新的在前。
   */
  recentConsumed(limit: number): HintConsumedView[] {
    return [...this.items.values()]
      .filter(item => item.status === 'consumed' && item.consumedAt !== null)
      .sort((left, right) => (right.consumedAt ?? 0) - (left.consumedAt ?? 0) || right.id - left.id)
      .slice(0, Math.max(0, limit))
      .map(item => ({
        id: item.id,
        sessionId: item.sessionId,
        text: item.content.slice(0, 80),
        imageCount: item.images.length,
        consumedAt: item.consumedAt ?? 0,
      }))
  }

  /** 队列统计（全量口径）。 */
  stats(): { pending: number; consumed: number; total: number } {
    let pending = 0
    let consumed = 0
    for (const item of this.items.values()) {
      if (item.status === 'pending') pending += 1
      else consumed += 1
    }
    return { pending, consumed, total: pending + consumed }
  }

  /**
   * 当前全量快照。
   *
   * `imageLimits` 不在队列里（它属于插件配置），由调用方在组装快照时补上；
   * 这里给一个「未启用」的保守默认，保证任何调用路径拿到的对象都是完整形状。
   * @returns 快照（SSE 帧与轮询响应同形）。
   */
  snapshot(imageLimits: HintSnapshot['imageLimits'] = DISABLED_IMAGE_LIMITS): HintSnapshot {
    const pending: HintPendingView[] = [...this.items.values()]
      .filter(item => item.status === 'pending')
      .sort((left, right) => left.id - right.id)
      .slice(0, this.options.snapshotPendingMax)
      .map(item => ({
        id: item.id,
        sessionId: item.sessionId,
        content: item.content,
        images: item.images.map(image => ({ ...image })),
        createdAt: item.createdAt,
      }))
    return {
      now: Date.now(),
      revision: this.revision,
      runningSessions: [...this.running].sort(),
      pending,
      recentConsumed: this.recentConsumed(this.options.keepConsumed),
      stats: this.stats(),
      maxContentChars: this.options.maxContentChars,
      imageLimits,
    }
  }
}

/** 附件服务缺席时的图片限额（前端据此隐藏附图入口）。 */
export const DISABLED_IMAGE_LIMITS: HintSnapshot['imageLimits'] = {
  enabled: false,
  maxImages: 0,
  maxImageBytes: 0,
  maxTotalBytes: 0,
  mediaTypes: [],
}
