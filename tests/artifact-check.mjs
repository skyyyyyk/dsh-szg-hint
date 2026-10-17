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
 * 另外核对发布面：package.json 声明的入口文件是否都存在，以及双语 README 是否成对。
 *
 * 用法：node tests/artifact-check.mjs [插件包根目录，默认本仓库]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
// 取图路由（`/dsh-szg-hint/image/<id>/<n>`）同样必须由前缀派生：写成字面量就会在改前缀时
// 与状态/事件路径分叉，而这条分叉只会在浏览器取缩略图时以 404 暴露。这里不把反引号内容
// 写死成普通字符串——按「抽出来看它引用的是谁」判定，前缀换了也不用改这条断言。
const imagePathPrefix = first(host, 'const IMAGE_PATH_PREFIX = [^;]+')
check('宿主取图路由由前缀派生',
  imagePathPrefix !== undefined && imagePathPrefix.includes('/image/') && imagePathPrefix.includes('ROUTE_PREFIX'),
  imagePathPrefix)
check('宿主两个工具在场', host.includes('"hint_send"') && host.includes('"hint_status"'))
// 图片链路的三个配置键要在产物里真的存在：漏一个，用户改了配置也会静默走默认值
// （schemastery 不认识的键不会报错，只在行为上表现为「设了没用」）。
const imageConfigKeys = ['maxImagesPerHint', 'maxImageBytes', 'maxTotalImageBytes']
const missingImageKeys = imageConfigKeys.filter(key => !host.includes(key))
check('宿主图片限额配置键在场', missingImageKeys.length === 0,
  missingImageKeys.length > 0 ? { missing: missingImageKeys } : imageConfigKeys.join(' / '))
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
// 取图路径与宿主同前缀。单看 `includes('/dsh-szg-hint/image/')` 会被上面那段文档注释蒙过去
// （注释里也写了一次同样的字符串），所以钉**代码里的模板字面量形态**：`/dsh-szg-hint/image/${...}`。
const clientImageUrlHead = '`/dsh-szg-hint/image/${'
check('客户端取图路径与宿主同前缀',
  client.includes(clientImageUrlHead) && client.includes('/dsh-szg-hint/image/'),
  first(client, '`/dsh-szg-hint/image/[^`]*`'))
const rawPaths = uniq([...client.matchAll(/['"](\/[A-Za-z0-9_\-/]*)['"]/g)].map(m => m[1])).filter(p => p.includes('hint'))
check('客户端不含硬编码的路径字面量（避免与宿主漂移）',
  rawPaths.every(p => p === '/dsh-szg-hint'), rawPaths)

// ── 发布入口自检 ──
// package.json 声明的每个入口（main、types、exports 的各分支）都必须在磁盘上真实存在。
// 「声明了 types 却从没产出」在开发与单测里都不报错，只在别人装包后表现为类型缺失，
// 所以把它固化成发布前必过的一条。
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const declaredEntries = uniq([
  manifest.main,
  manifest.types,
  ...Object.values(manifest.exports ?? {}).flatMap(branch =>
    typeof branch === 'string' ? [branch] : Object.values(branch)),
].filter(entry => typeof entry === 'string' && entry.startsWith('.')))
const missingEntries = declaredEntries.filter(entry => !existsSync(join(repo, entry)))
check('package.json 声明的入口文件全部存在', missingEntries.length === 0,
  missingEntries.length > 0 ? { missing: missingEntries } : `${String(declaredEntries.length)} 个入口`)

// 组合层（cordis.patch.yml）是 `dsh plugin add` 真正读取的挂载声明：id/name 写错时
// package.json 与产物全都正确，但插件根本不会被装载，而且不会有人报错。
const patchRef = manifest.dsh?.bundle?.patch
check('dsh.bundle.patch 指向存在的文件',
  typeof patchRef === 'string' && existsSync(join(repo, patchRef)), patchRef)
if (typeof patchRef === 'string' && existsSync(join(repo, patchRef))) {
  const patchLines = readFileSync(join(repo, patchRef), 'utf8').split('\n').map(line => line.trim())
  check('cordis.patch.yml 的 id/name 与包名一致',
    patchLines.includes(`- id: ${manifest.name}`) && patchLines.includes(`name: ${manifest.name}`),
    {
      id: patchLines.find(line => line.startsWith('- id:')),
      name: patchLines.find(line => /^name:/.test(line)),
    })
}

// ── 双语 README（对齐 dsh 的双语对等规范：两侧同等权威，默认中文）──
// 三项合起来才构成「双语」这一约束：两侧都在、顶部互链、且内容与 README.i18n.yaml 的记录一致。
// 第三项是「只改了一侧就提交」的检出口——那正是双语要求最容易失守的地方。
// 默认位与镜像位对调只需改下面这个常量：互链断言是双向推导的，不写死语言方向。
const bilingualPair = ['README.md', 'README.en.md']
const pairing = bilingualPair.filter(name => !existsSync(join(repo, name)))
check('双语 README 两侧都存在', pairing.length === 0, pairing)

if (pairing.length === 0) {
  const unlinked = bilingualPair.filter(name => {
    const other = bilingualPair.find(candidate => candidate !== name)
    return !readFileSync(join(repo, name), 'utf8').includes(`](${other})`)
  })
  check('双语 README 顶部互链', unlinked.length === 0, unlinked)

  const recorded = Object.fromEntries(
    [...readFileSync(join(repo, 'README.i18n.yaml'), 'utf8').matchAll(/^(README(?:\.[a-zA-Z-]+)?\.md): ([0-9a-f]{40})$/gm)]
      .map(match => [match[1], match[2]]))
  const blobHash = text => {
    const bytes = Buffer.from(text, 'utf8')
    return createHash('sha1').update(`blob ${String(bytes.length)}\0`, 'utf8').update(bytes).digest('hex')
  }
  const drifted = bilingualPair
    .filter(name => recorded[name] !== blobHash(readFileSync(join(repo, name), 'utf8')))
  check('双语 README 与 i18n 记录一致', drifted.length === 0,
    drifted.length > 0 ? { drifted, fix: 'node tests/i18n-record.mjs --write' } : '两侧哈希均匹配')
}

const failed = results.filter(r => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.detail === undefined ? '' : `  — got: ${r.detail}`}`)
console.log('')
console.log(failed.length === 0
  ? `ARTIFACT RESULT: 全部通过（${String(results.length)} 项）—— ${repo}`
  : `ARTIFACT RESULT: ${String(failed.length)}/${String(results.length)} 项未通过 -> ${failed.map(f => f.label).join(' | ')}`)
process.exitCode = failed.length === 0 ? 0 : 1
