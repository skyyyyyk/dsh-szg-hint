/**
 * 旁路提示 · 图片准入与渲染（宿主半边，纯函数）。
 *
 * 图片走的是 dsh 的**附件服务**（`ctx.attachments`）而不是自建存储：
 *  - 准入由它做（解码、媒体类型核对、尺寸/字节上限、归一化重编码）；
 *  - 引用是内容寻址的（`attachmentId` = sha256），队列只存引用，重启后照样能读回字节；
 *  - 注入时把引用还原成模型能看的 image 内容块，字节由适配器按路由预算再压一次。
 *
 * 本模块只放**没有副作用的判断与格式化**：准入清单的校验、扩展名到媒体类型的映射、
 * 人读的尺寸文案。真正的落库（`saveImages`）与读回（`readImage`）在 `index.ts` 里，
 * 因为它们要碰服务对象。
 *
 * @module dsh-szg-hint/images
 */

import type { HintImageLimits, HintImageMediaType, HintImageRef, HintImageUpload } from './protocol.ts'

/** 本机图片扩展名 → 媒体类型（`hint_send` 工具按路径附图时用）。 */
const EXTENSION_MEDIA_TYPES: Readonly<Record<string, HintImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 浏览器与附件服务都接受的媒体类型（顺序即白名单展示顺序）。 */
export const HINT_IMAGE_MEDIA_TYPES: readonly HintImageMediaType[] = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]

/**
 * 按路径后缀判媒体类型。
 * @param filePath - 本机路径（不要求存在）。
 * @returns 媒体类型；不是受支持的图片后缀时返回 undefined。
 */
export function mediaTypeForPath(filePath: string): HintImageMediaType | undefined {
  const match = /\.[A-Za-z0-9]+$/.exec(filePath.trim())
  return match === null ? undefined : EXTENSION_MEDIA_TYPES[match[0].toLowerCase()]
}

/**
 * 字节数的人读文案（附图清单里用，模型据此判断要不要真的看图）。
 * @param bytes - 字节数。
 * @returns 形如 `312 KB` / `1.4 MB` / `820 B`。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${String(Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 单张图的模型可读文案。
 * @param order - 全局序号（从 1 开始，与正文里的「附图 k」对应）。
 * @param image - 图片引用。
 * @returns 形如 `附图 1：shot.png（1600x900，image/png，312 KB）`。
 */
export function describeImage(order: number, image: HintImageRef): string {
  const name = image.name !== undefined && image.name.length > 0 ? image.name : '未命名'
  return `附图 ${String(order)}：${name}（${String(image.width)}x${String(image.height)}，${image.mediaType}，${formatBytes(image.bytes)}）`
}

/**
 * 校验浏览器上行的图片清单。
 *
 * 这里做的是**廉价的结构与限额判断**（张数、声明类型、声明字节数），真正的权威校验
 * （base64 规范性、解码成功、真实像素与字节上限）在附件服务的 `saveImages` 里——
 * 这里拦下来的都是「一眼就不该收」的请求，好让错误文案直接说明是哪一条越界了。
 * @param raw - 请求体里的 `images` 字段（未收窄）。
 * @param limits - 当前限额。
 * @returns 通过时给规范化后的清单；否则给中文原因。
 */
export function parseImageUploads(
  raw: unknown,
  limits: HintImageLimits,
): { ok: true, uploads: HintImageUpload[] } | { ok: false, error: string } {
  if (raw === undefined || raw === null) return { ok: true, uploads: [] }
  if (!Array.isArray(raw)) return { ok: false, error: '图片清单必须是数组' }
  if (raw.length === 0) return { ok: true, uploads: [] }
  if (!limits.enabled) return { ok: false, error: '宿主没有挂载附件服务，暂时不支持图片提示' }
  if (raw.length > limits.maxImages) {
    return { ok: false, error: `一条提示最多带 ${String(limits.maxImages)} 张图（收到 ${String(raw.length)} 张）` }
  }
  const uploads: HintImageUpload[] = []
  let total = 0
  for (const [index, value] of raw.entries()) {
    const where = `第 ${String(index + 1)} 张图`
    if (typeof value !== 'object' || value === null) return { ok: false, error: `${where}不是对象` }
    const rec = value as Record<string, unknown>
    const mediaType = typeof rec['mediaType'] === 'string' ? rec['mediaType'] : ''
    const data = typeof rec['data'] === 'string' ? rec['data'] : ''
    if (!limits.mediaTypes.includes(mediaType as HintImageMediaType)) {
      return { ok: false, error: `${where}的类型 ${mediaType.length > 0 ? mediaType : '（空）'} 不在白名单里（${limits.mediaTypes.join('、')}）` }
    }
    if (data.length === 0) return { ok: false, error: `${where}的图片数据为空` }
    // 规范 base64 的往返校验：`Buffer.from(...,'base64')` 对坏字符是**静默忽略**的，
    // 不比对就会把「不是这张图」的字节交给解码器（附件服务那边同样要求规范形式）。
    const decoded = Buffer.from(data, 'base64')
    if (decoded.toString('base64') !== data) {
      return { ok: false, error: `${where}不是规范的 base64 编码` }
    }
    const bytes = decoded.byteLength
    if (bytes > limits.maxImageBytes) {
      return { ok: false, error: `${where}约 ${formatBytes(bytes)}，超过单张上限 ${formatBytes(limits.maxImageBytes)}` }
    }
    total += bytes
    if (total > limits.maxTotalBytes) {
      return { ok: false, error: `合计约 ${formatBytes(total)}，超过单条上限 ${formatBytes(limits.maxTotalBytes)}` }
    }
    const name = typeof rec['name'] === 'string' && rec['name'].trim().length > 0
      ? rec['name'].trim().slice(0, 120)
      : undefined
    uploads.push(name === undefined ? { mediaType, data } : { mediaType, data, name })
  }
  return { ok: true, uploads }
}
