/**
 * 旁路提示 · 宿主与浏览器两半共用的类型（本文件只有类型，无运行时代码）。
 *
 * 语义与 szg 侧 `hint_queue` 一致：提示是**旁路**的——它不进对话历史，只在下一个模型
 * 请求里作为一条 plugin 消息出现一次；`status` 从 `pending` 变 `consumed` 即「模型已经
 * 看过它」。
 *
 * 图片同样走这条旁路：用户附的图由**附件服务**（`ctx.attachments`）落成不可变引用，
 * 队列里只存引用（`HintImageRef`），注入时再还原成模型能看的 image 内容块。
 * 引用是内容寻址的（attachmentId = sha256），因此跨宿主重启仍然有效。
 *
 * @module dsh-szg-hint/protocol
 */

/** 允许随提示上行的栅格图片类型（与附件服务的准入集合一致）。 */
export type HintImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * 一张已落库的提示附图（是附件服务 `ImageAttachmentRef` 的结构化子集）。
 *
 * 存的是**引用**而不是字节：队列文件因此始终很小，图片本身由附件服务按内容寻址保管。
 */
export interface HintImageRef {
  /** 附件服务的不可变 id（sha256，也是前端取图的唯一键）。 */
  attachmentId: string
  /** 落库时校验过的媒体类型。 */
  mediaType: HintImageMediaType
  /** 归一化后的编码字节数。 */
  bytes: number
  /** 归一化后的像素宽。 */
  width: number
  /** 归一化后的像素高。 */
  height: number
  /** 展示名（已去掉本机路径信息）；没有就是没有。 */
  name?: string
}

/** 浏览器上行的一张图（base64 原文，由宿主在准入时解码校验）。 */
export interface HintImageUpload {
  /** 声明的媒体类型；宿主要求它落在 {@link HintImageLimits.mediaTypes} 里。 */
  mediaType: string
  /** 规范 base64（不含 `data:` 前缀）。 */
  data: string
  /** 展示名（可选）。 */
  name?: string
}

/** 一条旁路提示。 */
export interface HintItem {
  /** 自增 id（全队列唯一，也是前端去重与撤销的键）。 */
  id: number
  /** 归属会话；空串 = 全局提示（任何会话都能消费）。 */
  sessionId: string
  /** 提示正文；纯图提示允许为空串。 */
  content: string
  /** 随提示上行的图片引用（按用户选择的顺序）。 */
  images: HintImageRef[]
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
  /** 附图引用（空数组 = 纯文字提示）。 */
  images: HintImageRef[]
  createdAt: number
}

/** 快照里的一条已消费提示摘要（只保留最近若干条，正文截断）。 */
export interface HintConsumedView {
  id: number
  sessionId: string
  text: string
  /** 这条提示带了几张图（已参考列表只显示计数，不再回取缩略图）。 */
  imageCount: number
  consumedAt: number
}

/** 图片能力的当前限额与可用性（前端据此决定入口是否可用、以及报错文案）。 */
export interface HintImageLimits {
  /** 宿主是否挂载了附件服务；false 时图片提示不可用（纯文字照常）。 */
  enabled: boolean
  /** 单条提示最多几张图。 */
  maxImages: number
  /** 单张图的最大编码字节数（前端据此在本地先压）。 */
  maxImageBytes: number
  /** 单条提示所有图的合计字节上限。 */
  maxTotalBytes: number
  /** 接受的媒体类型白名单。 */
  mediaTypes: HintImageMediaType[]
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
  /** 图片能力限额（老宿主没有这个字段：前端按 `enabled: false` 兜底）。 */
  imageLimits: HintImageLimits
}

/** 入队结果。 */
export interface HintPushResult {
  /** 入队的提示；正文与附图都为空时 null。 */
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
  /** 本帧涉及的提示带了几张图（0 = 纯文字，老宿主没有这个字段）。 */
  imageCount: number
}
