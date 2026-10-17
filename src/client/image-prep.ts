/**
 * 旁路提示 · 图片预处理（浏览器半边）。
 *
 * 上行前先把图压到限额内，理由有三条：
 *  1. **省上行流量**：截图动辄 3~8 MB，压到几百 KB 走本地回环也更快；
 *  2. **省模型成本**：图会进下一步请求，像素越多 token 越多；
 *  3. **过得了服务端闸门**：附件服务对单张字节数有上限，超了是**直接拒绝**（不是帮你缩），
 *     所以客户端必须自己先缩。
 *
 * 编码策略（尽量少损失、又保证过闸）：
 *  - 已经在限额内、且最长边不超过 2048 → **原样上行**（保留 PNG 无损、GIF 动图）；
 *  - 否则画布重编码：最长边缩到 1600，PNG 源优先仍用 PNG（截图里的文字最怕 JPEG 伪影），
 *    超限再退到 JPEG 质量阶梯；仍超限就把最长边压到 1024 再试一次；
 *  - GIF 不重编码（canvas 会把动图压成静帧）：超限直接报错，让用户自己换一张。
 *
 * 这一层是**尽力而为**：真正的权威校验在宿主（`parseImageUploads` + 附件服务），
 * 这里只是让绝大多数图能顺利过去，并在过不去时给出人话原因。
 *
 * @module dsh-szg-hint/client/image-prep
 */

import type { HintImageLimits } from '../protocol.ts'

/** 超过这个最长边就不原样上行（服务端归一化上限也是 2048，本地先压省流量）。 */
const PASS_THROUGH_EDGE = 2048
/** 重编码后的目标最长边。 */
const TARGET_EDGE = 1600
/** 退让后的最长边（质量阶梯全试完还超限时再缩一档）。 */
const FALLBACK_EDGE = 1024
/** JPEG 质量阶梯（从好到省）。 */
const JPEG_QUALITY_LADDER = [0.9, 0.78, 0.62]

/** 一张待发图片（浏览器本地态：字节 + 预览 + 元信息）。 */
export interface DraftImage {
  /** 本地自增 key（列表渲染与删除用，不是宿主 id）。 */
  key: number
  /** 展示名（取文件名，没有就按类型给一个）。 */
  name: string
  /** 媒体类型（上行时原样交给宿主校验）。 */
  mediaType: string
  /** 编码后的字节数。 */
  bytes: number
  /** 像素宽。 */
  width: number
  /** 像素高。 */
  height: number
  /** 规范 base64（不含 `data:` 前缀）。 */
  data: string
  /** 本地预览 URL（object URL；删除或发送后要 revoke）。 */
  previewUrl: string
  /** 是否被本地重编码过（UI 上标注「已压缩」）。 */
  compressed: boolean
}

/** 预处理结果。 */
export type PrepareImageResult = { ok: true, image: DraftImage } | { ok: false, error: string }

/**
 * 按最长边等比缩放（纯函数，便于单测）。
 * @param width - 原宽。
 * @param height - 原高。
 * @param maxEdge - 目标最长边。
 * @returns 目标尺寸（不放大：原图小于目标时原样返回）。
 */
export function targetDimensions(width: number, height: number, maxEdge: number): { width: number, height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge || longest === 0) return { width, height }
  const scale = maxEdge / longest
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * 读文件为规范 base64。
 * @param blob - 文件或编码后的 Blob。
 * @returns base64（不含 `data:` 前缀）。
 */
async function toBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < buffer.length; offset += chunk) {
    binary += String.fromCharCode(...buffer.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * 解码图片拿到像素尺寸（优先 `createImageBitmap`，退回 `<img>`）。
 * @param file - 用户给的文件。
 * @returns 位图与尺寸；解码失败返回 null。
 */
async function decode(file: File): Promise<{ bitmap: ImageBitmap | HTMLImageElement, width: number, height: number } | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file)
      return { bitmap, width: bitmap.width, height: bitmap.height }
    }
  } catch {
    // 落到 <img> 分支：某些浏览器对个别格式的 createImageBitmap 会抛。
  }
  try {
    const url = URL.createObjectURL(file)
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => { resolve() }
      image.onerror = () => { reject(new Error('图片解码失败')) }
      image.src = url
    })
    URL.revokeObjectURL(url)
    return { bitmap: image, width: image.naturalWidth, height: image.naturalHeight }
  } catch {
    return null
  }
}

/**
 * 用画布重编码一张图。
 * @param source - 已解码的位图。
 * @param width - 目标宽。
 * @param height - 目标高。
 * @param mediaType - 目标媒体类型。
 * @param quality - 质量（仅 JPEG/WebP 生效）。
 * @returns 编码后的 Blob；编码失败返回 null。
 */
async function encode(
  source: ImageBitmap | HTMLImageElement,
  width: number,
  height: number,
  mediaType: string,
  quality: number,
): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return null
  // JPEG 没有透明通道：先铺白底，否则透明区会被涂成黑色（截图边缘常见）。
  if (mediaType === 'image/jpeg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
  }
  context.drawImage(source, 0, 0, width, height)
  return await new Promise<Blob | null>(resolve => {
    canvas.toBlob(blob => { resolve(blob) }, mediaType, quality)
  })
}

/**
 * 把用户给的文件压成一张可上行的图片。
 * @param file - 文件（来自选择、拖放或粘贴）。
 * @param limits - 宿主给出的限额（类型白名单、单张字节上限）。
 * @param key - 本地自增 key（调用方给，用于列表渲染）。
 * @returns 结果：可上行的图片，或一句人话原因。
 */
export async function prepareImage(file: File, limits: HintImageLimits, key: number): Promise<PrepareImageResult> {
  const declared = file.type.length > 0 ? file.type : ''
  const fallbackType = declared.length > 0 ? declared : 'image/png'
  if (!(limits.mediaTypes as readonly string[]).includes(fallbackType)) {
    return { ok: false, error: `不支持的图片类型 ${fallbackType.length > 0 ? fallbackType : '（未知）'}（只收 ${limits.mediaTypes.join('、')}）` }
  }
  const decoded = await decode(file)
  if (decoded === null) return { ok: false, error: `${file.name.length > 0 ? file.name : '这张图'}解不开（可能不是图片，或格式不受支持）` }
  const name = file.name.length > 0 ? file.name : `粘贴的图片.${fallbackType.split('/')[1] ?? 'png'}`

  // 快速路径：已经在限额内、尺寸也不夸张 → 原样上行（零损失）。
  if (file.size <= limits.maxImageBytes && Math.max(decoded.width, decoded.height) <= PASS_THROUGH_EDGE) {
    return {
      ok: true,
      image: {
        key,
        name,
        mediaType: fallbackType,
        bytes: file.size,
        width: decoded.width,
        height: decoded.height,
        data: await toBase64(file),
        previewUrl: URL.createObjectURL(file),
        compressed: false,
      },
    }
  }

  if (fallbackType === 'image/gif') {
    return { ok: false, error: `${name} 超过单张上限，且动图不能自动压缩——请换一张，或先把它压小` }
  }

  // 重编码：先按目标尺寸试一轮质量阶梯，仍超限再缩一档重试。
  const attempts: { edge: number, mediaType: string, quality: number }[] = []
  for (const edge of [TARGET_EDGE, FALLBACK_EDGE]) {
    const ladder = fallbackType === 'image/png' ? ['image/png', 'image/jpeg'] : [fallbackType === 'image/webp' ? 'image/webp' : 'image/jpeg']
    for (const mediaType of ladder) {
      if (mediaType === 'image/png') {
        attempts.push({ edge, mediaType, quality: 1 })
        continue
      }
      for (const quality of JPEG_QUALITY_LADDER) attempts.push({ edge, mediaType, quality })
    }
  }

  let last: { blob: Blob, width: number, height: number } | null = null
  for (const attempt of attempts) {
    const size = targetDimensions(decoded.width, decoded.height, attempt.edge)
    const blob = await encode(decoded.bitmap, size.width, size.height, attempt.mediaType, attempt.quality)
    if (blob === null) continue
    last = { blob, width: size.width, height: size.height }
    if (blob.size <= limits.maxImageBytes) {
      return {
        ok: true,
        image: {
          key,
          name,
          mediaType: attempt.mediaType,
          bytes: blob.size,
          width: size.width,
          height: size.height,
          data: await toBase64(blob),
          previewUrl: URL.createObjectURL(blob),
          compressed: true,
        },
      }
    }
  }

  const size = last === null ? '' : `（压到 ${String(last.width)}x${String(last.height)} 仍有 ${String(Math.round(last.blob.size / 1024))} KB）`
  return { ok: false, error: `${name} 压不进单张上限 ${String(Math.round(limits.maxImageBytes / 1024))} KB${size}——请先自己裁小或降质再发` }
}
