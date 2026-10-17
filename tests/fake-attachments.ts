/**
 * 测试用的假附件服务与真 PNG 字节。
 *
 * 为什么要有这一份：图片链路的关键契约（**整批落库、内容寻址、按引用读回**）由
 * `ctx.attachments` 承担，插件只是调用方。行为测试要验的是「插件有没有正确地把图交给它、
 * 又能不能把引用还原成内容块与字节」，所以这里给一个**够真**的替身：
 *
 *  - id 真的按 sha256 算（内容寻址，同图同 id，与真实现一致）；
 *  - 落库前真的校验字节（PNG/JPEG/GIF/WebP 的魔数、声明类型要匹配、张数与字节上限）；
 *  - PNG 的宽高从 IHDR 真读出来（不是写死的 1x1）。
 *
 * `tinyPng()` 生成的是**合法 PNG 字节**（IHDR + deflate 过的 IDAT + 正确的 CRC），
 * 所以同一批用例也能拿去打真宿主（sharp 解得开），不是只在替身里自洽的假数据。
 *
 * @module dsh-szg-hint/tests/fake-attachments
 */

import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

/** 替身里存的一张图。 */
interface StoredImage {
  bytes: Uint8Array
  mediaType: string
  width: number
  height: number
  name?: string
}

/** 落库入参（与真服务的 `SaveImageAttachment` 同形）。 */
interface SaveInput {
  data: Uint8Array
  mediaType: string
  name?: string
}

/** 替身对外形状（插件只用到这三件事 + `imageLimits`）。 */
export interface FakeAttachments {
  readonly imageLimits: {
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    maxImagePixels: number
    maxImageDimension: number
    mediaTypes: readonly string[]
  }
  /** 落库成功的张数（用例据此判「有没有真落库」）。 */
  readonly savedCount: number
  saveImages(inputs: readonly SaveInput[]): Promise<readonly {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }[]>
  readImage(ref: { attachmentId: string }): Promise<{ ref: StoredImage & { attachmentId: string }, data: Uint8Array }>
  imageHostPath(ref: { attachmentId: string }): string
}

/** CRC32 查表（PNG 每个 chunk 都要）。 */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC32。
 * @param buffer - 待计算字节。
 * @returns 无符号 32 位校验值。
 */
function crc32(buffer: Buffer): number {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/**
 * 造一张合法的 RGBA PNG（默认 1x1 全透明）。
 * @param width - 宽。
 * @param height - 高。
 * @returns PNG 字节。
 */
export function tinyPng(width = 1, height = 1): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 按魔数判真实媒体类型。
 * @param bytes - 文件字节。
 * @returns 媒体类型；不是受支持的图片时 undefined。
 */
function sniff(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12))
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && head.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * 读 PNG 的 IHDR 宽高（非 PNG 给 1x1）。
 * @param bytes - 文件字节。
 * @returns 宽高。
 */
function dimensionsOf(bytes: Uint8Array): { width: number, height: number } {
  const buffer = Buffer.from(bytes)
  if (buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  return { width: 1, height: 1 }
}

/**
 * 建一个假附件服务。
 * @param options - 覆盖限额（默认与真部署一致：单张 20MB / 单条 20 张）。
 * @returns 替身服务。
 */
export function createFakeAttachments(options: {
  maxImageBytes?: number
  maxImagesPerMessage?: number
  maxMessageImageBytes?: number
} = {}): FakeAttachments {
  const maxImageBytes = options.maxImageBytes ?? 20 * 1024 * 1024
  const maxImagesPerMessage = options.maxImagesPerMessage ?? 20
  const maxMessageImageBytes = options.maxMessageImageBytes ?? 200 * 1024 * 1024
  const objects = new Map<string, StoredImage>()
  let savedCount = 0

  return {
    imageLimits: {
      maxImageBytes,
      maxImagesPerMessage,
      maxMessageImageBytes,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    get savedCount() { return savedCount },
    async saveImages(inputs) {
      if (inputs.length > maxImagesPerMessage) throw new Error(`too many images: ${String(inputs.length)}`)
      let total = 0
      const refs = inputs.map(input => {
        const bytes = Uint8Array.from(input.data)
        total += bytes.byteLength
        if (bytes.byteLength > maxImageBytes) throw new Error('image exceeds the per-image byte limit')
        const actual = sniff(bytes)
        if (actual === undefined) throw new Error('image bytes are not a supported raster format')
        if (actual !== input.mediaType) throw new Error(`declared ${input.mediaType} but bytes are ${actual}`)
        const { width, height } = dimensionsOf(bytes)
        const attachmentId = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
        objects.set(attachmentId, {
          bytes,
          mediaType: actual,
          width,
          height,
          ...input.name === undefined ? {} : { name: input.name },
        })
        savedCount += 1
        return {
          attachmentId,
          mediaType: actual,
          bytes: bytes.byteLength,
          width,
          height,
          ...input.name === undefined ? {} : { name: input.name },
        }
      })
      if (total > maxMessageImageBytes) throw new Error('image batch exceeds the aggregate byte limit')
      return refs
    },
    async readImage(ref) {
      const stored = objects.get(ref.attachmentId)
      if (stored === undefined) throw new Error(`unknown attachment ${ref.attachmentId}`)
      return {
        ref: { ...stored, attachmentId: ref.attachmentId },
        data: Uint8Array.from(stored.bytes),
      }
    },
    imageHostPath(ref) {
      return `C:/fake/attachments/${ref.attachmentId.replace(/[^A-Za-z0-9]/g, '_')}.png`
    },
  }
}
