/**
 * 图片链路里**纯函数**的契约测试：宿主侧的准入校验与文案、浏览器侧的尺寸换算。
 *
 * 这两处都是「错了不会崩、但会静默给出错结果」的地方，所以单独钉住：
 *  - 宿主准入：白名单、张数、单张/合计字节、非规范 base64、空数据，各自要给出能读懂的原因；
 *  - 浏览器缩放：等比、不放大、极端长宽比不塌成 0。
 *
 * @module dsh-szg-hint/tests/images
 */

import { describe, expect, it } from 'vitest'
import { targetDimensions } from '../src/client/image-prep.ts'
import { describeImage, formatBytes, mediaTypeForPath, parseImageUploads } from '../src/images.ts'
import type { HintImageLimits } from '../src/protocol.ts'

/** 与插件默认配置一致的限额（单条 3 张、单张 4MB、合计 12MB）。 */
const LIMITS: HintImageLimits = {
  enabled: true,
  maxImages: 3,
  maxImageBytes: 4 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** 造一张声明大小的 base64（内容无所谓，这里只验结构校验）。 */
function payload(bytes: number): string {
  return Buffer.alloc(bytes).toString('base64')
}

describe('parseImageUploads', () => {
  it('没有 images 字段 = 纯文字提示（返回空清单，不是错误）', () => {
    expect(parseImageUploads(undefined, LIMITS)).toEqual({ ok: true, uploads: [] })
    expect(parseImageUploads(null, LIMITS)).toEqual({ ok: true, uploads: [] })
    expect(parseImageUploads([], LIMITS)).toEqual({ ok: true, uploads: [] })
  })

  it('收下合规的清单，并保留展示名', () => {
    const result = parseImageUploads([
      { mediaType: 'image/png', data: payload(16), name: '  截图.png  ' },
      { mediaType: 'image/jpeg', data: payload(32) },
    ], LIMITS)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.uploads.length : 0).toBe(2)
    expect(result.ok ? result.uploads[0]?.name : undefined).toBe('截图.png')
    expect(result.ok ? result.uploads[1]?.name : 'x').toBeUndefined()
  })

  it('类型不在白名单 / 数据为空 / 不是数组：都给能读懂的中文原因', () => {
    const tiff = parseImageUploads([{ mediaType: 'image/tiff', data: payload(8) }], LIMITS)
    expect(tiff.ok).toBe(false)
    expect(tiff.ok ? '' : tiff.error).toContain('白名单')

    const empty = parseImageUploads([{ mediaType: 'image/png', data: '' }], LIMITS)
    expect(empty.ok ? '' : empty.error).toContain('数据为空')

    const notArray = parseImageUploads({ mediaType: 'image/png' }, LIMITS)
    expect(notArray.ok ? '' : notArray.error).toContain('必须是数组')

    const notObject = parseImageUploads([42], LIMITS)
    expect(notObject.ok ? '' : notObject.error).toContain('不是对象')
  })

  it('张数超限报出实际收到几张（用户一眼知道该怎么改）', () => {
    const result = parseImageUploads(
      Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data: payload(8) })),
      LIMITS,
    )
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('最多带 3 张')
    expect(result.ok ? '' : result.error).toContain('收到 4 张')
  })

  it('单张与合计字节两条线都在解码前先粗筛掉', () => {
    const tooBig = parseImageUploads([{ mediaType: 'image/png', data: payload(5 * 1024 * 1024) }], LIMITS)
    expect(tooBig.ok).toBe(false)
    expect(tooBig.ok ? '' : tooBig.error).toContain('超过单张上限')

    const tooMuch = parseImageUploads([
      { mediaType: 'image/png', data: payload(3 * 1024 * 1024) },
      { mediaType: 'image/png', data: payload(3 * 1024 * 1024) },
      { mediaType: 'image/png', data: payload(3 * 1024 * 1024) },
      { mediaType: 'image/png', data: payload(3 * 1024 * 1024) },
    ], { ...LIMITS, maxImages: 10, maxTotalBytes: 8 * 1024 * 1024 })
    expect(tooMuch.ok).toBe(false)
    expect(tooMuch.ok ? '' : tooMuch.error).toContain('超过单条上限')
  })

  it('非规范 base64 直接拒（否则解码器会「猜」出别的字节）', () => {
    const messy = parseImageUploads([{ mediaType: 'image/png', data: 'not base64 !!!' }], LIMITS)
    expect(messy.ok).toBe(false)
    expect(messy.ok ? '' : messy.error).toContain('base64')
  })

  it('附件服务缺席时图片一律拒（纯文字提示不受影响）', () => {
    const disabled = parseImageUploads([{ mediaType: 'image/png', data: payload(8) }], { ...LIMITS, enabled: false })
    expect(disabled.ok).toBe(false)
    expect(disabled.ok ? '' : disabled.error).toContain('附件服务')
  })
})

describe('mediaTypeForPath', () => {
  it('按后缀判类型，大小写与 .jpeg 都认', () => {
    expect(mediaTypeForPath('C:/a/b.png')).toBe('image/png')
    expect(mediaTypeForPath('C:/a/b.JPG')).toBe('image/jpeg')
    expect(mediaTypeForPath('/tmp/x.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForPath('webp.webp')).toBe('image/webp')
    expect(mediaTypeForPath('C:/a/b.txt')).toBeUndefined()
    expect(mediaTypeForPath('C:/a/noext')).toBeUndefined()
  })
})

describe('formatBytes / describeImage', () => {
  it('字节文案按量级切换单位', () => {
    expect(formatBytes(820)).toBe('820 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  it('附图文案给序号、名字、尺寸、类型与大小（模型据此知道哪张是哪条）', () => {
    expect(describeImage(2, {
      attachmentId: 'sha256:x',
      mediaType: 'image/png',
      bytes: 319_488,
      width: 1600,
      height: 900,
      name: 'shot.png',
    })).toBe('附图 2：shot.png（1600x900，image/png，312 KB）')

    expect(describeImage(1, {
      attachmentId: 'sha256:y',
      mediaType: 'image/jpeg',
      bytes: 100,
      width: 2,
      height: 2,
    })).toContain('未命名')
  })
})

describe('targetDimensions', () => {
  it('等比缩到最长边，不放大原图', () => {
    expect(targetDimensions(3200, 1800, 1600)).toEqual({ width: 1600, height: 900 })
    expect(targetDimensions(1800, 3200, 1600)).toEqual({ width: 900, height: 1600 })
    expect(targetDimensions(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })

  it('极端长宽比不塌成 0 宽/0 高', () => {
    expect(targetDimensions(10_000, 3, 1600)).toEqual({ width: 1600, height: 1 })
    expect(targetDimensions(0, 0, 1600)).toEqual({ width: 0, height: 0 })
  })
})
