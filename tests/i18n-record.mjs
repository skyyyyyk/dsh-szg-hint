/**
 * 双语 README 一致性记录器（本机工具，不属于发布物）。
 *
 * 规范对齐 dsh 的 docs/i18n：**两个语言地位相同、同等权威**，改动任一侧都必须带上另一侧，
 * 然后重新记录两侧的 git blob 哈希。记录本身不强制对等，但它把「改了中文忘了英文」从
 * 一种需要人记住的约定，变成 artifact-check 里会红灯的事实。
 *
 * 用法：
 *   node tests/i18n-record.mjs            # 只核对：当前哈希 vs 记录（不一致退出码 1）
 *   node tests/i18n-record.mjs --write    # 重新记录当前两侧的哈希
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = process.argv[2] !== undefined && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : join(dirname(fileURLToPath(import.meta.url)), '..')
const write = process.argv.includes('--write')
const pairs = ['README.md', 'README.zh.md']
const recordPath = join(repo, 'README.i18n.yaml')

/** git 对 blob 的寻址口径：`blob <字节数>\0<内容>` 的 sha1 —— 与 `git hash-object` 一致。 */
const gitBlobHash = text => {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${String(bytes.length)}\0`, 'utf8').update(bytes).digest('hex')
}

/** 从既有记录里取 `README.md: <40 位 hex>` 形式的哈希。 */
const readRecorded = () => {
  if (!existsSync(recordPath)) return {}
  const text = readFileSync(recordPath, 'utf8')
  return Object.fromEntries([...text.matchAll(/^(README(?:\.zh)?\.md): ([0-9a-f]{40})$/gm)]
    .map(match => [match[1], match[2]]))
}

const missing = pairs.filter(name => !existsSync(join(repo, name)))
if (missing.length > 0) {
  console.error(`缺少文件：${missing.join(', ')}`)
  process.exitCode = 1
} else {
  const current = Object.fromEntries(pairs.map(name => [name, gitBlobHash(readFileSync(join(repo, name), 'utf8'))]))

  if (write) {
    const body = [
      '# 双语对等记录（规范见 dsh 的 docs/i18n）：两侧同等权威，改任一侧都要带上另一侧，',
      '# 然后重新记录。下面是「上次确认一致」时各侧的 git blob 哈希。',
      '#   node tests/i18n-record.mjs --write',
      ...pairs.map(name => `${name}: ${current[name]}`),
      '',
    ].join('\n')
    writeFileSync(recordPath, body, 'utf8')
    for (const name of pairs) console.log(`写入 ${name}: ${current[name]}`)
    console.log(`已更新 ${recordPath}`)
  } else {
    const recorded = readRecorded()
    const drifted = pairs.filter(name => recorded[name] !== current[name])
    for (const name of pairs) {
      const mark = recorded[name] === current[name] ? 'OK  ' : 'DRIFT'
      console.log(`${mark} ${name}\n      现在: ${current[name]}\n      记录: ${recorded[name] ?? '（无记录）'}`)
    }
    if (drifted.length > 0) {
      console.error(`\n${drifted.join(', ')} 与记录不一致 —— 若已同步另一侧，请运行：node tests/i18n-record.mjs --write`)
      process.exitCode = 1
    } else {
      console.log('\n双语 README 与记录一致。')
    }
  }
}
