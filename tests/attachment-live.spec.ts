/**
 * 真附件服务集成用例：拿**真的** `@deepseek-ai/dsh-attachment-local` 跑一遍插件的调用形状。
 *
 * 为什么值得单独钉一条：图片链路上「插件 ↔ 附件服务」是唯一一段替身测不到的接缝——
 * 插件的 `saveImages` / `readImage` / `imageHostPath` 三个调用是**结构型**写的（不引跨包类型），
 * 形状写错了替身也不会报错，但线上会 500。这里用真服务验四件事：
 *  1. `saveImages([{ data: Uint8Array, mediaType, name }])` 收得下（含中文展示名）；
 *  2. 返回的引用形状与队列里存的 `HintImageRef` 对得上（sha256 前缀、尺寸、字节、名字）；
 *  3. `readImage(ref)` 能把字节读回来（取图路由干的正是这件事）；
 *  4. `imageHostPath(ref)` 给的路径真实可读（文本-only 路由的兜底通道）。
 * 另加两条拒绝路径：坏字节、超过单张上限。
 *
 * 这三个依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-attachment-local`、`sharp`）都不在本仓库的
 * devDependencies 里，独立 checkout 出来跑测试时可能一个都没有，所以：
 *  - 依赖**全部动态解析**：包名走常量，`import(常量)` 的类型是 any——缺包时连 tsc 也不会报
 *    「找不到模块」，整个测试文件更不会因为顶层静态 import 失败而加载不起来；
 *  - 任一不可用就整块 `describe.skip`，并在采集阶段打印「缺什么」；
 *  - `sharp` **不硬编码任何 monorepo 路径**（写死 `../../../source/node_modules/sharp` 在别人
 *    checkout 出来的仓库里必然指空），只按模块解析的三条基准去找：本文件 → 附件服务包内部 →
 *    一次裸 `import`。
 *
 * @module dsh-szg-hint/tests/attachment-live
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { tinyPng } from './fake-attachments.ts'

/** 包名写成常量：动态 import 才不会把「包不在」变成编译期错误。 */
const CORDIS_PACKAGE = '@deepseek-ai/cordis'
const ATTACHMENT_PACKAGE = '@deepseek-ai/dsh-attachment-local'
const SHARP_PACKAGE = 'sharp'

/** 真附件服务的对外形状（只声明本用例真正用到的那三个方法）。 */
interface LiveStore {
  saveImages(inputs: readonly { data: Uint8Array, mediaType: string, name?: string }[]): Promise<readonly {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }[]>
  readImage(ref: { attachmentId: string }): Promise<{ ref: { attachmentId: string }, data: Uint8Array }>
  imageHostPath(ref: { attachmentId: string }): string
}

/** 环境探测结果：缺件时把原因带上，跳过才有信息量。 */
interface LiveEnv {
  ok: boolean
  reason: string
  Context?: new () => unknown
  LocalAttachmentStore?: new (ctx: unknown, config: Record<string, unknown>) => LiveStore
}

/** 一条错误压成一行（跳过提示要短）。 */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.split('\n')[0] ?? text
}

/**
 * 从给定入口（file URL / 绝对路径）解析模块。
 * @param base - `createRequire` 的基准（一个文件的 URL 或路径）。
 * @param specifier - 要解析的包名。
 * @returns 落盘路径；解析不到时 undefined。
 */
function resolveFrom(base: string, specifier: string): string | undefined {
  try {
    return createRequire(base).resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * `import.meta.resolve` 在旧运行时可能缺席：按结构取，缺了返回 undefined 而不是炸掉整个文件。
 * @param specifier - 要解析的包名。
 * @returns 解析结果 URL；拿不到时 undefined。
 */
function importMetaResolve(specifier: string): string | undefined {
  const resolve = (import.meta as unknown as { resolve?: (id: string) => string }).resolve
  if (typeof resolve !== 'function') return undefined
  try {
    return resolve(specifier)
  } catch {
    return undefined
  }
}

/**
 * 找 `sharp`：绝不硬编码路径，按模块解析走三条基准。
 * @param attachmentEntry - 附件服务入口（解析得到时才有；拿它当基准能覆盖 pnpm 的包内依赖）。
 * @returns 可解析证据（路径或 import 成功标记）；都找不到时 undefined。
 */
async function findSharp(attachmentEntry: string | undefined): Promise<string | undefined> {
  const fromHere = resolveFrom(import.meta.url, SHARP_PACKAGE)
  if (fromHere !== undefined) return fromHere
  if (attachmentEntry !== undefined) {
    const fromPackage = resolveFrom(attachmentEntry, SHARP_PACKAGE)
    if (fromPackage !== undefined) return fromPackage
  }
  try {
    await import(SHARP_PACKAGE)
    return `import('${SHARP_PACKAGE}') 成功`
  } catch {
    return undefined
  }
}

/**
 * 探测真服务依赖是否齐备（顶层 await：缺件只影响本文件，其它用例照跑）。
 * @returns 探测结论；缺件时 `reason` 写清缺什么。
 */
async function probeLiveEnv(): Promise<LiveEnv> {
  const problems: string[] = []
  let Context: LiveEnv['Context']
  let LocalAttachmentStore: LiveEnv['LocalAttachmentStore']

  try {
    const mod = (await import(CORDIS_PACKAGE)) as { Context?: LiveEnv['Context'] }
    Context = mod.Context
    if (Context === undefined) problems.push(`${CORDIS_PACKAGE} 没有导出 Context`)
  } catch (error) {
    problems.push(`${CORDIS_PACKAGE} 加载失败（${oneLine(error)}）`)
  }

  try {
    const mod = (await import(ATTACHMENT_PACKAGE)) as { default?: LiveEnv['LocalAttachmentStore'] }
    LocalAttachmentStore = mod.default
    if (LocalAttachmentStore === undefined) problems.push(`${ATTACHMENT_PACKAGE} 没有 default 导出`)
  } catch (error) {
    problems.push(`${ATTACHMENT_PACKAGE} 加载失败（${oneLine(error)}）`)
  }

  // 入口路径只用来给 sharp 换一个解析基准（纯加分项：解析不到不影响上面的结论）。
  const entry = resolveFrom(import.meta.url, ATTACHMENT_PACKAGE) ?? importMetaResolve(ATTACHMENT_PACKAGE)
  const sharp = await findSharp(entry)
  if (sharp === undefined) problems.push(`${SHARP_PACKAGE} 解析不到（真服务解码/归一化要用它）`)

  return problems.length === 0
    ? { ok: true, reason: `${SHARP_PACKAGE} → ${String(sharp)}`, Context, LocalAttachmentStore }
    : { ok: false, reason: problems.join('；'), Context, LocalAttachmentStore }
}

const LIVE_ENV = await probeLiveEnv()

const dirs: string[] = []
afterAll(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 建一个真附件服务（数据落在临时目录，绝不碰真实 `$DSH_HOME`）。
 * @param overrides - 覆盖配置（如单张字节上限）。
 * @returns 服务实例与它的临时 dsh home。
 */
function makeStore(overrides: Record<string, unknown> = {}): { store: LiveStore, dshHome: string } {
  const { Context, LocalAttachmentStore } = LIVE_ENV
  if (Context === undefined || LocalAttachmentStore === undefined) {
    throw new Error(`真附件服务依赖不齐备：${LIVE_ENV.reason}`)
  }
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-szg-hint-attachment-'))
  dirs.push(dshHome)
  return { store: new LocalAttachmentStore(new Context(), { dshHome, ...overrides }), dshHome }
}

const describeIfLive = LIVE_ENV.ok ? describe : describe.skip

// 采集阶段就打印结论：整块跳过时也能在输出里看到「为什么没跑」。
if (LIVE_ENV.ok) console.info(`真附件服务集成用例环境：${LIVE_ENV.reason}`)
else console.warn(`跳过真附件服务集成用例：${LIVE_ENV.reason}`)

describe('真附件服务 · 环境探测', () => {
  it('探测有结论（缺件时整块集成用例跳过，原因已打印到控制台）', () => {
    // 这条永远执行：本文件不会「无声跳过」，探测结论本身也进断言。
    expect(typeof LIVE_ENV.ok).toBe('boolean')
    expect(LIVE_ENV.reason.length).toBeGreaterThan(0)
  })
})

describeIfLive('真附件服务 · 插件调用形状', () => {
  it('落库 → 引用形状 → 读回字节 → 本机路径可读', async () => {
    const { store } = makeStore()
    const bytes = tinyPng(12, 7)
    const refs = await store.saveImages([{
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
      name: '登录页报错.png',
    }])
    expect(refs).toHaveLength(1)
    const ref = refs[0]!
    expect(String(ref.attachmentId).startsWith('sha256:')).toBe(true)
    expect(ref.mediaType).toBe('image/png')
    expect(ref.width).toBe(12)
    expect(ref.height).toBe(7)
    expect(ref.name).toBe('登录页报错.png')

    const stored = await store.readImage(ref)
    expect(stored.data.byteLength).toBe(ref.bytes)
    expect(stored.ref.attachmentId).toBe(ref.attachmentId)

    const hostPath = store.imageHostPath(ref)
    expect(typeof hostPath).toBe('string')
    expect(existsSync(hostPath as string)).toBe(true)
    expect(readFileSync(hostPath as string).byteLength).toBeGreaterThan(0)

    // 同一张图再存一次：内容寻址 ⇒ 同一个 id（前端缩略图因此可以放心长缓存）。
    const again = await store.saveImages([{ data: new Uint8Array(bytes), mediaType: 'image/png' }])
    expect(again[0]?.attachmentId).toBe(ref.attachmentId)
  })

  it('坏字节与超过单张上限都被拒（插件的 400 文案正是接住这两类）', async () => {
    const { store } = makeStore({ maxImageBytes: 512 })

    await expect(store.saveImages([{
      data: new TextEncoder().encode('definitely not a png'),
      mediaType: 'image/png',
      name: 'fake.png',
    }])).rejects.toThrow()

    // 600x600 的纯色 PNG 压完约 1.4KB，超过上面设的 512 字节上限 ⇒ 拒绝（不是帮你缩）。
    await expect(store.saveImages([{
      data: new Uint8Array(tinyPng(600, 600)),
      mediaType: 'image/png',
    }])).rejects.toThrow()
  })
})
