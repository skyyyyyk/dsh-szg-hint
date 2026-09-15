/**
 * 旁路提示队列契约测试：原子消费 / 作用域 / 上限 / 撤销 / 重启后不重复消费。
 *
 * 每个用例一个临时目录（队列文件落在 `${dir}/dsh-szg-hint/hints.jsonl`），互不干扰，
 * 也不会碰到真实的 `$DSH_HOME`。
 *
 * @module dsh-szg-hint/tests/store
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HintStore, type HintStoreOptions } from '../src/store.ts'

const dirs: string[] = []

/**
 * 建一个用临时目录的队列。
 * @param options - 存储参数覆盖。
 * @returns 队列实例与它的临时目录。
 */
function makeStore(options: Partial<HintStoreOptions> = {}): {
  store: HintStore
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-szg-hint-test-'))
  dirs.push(dir)
  return { store: new HintStore(dir, options), dir }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('HintStore', () => {
  it('原子消费：同一条提示不会被第二次取走', () => {
    const { store } = makeStore()
    const pushed = store.push('s1', '先看 A 再看 B', 'web')
    expect(pushed.item?.id).toBe(1)
    expect(pushed.running).toBe(false)

    const first = store.consume('s1', 20)
    expect(first.map(item => item.content)).toEqual(['先看 A 再看 B'])
    expect(first[0]?.status).toBe('consumed')

    expect(store.consume('s1', 20)).toEqual([])
    expect(store.stats()).toEqual({ pending: 0, consumed: 1, total: 1 })
  })

  it('最旧优先 + 单步上限：超出部分留到下一步', () => {
    const { store } = makeStore()
    for (const text of ['一', '二', '三', '四']) store.push('s1', text, 'web')

    const taken = store.consume('s1', 2)
    expect(taken.map(item => item.content)).toEqual(['一', '二'])
    expect(store.pendingFor('s1').map(item => item.content)).toEqual(['三', '四'])
  })

  it('作用域：全局提示任何会话都能取，别的会话的提示取不到', () => {
    const { store } = makeStore()
    store.push('', '全局提醒', 'tool')
    store.push('s2', '只给 s2 的', 'web')

    const taken = store.consume('s1', 20)
    expect(taken.map(item => item.content)).toEqual(['全局提醒'])
    expect(store.pendingFor('s1')).toEqual([])
    expect(store.pendingFor('s2').map(item => item.content)).toEqual(['只给 s2 的'])
  })

  it('拿不到会话 id 时只取全局提示（不把别人的提示喂过去）', () => {
    const { store } = makeStore()
    store.push('s9', '给 s9 的', 'web')
    expect(store.consume('', 20)).toEqual([])
    expect(store.pendingFor('s9')).toHaveLength(1)
  })

  it('撤销：待消费可撤（回执带条目快照）、已消费拒绝、不存在报 missing', () => {
    const { store } = makeStore()
    const taken = store.push('s1', '会被参考的', 'web').item
    const spare = store.push('s1', '要撤销的', 'web').item
    expect(taken).not.toBeNull()
    expect(spare).not.toBeNull()
    if (taken === null || spare === null) return

    store.consume('s1', 1) // 只取走最旧那条
    expect(store.cancel(taken.id).status).toBe('consumed')
    expect(store.cancel(999).status).toBe('missing')
    const cancelled = store.cancel(spare.id)
    expect(cancelled.status).toBe('ok')
    // 回执要能按真实会话归属广播：entry 必须带上会话与正文。
    expect(cancelled.status === 'ok' ? cancelled.entry.sessionId : null).toBe('s1')
    expect(cancelled.status === 'ok' ? cancelled.entry.content : null).toBe('要撤销的')
    expect(store.stats()).toEqual({ pending: 0, consumed: 1, total: 1 })
  })

  it('注入失败可回滚：标记回待消费，下一步还能取到', () => {
    const { store } = makeStore()
    store.push('s1', '回滚这一条', 'web')
    const taken = store.consume('s1', 5)
    expect(store.restore(taken.map(item => item.id))).toBe(1)
    expect(store.pendingFor('s1').map(item => item.content)).toEqual(['回滚这一条'])
    expect(store.consume('s1', 5)).toHaveLength(1)
  })

  it('会话上限：超出时挤掉最旧一条并如实报告', () => {
    const { store } = makeStore({ maxPendingPerSession: 2 })
    store.push('s1', '第一条', 'web')
    store.push('s1', '第二条', 'web')
    const third = store.push('s1', '第三条', 'web')

    expect(third.dropped).toBe('第一条')
    expect(store.pendingFor('s1').map(item => item.content)).toEqual(['第二条', '第三条'])
  })

  it('正文：空白拒绝、超长截断', () => {
    const { store } = makeStore({ maxContentChars: 10 })
    expect(store.push('s1', '   ', 'web').item).toBeNull()
    expect(store.push('s1', 'x'.repeat(50), 'web').item?.content).toHaveLength(10)
  })

  it('运行态：turn 信号驱动，未知会话恒为 false', () => {
    const { store } = makeStore()
    expect(store.setRunning('s1', true)).toBe(true)
    expect(store.setRunning('s1', true)).toBe(false)
    expect(store.isRunning('s1')).toBe(true)
    expect(store.push('s1', '在跑', 'web').running).toBe(true)
    expect(store.setRunning('', true)).toBe(false)
    expect(store.isRunning('s2')).toBe(false)
    store.setRunning('s1', false)
    expect(store.snapshot().runningSessions).toEqual([])
  })

  it('持久化：重建后已消费的不复活、待消费的还在', () => {
    const { store, dir } = makeStore()
    store.push('s1', '已参考的', 'web')
    store.push('s1', '还没参考的', 'web')
    store.consume('s1', 1)

    const reloaded = new HintStore(dir)
    expect(reloaded.pendingFor('s1').map(item => item.content)).toEqual(['还没参考的'])
    expect(reloaded.stats()).toEqual({ pending: 1, consumed: 1, total: 2 })
    // 新 id 不复用旧号（否则前端去重会误判）
    expect(reloaded.push('s1', '第三条', 'web').item?.id).toBe(3)
  })

  it('日志损坏：坏行跳过，好的照常回放', () => {
    const { store, dir } = makeStore()
    store.push('s1', '留下的', 'web')
    const file = join(dir, 'dsh-szg-hint', 'hints.jsonl')
    const good = readFileSync(file, 'utf8').trim()
    writeFileSync(file, `破坏的一行\n${good}\n{"op":"put"}\n`, 'utf8')

    const reloaded = new HintStore(dir)
    expect(reloaded.pendingFor('s1').map(item => item.content)).toEqual(['留下的'])
  })

  it('快照：统计口径与最近已参考（正文截断到 80 字）', () => {
    const { store } = makeStore()
    store.push('s1', 'y'.repeat(120), 'web')
    store.push('s1', '待参考', 'web')
    store.consume('s1', 1)

    const snapshot = store.snapshot()
    expect(snapshot.stats).toEqual({ pending: 1, consumed: 1, total: 2 })
    expect(snapshot.pending.map(item => item.content)).toEqual(['待参考'])
    expect(snapshot.recentConsumed).toHaveLength(1)
    expect(snapshot.recentConsumed[0]?.text).toHaveLength(80)
    expect(snapshot.maxContentChars).toBe(2000)
  })
})
