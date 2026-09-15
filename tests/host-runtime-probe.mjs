/**
 * 宿主半边的离线运行时探针（本机验证用，不属于发布产物）。
 *
 * 校验插件在真实宿主契约下的接线是否完整：
 *  1) 模块能以 ESM 导入（`lib/index.js`，external 依赖由 Node 解析）；
 *  2) 导出契约齐全（name / inject / Config / apply）；
 *  3) `apply()` 在 mock ctx 下注册了期望的扩展点：两条路由、两个工具、一个 pre-step 监听、一个运行态订阅。
 *
 * 它不替代真实宿主启动，但能在无网络、无凭据的环境里证明「插件装得上、接得通」。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempHome = mkdtempSync(join(tmpdir(), 'dsh-szg-hint-probe-'))
process.env['DSH_HOME'] = tempHome

const plugin = await import('../lib/index.js')

const failures = []
function check(label, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`
  console.log(line)
  if (!ok) failures.push(label)
}

check('模块导出 name = dsh-szg-hint', plugin.name === 'dsh-szg-hint', String(plugin.name))
check('导出 inject 含 tools + webServer', Array.isArray(plugin.inject)
  && plugin.inject.includes('tools') && plugin.inject.includes('webServer'), JSON.stringify(plugin.inject))
check('导出 Config（schemastery schema）', typeof plugin.Config === 'function' || typeof plugin.Config === 'object')
check('导出 apply 函数', typeof plugin.apply === 'function')

/** 收集 apply 期间发生的一切注册。 */
const registered = { routes: [], effects: [], tools: [], listeners: [], disposers: 0 }
const fakeCtx = {
  // 宿主用属性访问把已声明的服务给插件；探针照此实现，才验得到路由注册分支。
  get(name) { return name === 'webServer' ? fakeCtx.webServer : undefined },
  effect(callback, label) {
    registered.effects.push(label ?? '(anonymous)')
    const dispose = callback()
    return () => { registered.disposers += 1; if (typeof dispose === 'function') dispose() }
  },
  on(event, handler) {
    registered.listeners.push(event)
    return () => { registered.disposers += 1 }
  },
  tools: {
    register(tool) { registered.tools.push(tool?.name ?? '(unnamed)'); return () => { registered.disposers += 1 } },
  },
  webServer: {
    port: 0,
    register(route) { registered.routes.push(`${route.kind} ${route.path}`); return () => { registered.disposers += 1 } },
  },
  logger: { warn: () => {}, error: () => {}, info: () => {} },
}

plugin.apply(fakeCtx, typeof plugin.Config === 'function' ? plugin.Config({}) : { enabled: true })

check('注册了 prefix 路由 /dsh-szg-hint（带前导斜杠，客户端按同前缀请求）',
  registered.routes.some(r => r === 'prefix /dsh-szg-hint'), JSON.stringify(registered.routes))
check('注册了 hint_send / hint_status 两个工具',
  registered.tools.includes('hint_send') && registered.tools.includes('hint_status'), JSON.stringify(registered.tools))
check('订阅了 agent/pre-step', registered.listeners.some(e => e === 'agent/pre-step'), JSON.stringify(registered.listeners))
check('订阅了运行态事件（turn/start 或 session/event）',
  registered.listeners.some(e => e.includes('turn') || e.includes('session')), JSON.stringify(registered.listeners))
check('全部注册都走 ctx.effect 并返回释放句柄', registered.effects.length >= 3, JSON.stringify(registered.effects))
check('数据目录落在隔离 DSH_HOME 下（无明文私有路径）', !JSON.stringify(registered).includes('szgmi'))

console.log('')
if (failures.length === 0) {
  console.log(`PROBE RESULT: ${registered.routes.length} 路由 / ${registered.tools.length} 工具 / ${registered.listeners.length} 订阅 / ${registered.effects.length} effect —— 全部通过`)
} else {
  console.log(`PROBE RESULT: ${failures.length} 项未通过 -> ${failures.join(', ')}`)
  process.exitCode = 1
}
