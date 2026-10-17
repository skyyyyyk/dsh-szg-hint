/**
 * 时之光旁路提示 · 宿主半边（`dsh-szg-hint`）。
 *
 * 迁移自 szg 的「提示干预」（`szg/gui/server.py` 的 `/api/chat/hint`、
 * `szg/memory/db.py` 的 `hint_queue`、`szg/core/agent.py` 的 `hint_fetcher_fn`）：
 * 用户在执行任务的过程中插一句话，AI 下一步就参考到，任务不被打断、主对话历史不被污染。
 * dsh 侧的落点是四个现成扩展点：
 *
 * - **队列 + 数据面**：{@link HintStore}（JSONL 落盘，见 `./store.ts`）与 `/dsh-szg-hint/*`
 *   （SSE `state`/`hint` 帧 + 轮询兜底 + 写入 + 撤销 + 取图）。
 * - **注入**：`agent/pre-step` waterfall——与记忆插件的逐轮段同一个扩展点，但**每一步都
 *   检查**（任务跑着的时候用户随时可能发提示，不像「本轮提问」只在首步有意义）。提示作为
 *   一条 `plugin` 来源的 user 消息追加进本步；注入成功即标记 consumed 并推 `hint` 事件帧
 *   （前端据此弹「AI 已参考」）。构造消息失败会**回滚成待消费**，下一步重试。
 * - **运行态**：订阅 `session/event` 的 `turn/start` / `turn/end`，按会话记录「是否在跑
 *   回合」——前端据此选文案（「下一步参考」还是「排队等下个任务」）。
 * - **工具**：`hint_send`（模型也能投递提示，默认落到自己所在的会话，可带本机图片）、
 *   `hint_status`。
 *
 * ## 图片提示（2026-10-15 增补）
 *
 * 用户可以在提示里附图（粘贴截图 / 拖入 / 选文件）。四段链路各归其位：
 *
 * 1. **上行**：浏览器把图压到限额内、以 base64 放进 `POST /dsh-szg-hint` 的 `images`；
 * 2. **入库**：宿主交给附件服务（`ctx.attachments.saveImages`）落成内容寻址的不可变引用，
 *    队列里只存引用——JSONL 因此始终很小，且重启后仍能读回字节；
 * 3. **注入**：`pre-step` 把引用还原成 image 内容块，与正文同一条 plugin 消息进本步请求；
 * 4. **回显**：`GET /dsh-szg-hint/image/<id>/<index>` 按「提示 id + 序号」回吐字节（不按
 *    attachmentId 暴露，避免把这个路由变成读附件库的通用出口），前端据此画待参考缩略图。
 *
 * 一条**能力兜底**：若本步路由的模型不吃图（`inputModalities` 不含 image），核心会把图片
 * 投影成 `[image omitted …]` 占位文字；那样模型知道有图却看不到。所以这里先问一次
 * `ctx.llm.resolveModelInfo`，明确「看不到」时把本机只读副本路径写进正文，让 agent 能用
 * `vision_analyze` / `read_image` 去读它。问不出来（服务缺席/解析失败）时按「能看」处理：
 * 加路径反而会给正常路径添噪音。
 *
 * @module dsh-szg-hint
 */

import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  describeImage,
  formatBytes,
  HINT_IMAGE_MEDIA_TYPES,
  mediaTypeForPath,
  parseImageUploads,
} from './images.ts'
import type {
  HintEventFrame,
  HintImageLimits,
  HintImageRef,
  HintImageUpload,
  HintItem,
  HintSnapshot,
} from './protocol.ts'
import { DEFAULT_STORE_OPTIONS, HintStore, summarizeHint } from './store.ts'

/** 插件 id（loader 诊断、路由前缀与产物质检共用；必须等于包名）。 */
const PLUGIN_ID = 'dsh-szg-hint'

/** Cordis 插件名（loader 诊断用）。 */
export const name = PLUGIN_ID

/**
 * v4 来源准入的**类型侧**声明：外部生产者必须用 `plugin:<名>` 命名空间。
 *
 * 运行时靠会话的 `source.kind` 字符串判定；类型侧则要求生产者自己在 `MessageSourceMap` 上
 * 声明这一行，否则 `createUserMessage` 的 `source` 参数过不了类型检查（本插件此前正是靠
 * 运行时能跑而把这条类型错误挂着——补上它，构建与编辑器都不再报红）。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-szg-hint': { kind: 'plugin:dsh-szg-hint' } & ContextFormed
  }
}

/**
 * 硬依赖：`tools` 用于注册提示工具，`webServer` 用于挂数据面路由。
 *
 * ★`webServer` 必须是硬依赖而不是 `ctx.get()` 软获取：宿主服务在插件 apply 之后才挂载，
 * 软获取会拿到 undefined 并**静默跳过**路由注册（症状 = 页面有提示栏却全部 404）。
 * 这是桌宠插件实测踩过的一条。
 *
 * `attachments` 有意**不进**这份硬依赖：它是图片提示才需要的服务，缺席时插件应照常提供
 * 纯文字提示（快照里 `imageLimits.enabled = false`，前端隐藏附图入口），而不是整个加载失败。
 */
export const inject = ['tools', 'webServer', 'connection']

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
  /** 单条提示最多几张附图。 */
  maxImagesPerHint: number
  /** 单张附图的最大编码字节数。 */
  maxImageBytes: number
  /** 单条提示所有附图的合计字节上限。 */
  maxTotalImageBytes: number
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
  maxImagesPerHint: z.number().default(3),
  maxImageBytes: z.number().default(4 * 1024 * 1024),
  maxTotalImageBytes: z.number().default(12 * 1024 * 1024),
})

const ROUTE_PREFIX = `/${PLUGIN_ID}`
const EVENTS_PATH = `${ROUTE_PREFIX}/events`
const STATE_PATH = `${ROUTE_PREFIX}/state`
const IMAGE_PATH_PREFIX = `${ROUTE_PREFIX}/image/`
/** 断线后浏览器半边的重连建议（毫秒）。 */
const SSE_RETRY_MS = 3000
/** 回放守卫（毫秒）：会话恢复/重放会把历史事件再发一遍，不该让「在跑」状态跟着回退。 */
const REPLAY_GUARD_MS = 60000
/** 注入正文里单条提示的展示上限（模型侧另受 maxContentChars 限制）。 */
const RENDER_PER_ITEM_MAX = 600
/** 附件服务缺席时的图片限额（前端据此隐藏附图入口）。 */
const DISABLED_IMAGE_LIMITS: HintImageLimits = {
  enabled: false,
  maxImages: 0,
  maxImageBytes: 0,
  maxTotalBytes: 0,
  mediaTypes: [],
}

/**
 * 附件服务在场时的图片限额（配置值 + 服务能力共同决定）。
 * @param limits - 已 clamp 的三条配置值。
 * @returns 快照里下发给前端的限额。
 */
function enabledImageLimits(limits: {
  maxImages: number
  maxImageBytes: number
  maxTotalBytes: number
}): HintImageLimits {
  return {
    enabled: true,
    maxImages: limits.maxImages,
    maxImageBytes: limits.maxImageBytes,
    maxTotalBytes: limits.maxTotalBytes,
    mediaTypes: [...HINT_IMAGE_MEDIA_TYPES],
  }
}

/** 路由注册所需的最小 webServer 形状（结构型约束，避免跨包类型依赖）。 */
interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 连接信任围栏的最小形状（`connection` 服务的 requestRejection）。 */
interface ConnectionLike {
  /**
   * 判一次请求是否该被拒。
   * @param request - 请求（只读 headers）。
   * @returns 403=Host 不受信 / 401=浏览器未认证 / undefined=放行。
   */
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/**
 * 附件服务的最小形状（结构型约束，避免跨包类型依赖）。
 *
 * 只声明本插件真的会用的三件事：批量落库、按引用读回、给出本机只读路径。
 * 归一化（尺寸/像素/字节上限、重编码）全部由服务实现负责——插件不自建图片存储，
 * 也不重复实现一套压缩逻辑。
 */
interface AttachmentStoreLike {
  /**
   * 校验并落库一批图片（同一批要么全成、要么全不成）。
   * @param inputs - 解码后的字节、媒体类型与可选展示名（按用户选择顺序）。
   * @returns 不可变引用，顺序与入参一致。
   */
  saveImages(inputs: readonly {
    data: Uint8Array
    mediaType: string
    name?: string
  }[]): Promise<readonly HintImageRef[]>
  /**
   * 按引用读回字节（并校验字节仍与引用一致）。
   * @param ref - 队列里的图片引用。
   * @returns 校验通过的引用与字节。
   */
  readImage(ref: HintImageRef): Promise<{ ref: HintImageRef, data: Uint8Array }>
  /**
   * 给出该图在本机的只读副本路径（文本-only 路由的兜底通道）。
   * @param ref - 队列里的图片引用。
   * @returns 绝对路径；后端不是宿主文件存储时返回 undefined。
   */
  imageHostPath(ref: HintImageRef): string | undefined
}

/** LLM 服务的最小形状（只用来问「这一步的模型吃不吃图」）。 */
interface LlmLike {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>
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
 * 从 Agent 对象里取本步的路由（provider/model）。
 *
 * 与官方 `read_image` 的解析口径一致：会话请求头里的 config 优先，其次 agent.options。
 * 两者都取不到就返回空串——调用方据此判「问不出来」，不猜。
 * @param agent - Agent 实例或等价结构。
 * @returns provider 与 model（取不到为空串）。
 */
function routeOfAgent(agent: unknown): { provider: string, model: string } {
  const rec = asRecord(agent)
  const session = asRecord(rec['session'])
  let config: Record<string, unknown> = {}
  const requestHeader = session['requestHeader']
  if (typeof requestHeader === 'function') {
    try {
      config = asRecord(asRecord(requestHeader.call(session))['config'])
    } catch {
      config = {}
    }
  }
  const options = asRecord(rec['options'])
  const pick = (key: string): string => {
    const fromHeader = config[key]
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
    const fromOptions = options[key]
    return typeof fromOptions === 'string' ? fromOptions : ''
  }
  return { provider: pick('provider'), model: pick('model') }
}

/**
 * 问一次「本步的模型吃不吃图」。
 * @param ctx - 插件上下文（软取 `llm` 服务）。
 * @param agent - 本步的 Agent。
 * @param signal - 本步的中断信号。
 * @returns `true` 能吃图 / `false` 明确只吃文字 / `undefined` 问不出来（按能吃图处理）。
 */
async function routeSeesImages(
  ctx: Context,
  agent: unknown,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  // ★必须用 `ctx.get()`：`llm` 不在 inject 里，属性取值（含 `Reflect.get`）在真实 cordis 里
  // 会抛 `cannot get property "llm" without inject`（见 apply 里 attachments 那条的详细注释）。
  const llm = ctx.get('llm') as unknown as LlmLike | undefined
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return undefined
  const route = routeOfAgent(agent)
  if (route.provider.length === 0 || route.model.length === 0) return undefined
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, signal)
    return info.inputModalities?.includes('image')
  } catch {
    // 解析失败（适配器不可达 / 目录没这条）不该影响这一步：按「未知」处理，照常附图。
    return undefined
  }
}

/**
 * 把队列里的图片引用还原成模型内容块。
 *
 * 需要一次显式转换：附件服务里的 `attachmentId` 是品牌化的字符串类型，而队列是跨进程
 * 持久化的普通 JSON——存的就是字符串本身，这里放行这一个窄转换（形状其余部分逐字段一致）。
 * @param image - 队列里的图片引用。
 * @returns image 内容块。
 */
function imageBlock(image: HintImageRef): ContentBlock {
  return { type: 'image', attachment: image } as unknown as ContentBlock
}

/**
 * 渲染注入给模型的内容块。
 *
 * 形态：**一条正文块 + 若干 image 块**。正文里按「1. / 2.」编号提示，附图在各自提示下面
 * 以「附图 k：名字（尺寸、类型、大小）」列出，k 是全局序号——与后面 image 块的顺序一一对应，
 * 模型据此知道哪张图属于哪条提示。图片块统一排在正文之后（与官方 `read_image` 的
 * 「文本信封 + 相邻 image 块」同一形态，适配器侧也最省事）。
 *
 * @param items - 本步取走的提示。
 * @param pathOf - 取某张图的本机只读路径（文本-only 路由才给；其他情况恒返回 undefined）。
 * @returns 内容块与本步附图总数。
 */
function renderInjection(
  items: readonly HintItem[],
  pathOf: (image: HintImageRef) => string | undefined,
): { blocks: ContentBlock[], imageCount: number } {
  const lines = [
    '📌 旁路提示（用户在任务执行过程中插入，不占对话历史，仅本条可见）',
    '请在本步参考下面的要求，然后继续原来的任务；不要停下来等待确认，也不要把它当作新的用户回合。',
  ]
  const images: HintImageRef[] = []
  for (const [index, item] of items.entries()) {
    const text = item.content.length > RENDER_PER_ITEM_MAX
      ? `${item.content.slice(0, RENDER_PER_ITEM_MAX)}…（已截断）`
      : item.content
    lines.push(`${String(index + 1)}. ${text.length > 0 ? text : '（无文字说明，见附图）'}`)
    for (const image of item.images) {
      images.push(image)
      const path = pathOf(image)
      const suffix = path === undefined
        ? ''
        : `；本步模型不接受图片输入，请用 vision_analyze / read_image 读这个只读副本：${path}`
      lines.push(`   ${describeImage(images.length, image)}${suffix}`)
    }
  }
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const image of images) blocks.push(imageBlock(image))
  return { blocks, imageCount: images.length }
}

/**
 * 把浏览器上行的图片落库成不可变引用。
 *
 * 先解 base64 再交给附件服务：`saveImages` 是**整批**语义（要么全成、要么全不成），
 * 所以这里不需要「部分成功」的清理逻辑；失败时队列一个字都不会写。
 * @param attachments - 附件服务；缺席时直接拒绝（前端据快照里的限额根本不会走到这里）。
 * @param uploads - 已过结构校验的上行清单。
 * @returns 引用清单，或中文失败原因。
 */
async function admitImages(
  attachments: AttachmentStoreLike | undefined,
  uploads: readonly HintImageUpload[],
): Promise<{ ok: true, refs: HintImageRef[] } | { ok: false, error: string }> {
  if (uploads.length === 0) return { ok: true, refs: [] }
  if (attachments === undefined) {
    return { ok: false, error: '宿主没有挂载附件服务，暂时不支持图片提示' }
  }
  try {
    const refs = await attachments.saveImages(uploads.map(upload => ({
      data: Buffer.from(upload.data, 'base64'),
      mediaType: upload.mediaType,
      ...upload.name === undefined ? {} : { name: upload.name },
    })))
    return { ok: true, refs: refs.map(ref => ({ ...ref })) }
  } catch (error) {
    return { ok: false, error: `图片入库失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 取某张图在本机的只读副本路径（拿不到就算了，绝不因为路径解析失败影响注入）。
 * @param attachments - 附件服务。
 * @param image - 图片引用。
 * @returns 绝对路径或 undefined。
 */
function safeImageHostPath(attachments: AttachmentStoreLike | undefined, image: HintImageRef): string | undefined {
  if (attachments === undefined) return undefined
  try {
    return attachments.imageHostPath(image)
  } catch {
    return undefined
  }
}

/**
 * 把模型给出的**本机图片路径**读成附件引用（`hint_send` 用）。
 *
 * 三道闸：后缀必须在白名单里、先 `stat` 看大小再读（不把超大文件读进内存）、
 * 合计字节不超上限。读文件与 `read` 工具是同一信任级别（都在 danger-full-access 的
 * 会话里由模型发起），这里只多做「这是不是一张能收的图」的判断。
 * @param attachments - 附件服务。
 * @param paths - 本机路径清单（已去空）。
 * @param limits - 当前限额。
 * @returns 引用清单，或中文失败原因。
 */
async function admitLocalImages(
  attachments: AttachmentStoreLike | undefined,
  paths: readonly string[],
  limits: HintImageLimits,
): Promise<{ ok: true, refs: HintImageRef[] } | { ok: false, error: string }> {
  if (paths.length === 0) return { ok: true, refs: [] }
  if (attachments === undefined) return { ok: false, error: '宿主没有挂载附件服务，暂时不支持图片提示' }
  if (paths.length > limits.maxImages) {
    return { ok: false, error: `最多带 ${String(limits.maxImages)} 张图（收到 ${String(paths.length)} 张）` }
  }
  const inputs: { data: Uint8Array, mediaType: string, name?: string }[] = []
  let total = 0
  for (const rawPath of paths) {
    const mediaType = mediaTypeForPath(rawPath)
    if (mediaType === undefined) {
      return { ok: false, error: `「${rawPath}」不是支持的图片后缀（png / jpg / jpeg / webp / gif）` }
    }
    if (!limits.mediaTypes.includes(mediaType)) {
      return { ok: false, error: `当前部署不接受 ${mediaType} 图片` }
    }
    let size: number
    try {
      const info = await stat(rawPath)
      if (!info.isFile()) return { ok: false, error: `「${rawPath}」不是文件` }
      size = info.size
    } catch (error) {
      return { ok: false, error: `读不到「${rawPath}」：${error instanceof Error ? error.message : String(error)}` }
    }
    if (size > limits.maxImageBytes) {
      return { ok: false, error: `「${rawPath}」${formatBytes(size)}，超过单张上限 ${formatBytes(limits.maxImageBytes)}` }
    }
    total += size
    if (total > limits.maxTotalBytes) {
      return { ok: false, error: `合计 ${formatBytes(total)}，超过单条上限 ${formatBytes(limits.maxTotalBytes)}` }
    }
    try {
      inputs.push({ data: new Uint8Array(await readFile(rawPath)), mediaType, name: basename(rawPath) })
    } catch (error) {
      return { ok: false, error: `读不到「${rawPath}」：${error instanceof Error ? error.message : String(error)}` }
    }
  }
  try {
    const refs = await attachments.saveImages(inputs)
    return { ok: true, refs: refs.map(ref => ({ ...ref })) }
  } catch (error) {
    return { ok: false, error: `图片入库失败：${error instanceof Error ? error.message : String(error)}` }
  }
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

  private readonly store: HintStore

  /** 快照里要带上的图片限额（由插件配置与附件服务可用性决定）。 */
  private readonly imageLimits: HintImageLimits

  /**
   * @param store - 队列（快照来源）。
   * @param heartbeatMs - 注释心跳间隔。
   * @param imageLimits - 图片限额（`enabled: false` = 本宿主不支持图片提示）。
   */
  constructor(
    store: HintStore,
    heartbeatMs: number,
    imageLimits: HintImageLimits,
  ) {
    this.store = store
    this.imageLimits = imageLimits
    this.beatTimer = setInterval(() => { this.beat() }, clampNumber(heartbeatMs, 5000, 300000, 25000))
    this.beatTimer.unref()
  }

  /** 当前订阅者数量（诊断用）。 */
  get size(): number {
    return this.clients.size
  }

  /** 处理 `/dsh-szg-hint/events`：握手、投首帧、登记订阅。 */
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
    res.write(`: 时之光旁路提示 · 事件通道\n\nretry: ${SSE_RETRY_MS}\n\n`)
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
    return { ok: true, ...this.store.snapshot(this.imageLimits) }
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

/** 处理 `/dsh-szg-hint` 下的全部请求（路径分派）。 */
async function handleHintRequest(
  deps: {
    store: HintStore
    hub: HintHub
    maxBodyBytes: number
    maxContentChars: number
    /** 图片限额（含 `enabled`：附件服务在不在）。 */
    imageLimits: HintImageLimits
    /** 附件服务；缺席时图片相关分支统一回 503。 */
    attachments: AttachmentStoreLike | undefined
    /** 连接信任围栏；缺席时按「无认证面」处理（见 `apply` 的告警）。 */
    trust: ConnectionLike | undefined
  },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 数据面必须先过宿主的连接信任围栏：`sameOrigin` 只拦「带外站 Origin」的浏览器
  // 跨站请求，对无 Origin 的本地脚本一律放行——不加这道闸，任何本机进程都能读走
  // 用户的提示队列，甚至往正在执行的任务里注入指令。浏览器正常请求带 cookie，
  // 因此这里放行的是「已认证的页面」，拒绝的是「没拿到 token 的第三方调用」。
  if (deps.trust === undefined) {
    writeJson(res, 503, { ok: false, error: '宿主缺少 connection 服务，无法校验请求来源' })
    return
  }
  const rejection = deps.trust.requestRejection(req)
  if (rejection !== undefined) {
    writeJson(res, rejection, {
      ok: false,
      error: rejection === 401
        ? '需要先通过宿主认证：访问 dsh web 打印的带 token 地址，再刷新页面'
        : 'Host 不受信任',
    })
    return
  }
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
    writeJson(res, 200, { ok: true, ...deps.store.snapshot(deps.imageLimits) })
    return
  }
  // `/dsh-szg-hint/image/<提示 id>/<序号>`：待参考缩略图与放大预览取字节。
  // 刻意**不按 attachmentId** 暴露：否则这条路由就成了「按内容哈希读附件库」的通用出口，
  // 而现在它只能读到「当前队列里某条提示自己带的图」，提示一撤销立刻 404。
  if (path.startsWith(IMAGE_PATH_PREFIX)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      writeJson(res, 405, { ok: false, error: '只支持 GET' })
      return
    }
    const matched = /^(\d+)\/(\d+)$/.exec(path.slice(IMAGE_PATH_PREFIX.length))
    const id = matched === null ? 0 : Number(matched[1])
    const index = matched === null ? 0 : Number(matched[2])
    const ref = id > 0 ? deps.store.imageAt(id, index) : undefined
    if (ref === undefined) {
      writeJson(res, 404, { ok: false, error: '这张图不在了（提示可能已被撤销）' })
      return
    }
    if (deps.attachments === undefined) {
      writeJson(res, 503, { ok: false, error: '宿主没有挂载附件服务，读不到图片' })
      return
    }
    try {
      const stored = await deps.attachments.readImage(ref)
      const bytes = Buffer.from(stored.data)
      res.writeHead(200, {
        'content-type': stored.ref.mediaType,
        'content-length': String(bytes.byteLength),
        // 引用是内容寻址的（attachmentId = sha256），同一 id 的字节永不改变：可以长缓存。
        // private：这是认证后才可读的数据，不许中间层缓存。
        'cache-control': 'private, max-age=31536000, immutable',
        'etag': `"${ref.attachmentId}"`,
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: `读取图片失败：${error instanceof Error ? error.message : String(error)}` })
    }
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
      const parsed = parseImageUploads(body['images'], deps.imageLimits)
      if (!parsed.ok) {
        writeJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      const admitted = await admitImages(deps.attachments, parsed.uploads)
      if (!admitted.ok) {
        writeJson(res, 400, { ok: false, error: admitted.error })
        return
      }
      const pushed = deps.store.push(sessionId, content, 'web', admitted.refs)
      if (pushed.item === null) {
        writeJson(res, 400, { ok: false, error: '提示内容为空（写点字，或者附一张图）' })
        return
      }
      deps.hub.announce({
        kind: 'added',
        ids: [pushed.item.id],
        sessionId: pushed.item.sessionId,
        text: summarizeHint(pushed.item),
        imageCount: pushed.item.images.length,
      })
      writeJson(res, 200, {
        ok: true,
        hintId: pushed.item.id,
        running: pushed.running,
        dropped: pushed.dropped,
        maxContentChars: deps.maxContentChars,
        imageCount: pushed.item.images.length,
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
      const result = id > 0 ? deps.store.cancel(id) : { status: 'missing' as const }
      if (result.status === 'missing') {
        writeJson(res, 404, { ok: false, error: '这条提示不存在（可能已被撤销）' })
        return
      }
      if (result.status === 'consumed') {
        writeJson(res, 409, { ok: false, error: '这条提示 AI 已经参考过了，撤不回来' })
        return
      }
      // 回执按**被撤销条目的会话**广播：空串是「全局」语义，会让别的会话也弹一条撤销提示。
      deps.hub.announce({
        kind: 'cancelled',
        ids: [id],
        sessionId: result.entry.sessionId,
        text: summarizeHint(result.entry),
        imageCount: result.entry.images.length,
      })
      writeJson(res, 200, { ok: true, hintId: id })
      return
    }
    writeJson(res, 405, { ok: false, error: '只支持 POST / DELETE' })
    return
  }
  // `/dsh-szg-hint/<id>`：撤销的路径形式（curl 调试方便；浏览器半边走 DELETE body）。
  if (path.startsWith(`${ROUTE_PREFIX}/`) && req.method === 'DELETE') {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      return
    }
    const id = Math.trunc(clampNumber(Number(path.slice(ROUTE_PREFIX.length + 1)), 0, Number.MAX_SAFE_INTEGER, 0))
    const result = id > 0 ? deps.store.cancel(id) : { status: 'missing' as const }
    if (result.status !== 'ok') {
      writeJson(res, result.status === 'consumed' ? 409 : 404, {
        ok: false,
        error: result.status === 'consumed' ? '这条提示 AI 已经参考过了，撤不回来' : '这条提示不存在（可能已被撤销）',
      })
      return
    }
    deps.hub.announce({
      kind: 'cancelled',
      ids: [id],
      sessionId: result.entry.sessionId,
      text: summarizeHint(result.entry),
      imageCount: result.entry.images.length,
    })
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

  // ── 图片能力：附件服务（软依赖）──
  // ★软依赖只能走 `ctx.get('attachments')`——这是官方 Service 契约里写明的可选访问式
  // （`access.optional.expression`）。**不能用属性取值**：`Reflect.get(ctx, 'attachments')`
  // 在真实 cordis 里会抛 `cannot get property "attachments" without inject`（服务由**兄弟**
  // 条目 include:attachment-local 提供，不在 inject 里就没有解析路径），整个 apply 当场失败
  // → 宿主把条目标成 fiberPhase=failed（「加载失败」）→ 路由一条都没注册 → 前端「发送失败」。
  // 2026-10-15 实测事故根因：宿主把条目标成 fiberPhase=failed，离线探针可稳定复现。
  //
  // ★再叠一层：软依赖服务**可能晚于本插件 apply 挂载**——`webServer` 那条实测教训是同一个坑
  // （宿主服务在插件 apply 之后才挂载，`ctx.get()` 当场拿到 undefined）。所以这里不把「没有」
  // 写死成不可变状态：`imageLimits` 是**共享的可变对象**，任一入口发现服务已就绪就地升级，
  // 所有持有它的地方（hub 快照 / 路由入参 / 两个工具）同时生效，不必重启。
  const maxImages = Math.trunc(clampNumber(resolved.maxImagesPerHint, 1, 10, 3))
  const maxImageBytes = Math.trunc(clampNumber(resolved.maxImageBytes, 64 * 1024, 64 * 1024 * 1024, 4 * 1024 * 1024))
  const maxTotalBytes = Math.trunc(clampNumber(resolved.maxTotalImageBytes, 64 * 1024, 128 * 1024 * 1024, 12 * 1024 * 1024))
  let attachments = ctx.get('attachments') as unknown as AttachmentStoreLike | undefined
  const imageLimits: HintImageLimits = { ...DISABLED_IMAGE_LIMITS }
  /** 把「附件服务已就绪」补记到共享限额上；未就绪时是空操作。 */
  const syncAttachments = (): void => {
    if (attachments !== undefined) return
    const found = ctx.get('attachments') as unknown as AttachmentStoreLike | undefined
    if (found === undefined) return
    attachments = found
    Object.assign(imageLimits, enabledImageLimits({ maxImages, maxImageBytes, maxTotalBytes }))
    process.stderr.write('[dsh-szg-hint] attachments 服务已就绪，图片提示启用\n')
  }
  if (attachments === undefined) {
    process.stderr.write('[dsh-szg-hint] attachments 服务尚未就绪：图片提示暂不可用（就绪后自动启用；纯文字提示不受影响）\n')
  } else {
    Object.assign(imageLimits, enabledImageLimits({ maxImages, maxImageBytes, maxTotalBytes }))
  }

  const hub = new HintHub(store, resolved.heartbeatMs, imageLimits)
  store.onChange = () => { hub.invalidate() }
  ctx.effect(() => () => hub.dispose(), 'dsh-szg-hint:hub')

  // ── 数据面路由 ──
  // 连接信任围栏（`connection` 服务的 requestRejection）：数据面的认证闸门。
  // `Reflect.get` 而不是 `ctx.connection`——与官方 open-in-app 同一写法，不依赖跨包类型增强。
  const trust = Reflect.get(ctx as object, 'connection') as ConnectionLike | undefined
  if (trust === undefined) {
    process.stderr.write('[dsh-szg-hint] connection 服务缺席，数据面不做来源校验（仅本机回环场景可接受）\n')
  }

  const webServer = ctx.get('webServer') as unknown as WebServerLike | undefined
  if (webServer === undefined) {
    // 硬依赖成立时不该发生；真发生就明说，别再静默退化成「页面有提示栏却全部 404」。
    process.stderr.write('[dsh-szg-hint] webServer 服务缺席，数据面路由未注册\n')
  } else {
    try {
      ctx.effect(() => {
        const dispose = webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            // 每次请求都补记一次「服务是否已就绪」：晚挂载的附件服务由此自动启用。
            syncAttachments()
            return handleHintRequest({
              store,
              hub,
              // 图片走 base64 上行：body 上限按「合计字节 × 4/3（base64 膨胀）+ 64KB（正文与 JSON 包装）」给。
              maxBodyBytes: Math.ceil(imageLimits.maxTotalBytes * 4 / 3) + 64 * 1024,
              maxContentChars,
              imageLimits,
              attachments,
              trust,
            }, req, res)
          },
        })
        return () => dispose()
      }, 'dsh-szg-hint:routes')
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
    // 每一步都补记一次「附件服务是否已就绪」：带图提示要用它还原字节。
    syncAttachments()
    const decision = await next()
    // `next() !== enter`（下游拒绝 / 未返回决定）= 这一步不会发出请求，此时不能取走提示：
    // 取走就等于永久丢（既没进请求，也没留在队列里）。先取一次只为判断是否有货，随后无条件放回。
    if (decision === undefined || decision.kind !== 'enter') {
      if (payload.signal?.aborted !== true) {
        const rolledBack = store.restore(store.consume(sessionIdOfPayload(payload), maxPerStep).map(item => item.id))
        if (rolledBack > 0) {
          process.stderr.write(`[dsh-szg-hint] 本步未进入，已放回 ${String(rolledBack)} 条提示待下一步\n`)
        }
      }
      return decision
    }
    if (payload.signal?.aborted === true) return decision
    const taken = store.consume(sessionIdOfPayload(payload), maxPerStep)
    if (taken.length === 0) return decision
    let message: unknown
    let imageCount = 0
    try {
      const images = taken.flatMap(item => item.images)
      // 「本步模型吃不吃图」只在真的带图时问一次：纯文字提示不该为它多付一次解析成本。
      // 只有**明确**问出「不吃图」才把本机只读副本路径写进正文（问不出来按能吃图处理）。
      const seesImages = images.length > 0
        ? await routeSeesImages(ctx, payload.agent, payload.signal)
        : undefined
      const { blocks, imageCount: rendered } = renderInjection(
        taken,
        seesImages === false ? image => safeImageHostPath(attachments, image) : () => undefined,
      )
      imageCount = rendered
      message = createUserMessage({
        content: blocks,
        source: {
          // v4 来源准入：外部生产者须用 plugin:<名> 命名空间（v3 式 kind:'plugin' 会被会话拒绝）。
          kind: 'plugin:dsh-szg-hint' as const,
          form: 'snapshot' as const,
          sections: [{ name: '旁路提示', text: blocks[0]?.type === 'text' ? blocks[0].text : '' }],
        },
      })
    } catch (error) {
      // 构造失败 = 这一步没能真看到提示：回滚成待消费，下一步重试（绝不静默丢弃）。
      const restored = store.restore(taken.map(item => item.id))
      process.stderr.write(`[dsh-szg-hint] 注入构造失败（已回滚 ${String(restored)} 条）：${String(error)}\n`)
      return decision
    }
    const first = taken[0] as HintItem
    hub.announce({
      kind: 'consumed',
      // 上面已判过 `taken` 非空，但 narrowing 不跨异步边界；首元素单独取出后类型即可收窄。
      ids: [first.id, ...taken.slice(1).map(item => item.id)],
      sessionId: first.sessionId,
      text: summarizeHint(first),
      imageCount,
    })
    const messages = decision.messages ?? []
    return { ...decision, messages: [...messages, message] }
  }
  ctx.effect(() => events.on('agent/pre-step', preStep), 'dsh-szg-hint:pre-step')

  // ── 工具 ──
  try {
    ctx.tools.register(defineTool({
      name: 'hint_send',
      description: '向某个正在执行的会话投递一条提示：该会话在下一步请求里会看到它，用来纠偏方向、'
        + '补充约束、追加要求，而**不打断**它当前的任务（不同于再发一条用户消息）。'
        + '也可以带上本机图片（截图、参考图、报错画面）：图片会随提示进入下一步，对方模型能直接看到。'
        + '用户说「给它提个醒」「让它换个方向」「补充一句要求」「让它看看这张图」时用它；'
        + '不传 sessionId 即投给当前会话。',
      parameters: {
        text: { type: 'string', description: '提示正文；会被注入目标会话的下一步请求（超长截断到 2000 字）' },
        sessionId: { type: 'string', description: '目标会话 id；留空 = 当前会话' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：要随提示上行的本机图片路径（png / jpg / jpeg / webp / gif），'
            + `最多 ${String(maxImages)} 张、单张不超过 ${formatBytes(maxImageBytes)}。`
            + '只在确实需要对方「看图」时用。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        syncAttachments()
        const text = typeof args.text === 'string' ? args.text : ''
        const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        const scope = explicit.length > 0 ? explicit : sessionIdOfAgent(asRecord(exec)['agent'])
        const raw = Array.isArray(args.images) ? args.images : []
        const paths = raw.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        const admitted = await admitLocalImages(attachments, paths, imageLimits)
        if (!admitted.ok) return `未投递：${admitted.error}。`
        const pushed = store.push(scope, text, 'tool', admitted.refs)
        if (pushed.item === null) return '未投递：text 为空且没有附图。'
        const where = scope.length > 0 ? `会话 ${scope}` : '全局队列'
        const when = pushed.running ? '该会话正在执行，下一步就会参考到' : '该会话当前不在执行，将在下个任务开始时参考'
        const withImages = pushed.item.images.length > 0 ? `（含 ${String(pushed.item.images.length)} 张图）` : ''
        const dropped = pushed.dropped === null ? '' : `（该会话待消费已达上限，挤掉了最旧的一条「${pushed.dropped}」）`
        return `已投递到${where}${withImages}（id=${String(pushed.item.id)}）；${when}。${dropped}`
      },
    }))

    ctx.tools.register(defineTool({
      name: 'hint_status',
      description: '查看旁路提示队列现状：某会话（或全局）还有哪些提示没被参考、最近参考过哪些（含附图张数）。'
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
        syncAttachments()
        const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        const all = raw === '*'
        const scope = all ? '' : (raw.length > 0 ? raw : sessionIdOfAgent(asRecord(exec)['agent']))
        const stats = store.stats()
        /** 附图标记（0 张时不显示）。 */
        const withImages = (count: number): string => (count > 0 ? `（含 ${String(count)} 张图）` : '')
        const lines = [
          `队列：待参考 ${String(stats.pending)} 条 / 已参考 ${String(stats.consumed)} 条（总计 ${String(stats.total)} 条）`,
          `图片能力：${imageLimits.enabled
            ? `可用（单条最多 ${String(imageLimits.maxImages)} 张，单张上限 ${formatBytes(imageLimits.maxImageBytes)}）`
            : '不可用（宿主没有挂载附件服务）'}`,
        ]
        if (all) {
          const snapshot = store.snapshot(imageLimits)
          lines.push(`正在执行的会话：${snapshot.runningSessions.length > 0 ? snapshot.runningSessions.join('、') : '（无）'}`)
          if (snapshot.pending.length === 0) lines.push('当前没有待参考的提示。')
          for (const item of snapshot.pending) {
            lines.push(`  · id=${String(item.id)} [${item.sessionId.length > 0 ? item.sessionId : '全局'}] ${item.content.slice(0, 60)}${withImages(item.images.length)}`)
          }
        } else if (scope.length === 0) {
          lines.push('未指定会话、也取不到当前会话：只能看到全局统计。')
        } else {
          const pending = store.pendingFor(scope)
          lines.push(`会话 ${scope}：${store.isRunning(scope) ? '正在执行' : '不在执行'}`)
          lines.push(pending.length === 0 ? '  没有待参考的提示。' : `  待参考 ${String(pending.length)} 条：`)
          for (const item of pending) {
            lines.push(`    · id=${String(item.id)}${item.sessionId.length === 0 ? '（全局）' : ''} ${item.content.slice(0, 60)}${withImages(item.images.length)}`)
          }
        }
        const recent = store.recentConsumed(5)
        if (recent.length > 0) {
          lines.push('最近被参考的提示：')
          for (const item of recent) lines.push(`  · id=${String(item.id)} ${item.text.slice(0, 60)}${withImages(item.imageCount)}`)
        }
        return Promise.resolve(lines.join('\n'))
      },
    }))
  } catch (error) {
    process.stderr.write(`[dsh-szg-hint] 工具注册失败：${String(error)}\n`)
  }
}
// (2026-10-15 22:0x 修复后触碰：触发 HMR 重新加载宿主半边)
