/**
 * 插件产物质检（本机工具，不属于发布物）。
 *
 * 为什么单独写成 .mjs：产物里含反引号与模板字面量，经 PowerShell 内联脚本会因引号转义而崩，
 * 从 Node 里读文件并输出 JSON 才是可靠的观测通道（控制台解码还会把 UTF-8 注释显示成乱码，
 * 制造「产物语法坏了」的假象）。
 *
 * 检查两半产物对宿主契约的遵守情况：
 *  - lib/index.js（宿主）：语法、导出契约、路由前缀、数据目录、工具在场、依赖外部化。
 *  - lib/client.js（浏览器）：语法、`__ModuleLoader__.load` 包装、React 走模块表、CSS 内联、路径同源。
 *
 * 用法：node tests/artifact-check.mjs [插件包根目录，默认本仓库]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')
const host = readFileSync(join(repo, 'lib', 'index.js'), 'utf8')
const client = readFileSync(join(repo, 'lib', 'client.js'), 'utf8')

const results = []
/** @param {string} label @param {boolean} ok @param {unknown} detail */
const check = (label, ok, detail = undefined) => {
  results.push({ label, ok, detail: ok || detail === undefined ? undefined : JSON.stringify(detail) })
}
/** 从产物里抽出某个正则的首个匹配（用于打印真实值）。 */
const first = (text, pattern) => new RegExp(pattern).exec(text)?.[0]
const uniq = list => [...new Set(list)]

for (const [name, text] of [['host', host], ['client', client]]) {
  let ok = true
  let message
  try {
    execFileSync(process.execPath, ['--check', join(repo, 'lib', name === 'host' ? 'index.js' : 'client.js')], { stdio: 'pipe' })
  } catch (error) {
    ok = false
    message = String(error.stderr ?? error.message).split('\n').slice(0, 2).join(' ')
  }
  check(`${name} 产物语法正确`, ok, message)
}

// ── 宿主半边 ──
check('宿主导出 name（loader 诊断用）',
  host.includes('const name = PLUGIN_ID') && /export \{[^}]*\bname\b[^}]*\}/.test(host),
  first(host, 'const name = [^;]+'))
check('宿主导出 apply 与 inject',
  /export \{[^}]*\bapply\b[^}]*\}/.test(host) && /export \{[^}]*\binject\b[^}]*\}/.test(host),
  first(host, 'export \\{[^}]*\\}'))
check('宿主路由前缀带前导斜杠',
  host.includes('const ROUTE_PREFIX = `/${PLUGIN_ID}`') || host.includes('const ROUTE_PREFIX = "/dsh-szg-hint"'),
  first(host, 'const ROUTE_PREFIX = [^;]+'))
check('宿主事件/状态路径由前缀派生',
  host.includes('const EVENTS_PATH = `${ROUTE_PREFIX}/events`') && host.includes('const STATE_PATH = `${ROUTE_PREFIX}/state`'),
  [first(host, 'const EVENTS_PATH = [^;]+'), first(host, 'const STATE_PATH = [^;]+')])
check('宿主两个工具在场', host.includes('"hint_send"') && host.includes('"hint_status"'))
check('宿主依赖外部化（官方包未内联）',
  host.includes('@deepseek-ai/dsh-tools') && host.includes('@deepseek-ai/dsh-llm') && host.includes('@deepseek-ai/schemastery'))
const dataDir = first(host, '[^"`]+hints\\.jsonl')
check('宿主数据目录落在包名目录下', dataDir !== undefined && dataDir.includes('dsh-szg-hint/hints.jsonl'), dataDir)
check('宿主不残留私有路径', !host.includes('szgmi') && !host.includes('packages/szg/hint'))

// ── 浏览器半边 ──
check('客户端注册契约 __ModuleLoader__.load 且 id 一致',
  client.includes('__ModuleLoader__.load') && client.includes('"dsh-szg-hint"'))
check('客户端 React 走模块表（外部 require）', client.includes('require("react")'), first(client, 'require\\([^)]*\\)'))
check('客户端未内联 react-dom', !client.includes('react-dom'))
check('客户端 CSS 已内联（style 注入 + 哈希类名）',
  client.includes('data-dsh-css') && /dshhint-[A-Za-z0-9]+_/.test(client))

// 路径同源：浏览器半边把前缀放在 QUEUE_URL，事件/状态路径由它派生；派生表达式必须真的在场，
// 否则「改了前缀、忘了改路径」这类漂移只会在浏览器里以 404 暴露。
const queueUrl = first(client, 'const QUEUE_URL = "[^"]+"')
check('客户端前缀常量存在', queueUrl !== undefined && queueUrl.includes('/dsh-szg-hint'), queueUrl)
check('客户端事件/状态路径由前缀派生',
  /`\$\{QUEUE_URL\}\/events`/.test(client) && /`\$\{QUEUE_URL\}\/state`/.test(client))
const rawPaths = uniq([...client.matchAll(/['"](\/[A-Za-z0-9_\-/]*)['"]/g)].map(m => m[1])).filter(p => p.includes('hint'))
check('客户端不含硬编码的路径字面量（避免与宿主漂移）',
  rawPaths.every(p => p === '/dsh-szg-hint'), rawPaths)

const failed = results.filter(r => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail === undefined ? '' : `  — got: ${r.detail}`}`)
console.log('')
console.log(failed.length === 0
  ? `ARTIFACT RESULT: 全部通过（${String(results.length)} 项）—— ${repo}`
  : `ARTIFACT RESULT: ${String(failed.length)}/${String(results.length)} 项未通过 -> ${failed.map(f => f.label).join(' | ')}`)
process.exitCode = failed.length === 0 ? 0 : 1
