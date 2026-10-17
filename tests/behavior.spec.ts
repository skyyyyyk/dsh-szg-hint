/**
 * 行为测试：把插件当成真实宿主在跑，而不是只查接线。
 *
 * 覆盖四条链路，都是插件对外承诺的语义：
 *  1. **数据面**——起一个真实 HTTP 服务，走 `GET /dsh-szg-hint/state`、`POST`、`DELETE`、`GET /dsh-szg-hint/image/<id>/<n>`；
 *  2. **注入路径**——直接调用插件注册的 `agent/pre-step` 监听器，传真 payload、假 `next()`，
 *     检查它到底往这一步塞了什么（含被拒绝时不得吞提示的回归、以及带图时真的塞了 image 块）；
 *  3. **工具面**——模型侧 `hint_send` / `hint_status` 的契约（参数说明是模型填参依据）；
 *  4. **图片面**——准入限额、纯图提示、按「提示 id + 序号」取图、附件服务缺席时的降级。
 *
 * 装载的是 **`lib/index.js`（构建产物）而不是 `src/index.ts`（源码）**：独立仓库对外发布的
 * 就是这份产物（`package.json` 的 `exports["."].default` 指向 `lib/index.js`），`npm test`
 * 也已经串好「先 build 再跑」，所以这里测的正是用户装进宿主的那一份。产物缺失时整块跳过并
 * 提示先 build，而不是误报失败。浏览器半边是 `lib/client.js`，它的验证在真机页面上做。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFakeAttachments, tinyPng, type FakeAttachments } from './fake-attachments.ts'

const LIB = join(import.meta.dirname, '..', 'lib', 'index.js')
/** 产物缺失时的提示：本仓库的 test 脚本不串 build，直接跑 vitest 时用它告诉人该先做什么。 */
const BUILD_HINT = '缺 lib/index.js：先跑 `pnpm run build` 再跑测试'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-szg-hint-behavior-'))

/** 注册的工具：只保留模型可见的契约字段（名称、说明、参数说明）。 */
interface CapturedTool {
  name: string
  description?: string
  parameters?: { properties?: Record<string, { description?: string }> }
}

interface Captured {
  routes: { handler: (req: never, res: never) => void }[]
  tools: Map<string, CapturedTool>
  listeners: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  /** 信任围栏的返回：未设=放行；401/403=模拟未认证 / Host 不受信。 */
  rejection?: 401 | 403 | undefined
  /** 附件服务替身；传 `null` 表示「宿主没有这个服务」。 */
  attachments: FakeAttachments | null
  /** 模型服务替身：给 `inputModalities` 用来验「模型吃不吃图」的兜底分支。 */
  modalities: readonly string[] | undefined
  /**
   * 模拟「附件服务**晚于**插件 apply 挂载」：把服务塞进宿主 stub。
   * 真实宿主里服务挂载顺序不保证（`webServer` 那条实测教训），插件必须能就地升级。
   */
  lateAttach: (value: FakeAttachments) => void
}

/** 按插件真实调用顺序捕获贡献（结构与 `tests/host-runtime-probe.mjs` 对齐）。 */
function bootPlugin(
  plugin: {
    apply: (ctx: unknown, config: unknown) => void
    Config: (input: object) => unknown
    /** 声明的硬依赖；未声明却按属性取值的服务会被下面的 ctx 代理抛错。 */
    inject?: readonly string[]
  },
  rejection?: 401 | 403 | undefined,
  options: { attachments?: FakeAttachments | null, modalities?: readonly string[] } = {},
): Captured {
  const captured: Captured = {
    routes: [],
    tools: new Map(),
    listeners: new Map(),
    attachments: options.attachments === undefined ? createFakeAttachments() : options.attachments,
    modalities: options.modalities,
    lateAttach: () => {},
  }
  // `connection` 是数据面的认证闸门：宿主 stub 必须提供它，否则每个请求都会走
  // 「缺少 connection 服务」分支拿 503。默认放行；传 rejection 时模拟未认证 / Host 不受信。
  captured.rejection = rejection
  const raw: Record<string, unknown> = {
    // ★`get` 必须能取出**软依赖**：真实 cordis 里 `attachments` / `llm` 不在 inject 里，
    // 只能由 `ctx.get()` 取（属性取值会抛 `cannot get property "X" without inject`）。
    // 这个 stub 曾经只认 `webServer`，于是「插件用属性取值拿 attachments」这条真缺陷
    // 在测试里被静默放行、到宿主里才变成「加载失败」（2026-10-15 实测事故）。
    get: (name: string) => (name === 'webServer' || name === 'attachments' || name === 'llm' || name === 'connection'
      ? raw[name]
      : undefined),
    effect: (cb: () => unknown) => { const d = cb(); return () => { if (typeof d === 'function') d() } },
    on: (event: string, handler: Captured['listeners'] extends Map<string, infer H> ? H : never) => {
      captured.listeners.set(event, handler)
      return () => {}
    },
    tools: { register: (tool: CapturedTool) => { captured.tools.set(tool.name, tool); return () => {} } },
    webServer: { port: 0, register: (route: Captured['routes'][number]) => { captured.routes.push(route); return () => {} } },
    connection: { requestRejection: () => captured.rejection },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    llm: {
      resolveModelInfo: () => Promise.resolve(
        captured.modalities === undefined ? {} : { inputModalities: captured.modalities },
      ),
    },
  }
  if (captured.attachments !== null) raw['attachments'] = captured.attachments
  captured.lateAttach = (value: FakeAttachments) => { raw['attachments'] = value }
  // 未 inject 的服务按 cordis 真实语义**抛错**（而不是返回 undefined）：
  // 这样「该用 ctx.get 却写了属性取值」会在测试里当场失败，而不是等宿主报加载失败。
  const declared = new Set<string>(Array.isArray(plugin.inject) ? plugin.inject : [])
  const services = ['tools', 'webServer', 'connection', 'attachments', 'llm']
  const ctx = new Proxy(raw, {
    get: (target, prop, receiver) => {
      if (typeof prop === 'string' && services.includes(prop) && !declared.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  plugin.apply(ctx, plugin.Config({}))
  return captured
}

/** 把插件注册的 prefix 路由接到真实 http server 上。 */
async function serve(captured: Captured): Promise<{ base: string, close: () => void }> {
  const route = captured.routes[0]
  if (route === undefined) throw new Error('插件没有注册路由')
  const server = createServer((req, res) => { route.handler(req as never, res as never) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { base: `http://127.0.0.1:${String(port)}`, close: () => { server.close() } }
}

/** 注入消息里的一块内容（只收窄用例要看的那几个字段）。 */
interface InjectedBlock {
  type?: string
  text?: string
  attachment?: { attachmentId?: string, mediaType?: string }
}

/** 注入消息的结构化视图。 */
interface InjectedMessage {
  content?: InjectedBlock[]
  source?: Record<string, unknown>
}

/** 走一次 pre-step：`reject` 模拟下游插件拒绝这一步。 */
async function preStep(
  captured: Captured,
  options: {
    sessionId: string
    step?: number
    messages?: unknown[]
    reject?: boolean
    /** 本步的路由（决定「模型吃不吃图」的兜底分支）；不给就是解析不出来的情形。 */
    route?: { provider: string, model: string }
  },
): Promise<{ kind?: string, messages?: InjectedMessage[] }> {
  const handler = captured.listeners.get('agent/pre-step')
  if (handler === undefined) throw new Error('插件没有订阅 agent/pre-step')
  const base = options.messages ?? []
  return await handler(
    {
      step: options.step ?? 1,
      agent: {
        session: { id: options.sessionId },
        ...options.route === undefined ? {} : { options: { provider: options.route.provider, model: options.route.model } },
      },
      messages: base,
      signal: { aborted: false },
    },
    async () => (options.reject === true ? { kind: 'reject' } : { kind: 'enter', messages: [...base] }),
  ) as { kind?: string, messages?: InjectedMessage[] }
}

/** 取本步注入的正文（没有注入时返回空串）。 */
function injectedText(decision: { messages?: InjectedMessage[] }): string {
  const last = decision.messages?.at(-1)
  const text = last?.content?.[0]?.text ?? ''
  return text.includes('旁路提示') ? text : ''
}

/** 取本步注入的 image 块（没有就返回空数组）。 */
function injectedImages(decision: { messages?: InjectedMessage[] }): { attachmentId?: string }[] {
  const last = decision.messages?.at(-1)
  return (last?.content ?? []).filter(block => block.type === 'image').map(block => block.attachment ?? {})
}

/** 造一张真 PNG 的上行载荷（base64 + 声明类型）。 */
function pngUpload(name = 'shot.png', width = 4, height = 3): { mediaType: string, data: string, name: string } {
  return { mediaType: 'image/png', data: tinyPng(width, height).toString('base64'), name }
}

/** 走一次带图入队（返回响应与解析后的 body）。 */
async function pushHint(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number, body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/dsh-szg-hint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

/** 挂在 SSE 通道上，收集 `hint` 动作帧（前端据此弹 toast）。 */
async function collectHintFrames(baseUrl: string, run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = []
  const url = new URL('/dsh-szg-hint/events', baseUrl)
  const req = httpGet({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { accept: 'text/event-stream' } })
  await new Promise<void>((resolve, reject) => {
    req.on('response', res => {
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', (chunk: string) => {
        buffer += chunk
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          const event = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (event === 'hint' && data !== undefined) frames.push(JSON.parse(data) as Record<string, unknown>)
        }
      })
      res.on('error', () => {})
      resolve()
    })
    req.on('error', reject)
    setTimeout(() => { req.destroy() }, 4000)
  })
  await new Promise(resolve => { setTimeout(resolve, 120) })
  await run()
  await new Promise(resolve => { setTimeout(resolve, 250) })
  req.destroy()
  return frames
}

const describeIfBuilt = existsSync(LIB) ? describe : describe.skip

describeIfBuilt('dsh-szg-hint 行为（需要 lib/ 产物）', () => {
  let plugin: { apply: (ctx: unknown, config: unknown) => void, Config: (input: object) => unknown }
  let captured: Captured
  let server: { base: string, close: () => void }
  const base = (): string => server.base

  beforeAll(async () => {
    plugin = (await import(LIB)) as typeof plugin
    captured = bootPlugin(plugin)
    server = await serve(captured)
  })

  afterAll(() => {
    // 构建产物装载失败时 `beforeAll` 会抛错、`server` 从未赋值：别让清理掩盖真正的失败原因。
    if (server !== undefined) server.close()
  })

  it('空队列快照是结构完整的，前端能直接按它渲染', async () => {
    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as Record<string, unknown>
    expect(state['ok']).toBe(true)
    expect(state['pending']).toEqual([])
    expect(typeof state['maxContentChars']).toBe('number')
    expect(typeof state['revision']).toBe('number')
  })

  it('入队返回 hintId，并在快照里可见（会话作用域保留）', async () => {
    const res = await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '第一条：先别动那个文件', sessionId: 'sess-A' }),
    })
    const body = await res.json() as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body['ok']).toBe(true)
    expect(typeof body['hintId']).toBe('number')
    expect(typeof body['running']).toBe('boolean')

    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { pending: { sessionId: string }[] }
    expect(state.pending.map(i => i.sessionId)).toContain('sess-A')
  })

  it('纯空白内容与跨站来源都被拒', async () => {
    const blank = await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '  \n ' }),
    })
    expect(blank.status).toBe(400)
    const cross = await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ text: 'csrf' }),
    })
    expect(cross.status).toBe(403)
  })

  it('注入把该会话 + 全局的提示按旧→新编号塞进本步，并标记已参考', async () => {
    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '全局提示' }),
    })
    const decision = await preStep(captured, { sessionId: 'sess-A' })
    const text = injectedText(decision)
    expect(text).toContain('1. 第一条：先别动那个文件')
    expect(text).toContain('2. 全局提示')
    expect(decision.messages?.length).toBe(1)

    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { pending: unknown[], recentConsumed: { consumedAt: number }[] }
    expect(state.pending).toHaveLength(0)
    expect(state.recentConsumed.every(i => i.consumedAt > 0)).toBe(true)
  })

  it('同一会话下一步不再看到同一条提示（consumed 不重复注入）', async () => {
    const decision = await preStep(captured, { sessionId: 'sess-A', step: 2 })
    expect(injectedText(decision)).toBe('')
  })

  it('会话隔离：别的会话拿不到，拿不到会话 id 时只取全局', async () => {
    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'B 专属', sessionId: 'sess-B' }),
    })
    const forB = injectedText(await preStep(captured, { sessionId: 'sess-B' }))
    expect(forB).toContain('B 专属')
    expect(forB).not.toContain('第一条：先别动那个文件')

    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '全局二' }),
    })
    const noSession = injectedText(await preStep(captured, { sessionId: '' }))
    expect(noSession).toContain('全局二')
    expect(noSession).not.toContain('B 专属')
  })

  it('撤销三态：待参考可撤、已参考 409、不存在 404', async () => {
    const created = await (await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '待撤销', sessionId: 'sess-C' }),
    })).json() as { hintId: number }
    const del = (id: number): Promise<Response> => fetch(`${base()}/dsh-szg-hint`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
    })
    expect((await del(created.hintId)).status).toBe(200)
    expect((await del(created.hintId)).status).toBe(404)

    const consumed = await (await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '会被参考', sessionId: 'sess-D' }),
    })).json() as { hintId: number }
    await preStep(captured, { sessionId: 'sess-D' })
    expect((await del(consumed.hintId)).status).toBe(409)
  })

  it('本步被下游拒绝时回滚，下一步仍能拿到（回归：不得静默吞提示）', async () => {
    /** 已参考总数：判「有没有真的被消费」要看计数，不能看 messages 长度或最近列表（恒最多 20 条）。 */
    const consumedTotal = async (): Promise<number> => {
      const s = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { stats?: { consumed?: number } }
      return s.stats?.consumed ?? -1
    }
    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '被拒也不该丢', sessionId: 'sess-X' }),
    })
    const before = await consumedTotal()
    const rejected = await preStep(captured, { sessionId: 'sess-X', reject: true })
    expect(rejected.kind).toBe('reject')
    expect(rejected.messages).toBeUndefined()
    // 关键判据：拒绝那一步不得把提示标记成已参考（否则它既没进请求、也离开了队列）。
    expect(await consumedTotal()).toBe(before)

    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { pending: { content: string }[] }
    expect(state.pending.map(i => i.content)).toContain('被拒也不该丢')

    const recovered = await preStep(captured, { sessionId: 'sess-X', step: 2 })
    expect(injectedText(recovered)).toContain('被拒也不该丢')
    expect(await consumedTotal()).toBe(before + 1)
  })

  it('并发步骤不会拿到同一条（同步取走即标记）', async () => {
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${base()}/dsh-szg-hint`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `并发候选 ${String(i)}`, sessionId: 'sess-P' }),
      })
    }
    const decisions = await Promise.all([
      preStep(captured, { sessionId: 'sess-P' }),
      preStep(captured, { sessionId: 'sess-P' }),
      preStep(captured, { sessionId: 'sess-P' }),
    ])
    const taken = decisions.flatMap(d => injectedText(d).match(/并发候选 \d+/g) ?? [])
    expect(taken).toHaveLength(6)
    expect(new Set(taken).size).toBe(6)
  })

  it('单会话积压上限挤掉最旧一条；超长正文在注入时截断标注', async () => {
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${base()}/dsh-szg-hint`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `批量 ${String(i)}`, sessionId: 'sess-L' }),
      })
    }
    const decision = await preStep(captured, { sessionId: 'sess-L' })
    const text = injectedText(decision)
    expect((text.match(/^\d+\. /gm) ?? [])).toHaveLength(20)
    expect(text).not.toContain('批量 0')

    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'X'.repeat(3000), sessionId: 'sess-T' }),
    })
    expect(injectedText(await preStep(captured, { sessionId: 'sess-T' }))).toContain('（已截断）')
  })

  it('重启后从磁盘恢复，且不重复注入已参考的提示', async () => {
    await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '重启不该再注入', sessionId: 'sess-R' }),
    })
    await preStep(captured, { sessionId: 'sess-R' })

    const rebooted = bootPlugin(plugin)
    const restarted = await serve(rebooted)
    try {
      const state = await (await fetch(`${restarted.base}/dsh-szg-hint/state`)).json() as { pending: unknown[] }
      expect(state.pending).toHaveLength(0)
      const decision = await preStep(rebooted, { sessionId: 'sess-R' })
      expect(injectedText(decision)).toBe('')
    } finally {
      restarted.close()
    }
  })

  it('队列日志出现坏行时仍能启动（坏行跳过，不为一行数据拖垮宿主）', async () => {
    const logPath = join(process.env['DSH_HOME'] ?? '', 'dsh-szg-hint', 'hints.jsonl')
    expect(existsSync(logPath)).toBe(true)
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}{ not json at all\n`, 'utf8')

    const rebooted = bootPlugin(plugin)
    const restarted = await serve(rebooted)
    try {
      const state = await (await fetch(`${restarted.base}/dsh-szg-hint/state`)).json() as { ok: boolean }
      expect(state.ok).toBe(true)
    } finally {
      restarted.close()
    }
  })

  it('撤销回执按被撤销条目的会话广播（空串 = 全局，会让别的会话也弹提示）', async () => {
    const created = await (await fetch(`${base()}/dsh-szg-hint`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '撤销回执要认会话', sessionId: 'sess-Z' }),
    })).json() as { hintId: number }

    const frames = await collectHintFrames(base(), async () => {
      await fetch(`${base()}/dsh-szg-hint`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: created.hintId }),
      })
    })
    const cancelled = frames.find(f => f['kind'] === 'cancelled')
    expect(cancelled).toBeDefined()
    expect(cancelled?.['sessionId']).toBe('sess-Z')
    expect(String(cancelled?.['text'] ?? '')).toContain('撤销回执要认会话')
  })

  it('模型侧工具契约：hint_send 收 text/sessionId/images，hint_status 说明 `*` = 全部会话', () => {
    const send = captured.tools.get('hint_send')
    const status = captured.tools.get('hint_status')
    expect(Object.keys(send?.parameters?.properties ?? {})).toEqual(['text', 'sessionId', 'images'])
    expect(send?.description?.length ?? 0).toBeGreaterThan(20)
    expect(status?.parameters?.properties?.['sessionId']?.description).toContain('*')
  })

  it('空队列快照带上图片限额（前端据此决定附图入口是否可用）', async () => {
    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { imageLimits?: Record<string, unknown> }
    expect(state.imageLimits?.['enabled']).toBe(true)
    expect(state.imageLimits?.['maxImages']).toBe(3)
    expect(state.imageLimits?.['mediaTypes']).toContain('image/png')
  })

  it('带图入队：快照里能看到引用，图片路由按「提示 id + 序号」回吐字节', async () => {
    const upload = pngUpload('登录页报错.png', 4, 3)
    const created = await pushHint(base(), { text: '看这张报错截图', sessionId: 'sess-IMG', images: [upload] })
    expect(created.status).toBe(200)
    expect(created.body['imageCount']).toBe(1)
    const hintId = created.body['hintId'] as number

    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as {
      pending: { id: number, content: string, images: { attachmentId: string, width: number, height: number, name?: string }[] }[]
    }
    const item = state.pending.find(entry => entry.id === hintId)
    expect(item?.content).toBe('看这张报错截图')
    expect(item?.images).toHaveLength(1)
    expect(item?.images[0]?.width).toBe(4)
    expect(item?.images[0]?.height).toBe(3)
    expect(item?.images[0]?.name).toBe('登录页报错.png')
    expect(item?.images[0]?.attachmentId.startsWith('sha256:')).toBe(true)

    const image = await fetch(`${base()}/dsh-szg-hint/image/${String(hintId)}/0`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(image.headers.get('cache-control')).toContain('immutable')
    const bytes = Buffer.from(await image.arrayBuffer())
    expect(bytes.equals(tinyPng(4, 3))).toBe(true)

    // 越界序号与不存在的提示都回 404（不是空 200，也不是 500）。
    expect((await fetch(`${base()}/dsh-szg-hint/image/${String(hintId)}/3`)).status).toBe(404)
    expect((await fetch(`${base()}/dsh-szg-hint/image/999999/0`)).status).toBe(404)
    // 撤销之后图片立刻取不到（队列删了，图也就不该再被这条路由吐出来）。
    expect((await fetch(`${base()}/dsh-szg-hint`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: hintId }),
    })).status).toBe(200)
    expect((await fetch(`${base()}/dsh-szg-hint/image/${String(hintId)}/0`)).status).toBe(404)
  })

  it('纯图提示合法（不打字只发图）；两者都空才拒绝', async () => {
    const onlyImage = await pushHint(base(), { text: '   ', sessionId: 'sess-IMG2', images: [pngUpload('纯图.png')] })
    expect(onlyImage.status).toBe(200)
    expect(onlyImage.body['imageCount']).toBe(1)

    const empty = await pushHint(base(), { text: '  ', sessionId: 'sess-IMG2' })
    expect(empty.status).toBe(400)
  })

  it('图片限额：张数、单张字节、媒体类型三条闸门都在写库之前', async () => {
    const tooMany = await pushHint(base(), {
      text: '四张太多',
      sessionId: 'sess-LIMIT',
      images: [pngUpload('a.png'), pngUpload('b.png'), pngUpload('c.png'), pngUpload('d.png')],
    })
    expect(tooMany.status).toBe(400)
    expect(String(tooMany.body['error'])).toContain('最多带 3 张')

    const notImage = await pushHint(base(), {
      text: '这不是图',
      sessionId: 'sess-LIMIT',
      images: [{ mediaType: 'image/png', data: Buffer.from('definitely not a png').toString('base64'), name: 'fake.png' }],
    })
    expect(notImage.status).toBe(400)
    expect(String(notImage.body['error'])).toContain('入库失败')

    const badType = await pushHint(base(), {
      text: '类型不在白名单',
      sessionId: 'sess-LIMIT',
      images: [{ mediaType: 'image/tiff', data: pngUpload().data, name: 'x.tiff' }],
    })
    expect(badType.status).toBe(400)
    expect(String(badType.body['error'])).toContain('白名单')

    const saved = captured.attachments?.savedCount ?? 0
    const state = await (await fetch(`${base()}/dsh-szg-hint/state`)).json() as { pending: { content: string }[] }
    expect(state.pending.map(item => item.content)).not.toContain('四张太多')
    expect(state.pending.map(item => item.content)).not.toContain('这不是图')
    expect(captured.attachments?.savedCount ?? 0).toBe(saved)
  })

  it('带图注入：正文列附图清单，image 块按顺序跟在后面', async () => {
    await pushHint(base(), {
      text: '照这张参考图改',
      sessionId: 'sess-INJ-IMG',
      images: [pngUpload('参考图.png', 8, 6), pngUpload('现状.png', 2, 2)],
    })
    const decision = await preStep(captured, { sessionId: 'sess-INJ-IMG' })
    const text = injectedText(decision)
    expect(text).toContain('1. 照这张参考图改')
    expect(text).toContain('附图 1：参考图.png（8x6，image/png')
    expect(text).toContain('附图 2：现状.png（2x2，image/png')
    const images = injectedImages(decision)
    expect(images).toHaveLength(2)
    expect(images[0]?.attachmentId?.startsWith('sha256:')).toBe(true)
    // 同一张图在前面的快照里出现过：id 一致（内容寻址，不是每次重算）。
    expect(images[0]?.attachmentId).not.toBe(images[1]?.attachmentId)
  })

  it('纯图注入的正文不空：给模型一句「无文字说明，见附图」', async () => {
    await pushHint(base(), { text: '', sessionId: 'sess-INJ-ONLY', images: [pngUpload('只看图.png')] })
    const decision = await preStep(captured, { sessionId: 'sess-INJ-ONLY' })
    const text = injectedText(decision)
    expect(text).toContain('1. （无文字说明，见附图）')
    expect(injectedImages(decision)).toHaveLength(1)
  })

  it('本步模型不吃图时，正文补上本机只读副本路径（让 agent 能自己去读）', async () => {
    const textOnly = bootPlugin(plugin, undefined, { modalities: ['text'] })
    const textOnlyServer = await serve(textOnly)
    try {
      await pushHint(textOnlyServer.base, {
        text: '这张图你看一下',
        sessionId: 'sess-TEXTONLY',
        images: [pngUpload('只有文字模型.png')],
      })
      const decision = await preStep(textOnly, {
        sessionId: 'sess-TEXTONLY',
        route: { provider: 'p', model: 'text-only' },
      })
      expect(injectedText(decision)).toContain('本步模型不接受图片输入')
      expect(injectedText(decision)).toContain('C:/fake/attachments/')
      // 图块照旧带上：投影成占位文字由核心决定，插件不替它做决定。
      expect(injectedImages(decision)).toHaveLength(1)
    } finally {
      textOnlyServer.close()
    }
  })

  it('附件服务缺席：图片入口整体降级，纯文字照常', async () => {
    const withoutAttachments = bootPlugin(plugin, undefined, { attachments: null })
    const bare = await serve(withoutAttachments)
    try {
      const state = await (await fetch(`${bare.base}/dsh-szg-hint/state`)).json() as { imageLimits?: Record<string, unknown> }
      expect(state.imageLimits?.['enabled']).toBe(false)

      const rejected = await pushHint(bare.base, { text: '带图但不支持', sessionId: 'sess-NOATT', images: [pngUpload()] })
      expect(rejected.status).toBe(400)
      expect(String(rejected.body['error'])).toContain('附件服务')

      const textOnly = await pushHint(bare.base, { text: '纯文字照常', sessionId: 'sess-NOATT' })
      expect(textOnly.status).toBe(200)
    } finally {
      bare.close()
    }
  })

  it('工具面：hint_send 能按本机路径附图，hint_status 报出图数', async () => {
    const send = captured.tools.get('hint_send') as unknown as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
    }
    const status = captured.tools.get('hint_status') as unknown as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<string>
    }
    const pngPath = join(process.env['DSH_HOME'] ?? '', 'tool-shot.png')
    writeFileSync(pngPath, tinyPng(6, 5))

    const sent = await send.execute({ text: '工具发的图', sessionId: 'sess-TOOL', images: [pngPath] }, { agent: { session: { id: 'sess-TOOL' } } })
    expect(sent).toContain('含 1 张图')

    const reported = await status.execute({ sessionId: 'sess-TOOL' }, { agent: { session: { id: 'sess-TOOL' } } })
    expect(reported).toContain('工具发的图')
    expect(reported).toContain('含 1 张图')
    expect(reported).toContain('图片能力：可用')

    const missing = await send.execute({ text: '路径不存在', sessionId: 'sess-TOOL', images: ['C:/nope/not-here.png'] }, {})
    expect(missing).toContain('未投递')
    const wrongType = await send.execute({ text: '不是图', sessionId: 'sess-TOOL', images: [join(process.env['DSH_HOME'] ?? '', 'note.txt')] }, {})
    expect(wrongType).toContain('不是支持的图片后缀')
  })
})

describeIfBuilt('数据面的来源校验（信任围栏）', () => {
  let plugin: { apply: (ctx: unknown, config: unknown) => void, Config: (input: object) => unknown }
  let captured: Captured
  let server: { base: string, close: () => void }

  beforeAll(async () => {
    // 与主行为块同一装载方式：产物动态导入（跳过场景下不会被求值）。
    plugin = (await import(LIB)) as typeof plugin
    captured = bootPlugin(plugin)
    server = await serve(captured)
  })

  afterAll(() => {
    // 构建产物缺失时 `beforeAll` 里的 serve 会抛错，`server` 从未赋值：别让清理掩盖失败原因。
    if (server !== undefined) server.close()
  })

  /** 带 redirect:manual —— 否则 fetch 会把 3xx / 4xx 处理得看不出原始状态。 */
  const getState = (): Promise<Response> => fetch(`${server.base}/dsh-szg-hint/state`, { redirect: 'manual' })

  const writeHint = (): Promise<Response> => fetch(`${server.base}/dsh-szg-hint`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '未认证也不该写进来', sessionId: '' }),
  })

  it('放行时不拦（页面已认证的正常路径）', async () => {
    captured.rejection = undefined
    expect((await getState()).status).toBe(200)
  })

  it('信任围栏判 401 时读接口被拒（不再泄露队列内容）', async () => {
    captured.rejection = 401
    const res = await getState()
    expect(res.status).toBe(401)
    const body = await res.json() as { ok?: boolean }
    expect(body.ok).toBe(false)
  })

  it('信任围栏判 401 时写接口被拒（否则任何人可向任务注入指令）', async () => {
    captured.rejection = 401
    expect((await writeHint()).status).toBe(401)
    captured.rejection = undefined
    const seen = await (await getState()).json() as { pending?: { content?: string }[] }
    expect((seen.pending ?? []).some(x => x.content === '未认证也不该写进来')).toBe(false)
  })

  it('信任围栏判 401 时取图接口同样被拒（图片也不能裸奔）', async () => {
    captured.rejection = undefined
    const created = await pushHint(server.base, { text: '取图围栏', sessionId: 'sess-FENCE', images: [pngUpload('围栏.png')] })
    const hintId = created.body['hintId'] as number
    expect((await fetch(`${server.base}/dsh-szg-hint/image/${String(hintId)}/0`)).status).toBe(200)

    captured.rejection = 401
    expect((await fetch(`${server.base}/dsh-szg-hint/image/${String(hintId)}/0`)).status).toBe(401)
    captured.rejection = undefined
  })

  it('信任围栏判 403 时按 403 回（Host 不受信）', async () => {
    captured.rejection = 403
    expect((await getState()).status).toBe(403)
    captured.rejection = undefined
  })
})

describeIfBuilt('附件服务晚挂载（软依赖就地升级）', () => {
  it('插件先加载、服务后到：不必重启，下一次请求就启用图片', async () => {
    const plugin = (await import(LIB)) as {
      apply: (ctx: unknown, config: unknown) => void
      Config: (input: object) => unknown
    }
    // 宿主此刻还没有附件服务（`attachments: null`）：插件必须照常加载，图片先按降级快照。
    const captured = bootPlugin(plugin, undefined, { attachments: null })
    const server = await serve(captured)
    /** 读一次快照里的图片限额（前端据此决定附图入口能不能用）。 */
    const readLimits = async (): Promise<{ enabled?: boolean } | undefined> => {
      const body = await (await fetch(`${server.base}/dsh-szg-hint/state`)).json() as {
        imageLimits?: { enabled?: boolean }
      }
      return body.imageLimits
    }
    try {
      expect((await readLimits())?.enabled).toBe(false)
      // 服务此刻才挂上（真实宿主里 include:attachment-local 可能晚于本条目激活）。
      captured.lateAttach(createFakeAttachments())
      expect((await readLimits())?.enabled).toBe(true)
    } finally {
      server.close()
    }
  })
})

describeIfBuilt('构建产物缺失时的提示', () => {
  it.runIf(!existsSync(LIB))('跳过行为测试', () => { console.warn(BUILD_HINT) })
})
