import { describe, it, expect } from 'vitest'
import { LRUCache } from '../../../src/utils/lru-cache'

/** src/utils/lru-cache 补充：淘汰顺序细节、has 不提权、异常容量值、迭代顺序 */

describe('lru-cache / 淘汰顺序细节', () => {
  it('set 已存在 key 会提升其为最近使用', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 11) // 重新 set 应视为最近使用
    c.set('c', 3)
    expect(c.has('b')).toBe(false)
    expect([...c.keys()]).toEqual(['a', 'c'])
    expect(c.get('a')).toBe(11) // get 命中后提升，'a' 移到队尾
    expect([...c.keys()]).toEqual(['c', 'a'])
  })

  it('has 不提升最近使用（仅查询不改变顺序）', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.has('a')).toBe(true)
    c.set('c', 3)
    expect(c.has('a')).toBe(false)
    expect([...c.keys()]).toEqual(['b', 'c'])
  })

  it('get 未命中不改变顺序', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.get('zzz')).toBeUndefined()
    c.set('c', 3)
    expect(c.has('a')).toBe(false)
  })

  it('delete 缺失 key 返回 false 且不改变顺序', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.delete('zzz')).toBe(false)
    c.set('c', 3)
    expect(c.has('a')).toBe(false)
    expect(c.delete('b')).toBe(true)
  })

  it('迭代器顺序 = 最近使用顺序（旧 → 新）', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.get('a')
    expect([...c.keys()]).toEqual(['b', 'c', 'a'])
    expect([...c.values()]).toEqual([2, 3, 1])
    expect([...c.entries()]).toEqual([['b', 2], ['c', 3], ['a', 1]])
    expect([...c]).toEqual([...c.entries()])
  })

  it('存 undefined 值后 get 早退，不提升该 key（已知限制）', () => {
    const c = new LRUCache<string, number | undefined>(2)
    c.set('a', undefined)
    c.set('b', 2)
    c.get('a') // value === undefined → 直接返回，不 delete+set
    c.set('c', 3)
    // a 未被提升，仍是最久未使用 → 被淘汰
    expect(c.has('a')).toBe(false)
    expect(c.has('b')).toBe(true)
  })

  it('对象键与值按引用比较', () => {
    const c = new LRUCache<object, string>(2)
    const k1 = { id: 1 }
    const k2 = { id: 1 }
    c.set(k1, 'v1')
    expect(c.get(k2)).toBeUndefined()
    expect(c.get(k1)).toBe('v1')
  })

  it('clear 后可继续使用且容量不残留', () => {
    const c = new LRUCache<string, number>(1)
    c.set('a', 1)
    c.clear()
    c.set('b', 2)
    expect(c.size).toBe(1)
    expect(c.get('b')).toBe(2)
  })

  it('容量为小数时按 size >= max 判定（1.5 → 存满 2 条才淘汰）', () => {
    const c = new LRUCache<string, number>(1.5)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.size).toBe(2)
    c.set('c', 3)
    expect(c.size).toBe(2)
    expect(c.has('a')).toBe(false)
  })

  it('maxSize 为 NaN / Infinity 时抛错（非有限容量会让淘汰判断失效）', () => {
    expect(() => new LRUCache<string, number>(NaN)).toThrow(/maxSize/)
    expect(() => new LRUCache<string, number>(Infinity)).toThrow(/maxSize/)
  })
})
