/**
 * 自包含构建链（不继承任何 monorepo 预设）。
 *
 * 两个产物，各自有明确契约：
 *
 * - **宿主半边** `lib/index.js`：ESM / platform=node。`@deepseek-ai/*` 与 `schemastery`
 *   保持 external，由 dsh 宿主进程解析（与官方插件同款做法）。
 * - **浏览器半边** `lib/client.js`：CJS / platform=browser，外面套一层
 *   `window.__ModuleLoader__.load({ id, factory })` 注册器——dsh 客户端模块表按这个契约
 *   认领插件。`react` 与 `@deepseek-ai/dsh-client-*` 是模块表基线，保持 external 由宿主
 *   注入的 `require` 解析。
 *
 * CSS Modules 由本文件内的虚拟模块插件处理：lightningcss 算哈希类名 → 生成一个注入
 * `<style>` 标签并默认导出类名映射的模块。官方 monorepo 用共享预设做同一件事，独立仓库
 * 必须自带。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

/** 仓库根（配置文件所在目录）：产物里的路径一律相对它，避免泄漏构建机绝对路径。 */
const REPO_ROOT = import.meta.dirname

/** 插件 id：写进 `__ModuleLoader__.load` 与样式标签，必须等于包名。 */
const PLUGIN_ID = 'dsh-szg-hint'

/** 运行时由 dsh 宿主进程 / 浏览器模块表提供的包名。 */
const HOST_EXTERNALS: (string | RegExp)[] = [
  /^@deepseek-ai\//,
  /^schemastery(\/|$)/,
  /^node:/,
]

/** 模块表基线里的浏览器侧 specifier。 */
const CLIENT_EXTERNALS: (string | RegExp)[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

/** 虚拟模块前缀（`\0` 让它不可能与磁盘路径撞名）。 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css-module:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * 虚拟模块 key → 样式表绝对路径。
 *
 * ★虚拟 id 里**不能**出现绝对路径：rolldown 会把它回显成产物里的 `//#region`
 * 注释，等于把构建机目录随发布物带出去。这里用哈希当 key，绝对路径只活在
 * 构建进程内；`load` 再按 key 取回真实路径。
 */
const cssFileByKey = new Map<string, string>()

/**
 * 把一个 `.module.css` 变成「注入样式 + 导出类名映射」的模块。
 * @param id - 插件 id（写进 style 标签的 data 属性，便于排查重复注入）。
 * @param tagPath - 样式表路径（**仓库内相对路径**：写进 style 标签；绝不能用绝对路径，
 *   否则构建机目录会随发布产物泄漏出去，产物也不可复现）。
 * @param css - 编译后的 CSS 文本。
 * @param classMap - 本地类名 → 哈希类名。
 * @returns 模块源码。
 */
function styleModule(
  id: string,
  tagPath: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${tagPath}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-dsh-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.dshCss = tagId;`,
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
    '',
  ].join('\n')
}

/** rolldown 插件：`.module.css` → 注入 + 类名映射。 */
const cssModules = {
  name: 'dsh-css-modules',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const absolute = importer === undefined ? source : resolve(dirname(importer.split('?')[0] ?? importer), source)
    const key = createHash('sha256').update(absolute).digest('hex').slice(0, 16)
    cssFileByKey.set(key, absolute)
    return CSS_VIRTUAL_PREFIX + key + CSS_VIRTUAL_SUFFIX
  },
  async load(virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = cssFileByKey.get(virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length))
    if (fileId === undefined) return null
    // rolldown 的插件上下文提供 addWatchFile（CSS 改动要能触发重建），但 tsdown 暴露的
    // 钩子 this 类型里没有它，故按结构取用；缺席时跳过watch（构建仍然正确，只是不增量）。
    ;(this as unknown as { addWatchFile?: (file: string) => void }).addWatchFile?.(fileId)
    const source = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: 'dshhint-[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, entry] of Object.entries(cssExports ?? {})) classMap[local] = entry.name
    return styleModule(PLUGIN_ID, relative(REPO_ROOT, fileId).replace(/\\/g, '/'), code.toString(), classMap)
  },
}

/** 宿主半边：Node ESM 库。 */
const host: UserConfig = {
  name: PLUGIN_ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  // 关掉 tree-shaking：插件靠 `ctx.effect` / `ctx.on` 的注册副作用运行，删掉「看起来没被用到」的
  // 声明会让产物里留下未定义引用（`const name = PLUGIN_ID` 而 PLUGIN_ID 被消除）。
  treeshake: false,
  deps: { neverBundle: HOST_EXTERNALS },
}

/** 浏览器半边：CJS + `__ModuleLoader__` 注册器包装。 */
const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  treeshake: false,
  deps: { neverBundle: CLIENT_EXTERNALS },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
  },
  plugins: [cssModules],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
