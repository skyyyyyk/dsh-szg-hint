/**
 * 行为测试：把插件当成真实宿主在跑，而不是只查接线。
 *
 * 覆盖三条链路，都是插件对外承诺的语义：
 *  1. **数据面**——起一个真实 HTTP 服务，走 `GET /dsh-szg-hint/state`、`POST`、`DELETE`；
 *  2. **注入路径**——直接调用插件注册的 `agent/pre-step` 监听器，传真 payload、假 `next()`，
 *     检查它到底往这一步塞了什么（含被拒绝时不得吞提示的回归）；
 *  3. **工具面**——模型侧 `hint_send` / `hint_status` 的契约（参数说明是模型填参依据）。
 *
 * 依赖 `lib/`（`npm test` 前会先 build）：产物缺失时整个文件跳过并说明原因，而不是误报失败。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, get as httpGet } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const LIB = join(import.meta.dirname, '..', 'lib', 'index.js')
const BUILD_HINT = '缺 lib/index.js：先跑 `npm run build` 再跑测试（或直接 `npm test`，它已串好顺序）'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-szg-hint-behavior-'))

interface Captured {
  routes: { handler: (req: never, res: never) => void }[]
  tools: Map<string, { description?: string, parameters?: { properties?: Record<string, { description?: string }> } }>
  listeners: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
}

/** 按插件真实调用顺序捕获贡献（结构与 `tests/host-runtime-probe.mjs` 对齐）。 */
function bootPlugin(plugin: { apply: (ctx: unknown, config: unknown) => void, Config: (input: object) => unknown }): Captured {
  const captured: Captured = { routes: [], tools: new Map(), listeners: new Map() }
  const ctx = {
    get: (name: string) => (name === 'webServer' ? ctx.webServer : undefined),
    effect: (cb: () => unknown) => { const d = cb(); return () => { if (typeof d === 'function') d() } },
    on: (event: string, handler: Captured['listeners'] extends Map<string, infer H> ? H : never) => {
      captured.listeners.set(event, handler)
      return () => {}
    },
    tools: { register: (tool: { name: string }) => { captured.tools.set(tool.name, tool); return () => {} } },
    webServer: { port: 0, register: (route: Captured['routes'][number]) => { captured.routes.push(route); return () => {} } },
    logger: { warn: () => {}, error: () => {}, info: () => {} },
  }
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

/** 走一次 pre-step：`reject` 模拟下游插件拒绝这一步。 */
async function preStep(
  captured: Captured,
  options: { sessionId: string, step?: number, messages?: unknown[], reject?: boolean },
): Promise<{ kind?: string, messages?: { content?: { text?: string }[], source?: Record<string, unknown> }[] }> {
  const handler = captured.listeners.get('agent/pre-step')
  if (handler === undefined) throw new Error('插件没有订阅 agent/pre-step')
  const base = options.messages ?? []
  return await handler(
    { step: options.step ?? 1, agent: { session: { id: options.sessionId } }, messages: base, signal: { aborted: false } },
    async () => (options.reject === true ? { kind: 'reject' } : { kind: 'enter', messages: [...base] }),
  ) as { kind?: string, messages?: { content?: { text?: string }[] }[] }
}

/** 取本步注入的正文（没有注入时返回空串）。 */
function injectedText(decision: { messages?: { content?: { text?: string }[] }[] }): string {
  const last = decision.messages?.at(-1)
  const text = last?.content?.[0]?.text ?? ''
  return text.includes('旁路提示') ? text : ''
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

  afterAll(() => { server.close() })

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

  it('模型侧工具契约：hint_send 收 text/sessionId，hint_status 说明 `*` = 全部会话', () => {
    const send = captured.tools.get('hint_send')
    const status = captured.tools.get('hint_status')
    expect(Object.keys(send?.parameters?.properties ?? {})).toEqual(['text', 'sessionId'])
    expect(send?.description?.length ?? 0).toBeGreaterThan(20)
    expect(status?.parameters?.properties?.['sessionId']?.description).toContain('*')
  })
})

describeIfBuilt('构建产物缺失时的提示', () => {
  it.runIf(!existsSync(LIB))('跳过行为测试', () => { console.warn(BUILD_HINT) })
})
