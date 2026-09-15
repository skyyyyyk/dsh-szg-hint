/**
 * 旁路提示 · 宿主与浏览器两半共用的类型（本文件只有类型，无运行时代码）。
 *
 * 语义：提示是**旁路**的——它不进对话历史，只在下一个模型
 * 请求里作为一条 plugin 消息出现一次；`status` 从 `pending` 变 `consumed` 即「模型已经
 * 看过它」。
 *
 * @module dsh-szg-hint/protocol
 */

/** 一条旁路提示。 */
export interface HintItem {
  /** 自增 id（全队列唯一，也是前端去重与撤销的键）。 */
  id: number
  /** 归属会话；空串 = 全局提示（任何会话都能消费）。 */
  sessionId: string
  /** 提示正文。 */
  content: string
  /** 来源标记（如 `web`、`tool`），只作追溯用。 */
  meta: string
  /** `pending` = 待模型参考；`consumed` = 已随某一步请求注入过。 */
  status: 'pending' | 'consumed'
  /** 入队时刻（毫秒）。 */
  createdAt: number
  /** 被消费时刻（毫秒）；未消费为 null。 */
  consumedAt: number | null
}

/** 快照里的一条待消费提示（正文不截断：前端要能原样展示与撤销）。 */
export interface HintPendingView {
  id: number
  sessionId: string
  content: string
  createdAt: number
}

/** 快照里的一条已消费提示摘要（只保留最近若干条，正文截断）。 */
export interface HintConsumedView {
  id: number
  sessionId: string
  text: string
  consumedAt: number
}

/**
 * 全量快照：SSE `state` 帧与 `GET /dsh-szg-hint/state` 返回**同一个**对象，
 * 浏览器半边因此只有一条应用路径（推来的与拉来的没有差别）。
 */
export interface HintSnapshot {
  /** 宿主时钟（毫秒）。 */
  now: number
  /** 状态序号：任何变更都 +1，浏览器半边据此判断「有没有新东西」。 */
  revision: number
  /** 正在跑回合的会话 id；客户端据此判断「提示会在哪」文案。 */
  runningSessions: string[]
  /** 全部待消费提示（跨会话，前端按自己的会话过滤）。 */
  pending: HintPendingView[]
  /** 最近被参考过的提示。 */
  recentConsumed: HintConsumedView[]
  /** 队列统计（全局口径）。 */
  stats: { pending: number; consumed: number; total: number }
  /** 单条提示正文上限（码点）：前端输入框据此给提示。 */
  maxContentChars: number
}

/** 入队结果。 */
export interface HintPushResult {
  /** 入队的提示；正文为空时 null。 */
  item: HintItem | null
  /** 该会话当时是否在跑回合（决定前端文案：下一步参考 / 排队等下个任务）。 */
  running: boolean
  /** 因超出会话上限被挤掉的最旧 pending 提示（正文前 40 字），没有则 null。 */
  dropped: string | null
}

/** SSE `hint` 事件帧的载荷：动作语义（toast 用它，列表用 `state` 帧）。 */
export interface HintEventFrame {
  kind: 'added' | 'consumed' | 'cancelled'
  /** 本帧涉及的提示 id，至少一条（空帧没有可展示的动作，宿主不推）。 */
  ids: [number, ...number[]]
  sessionId: string
  /** 正文摘要（`consumed` / `cancelled` 时带上，供前端提示）。 */
  text: string
}
