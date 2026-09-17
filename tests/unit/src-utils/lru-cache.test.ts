import { describe, it, expect } from 'vitest'
import { LRUCache } from '../../../src/utils/lru-cache'

describe('src/utils/lru-cache / LRUCache', () => {
  it('maxSize <= 0 抛错', () => {
    expect(() => new LRUCache(0)).toThrow('LRUCache maxSize must be greater than 0')
    expect(() => new LRUCache(-1)).toThrow()
  })

  it('基本 set/get/has/delete/size', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    expect(c.has('a')).toBe(true)
    expect(c.get('a')).toBe(1)
    expect(c.size).toBe(1)
    c.delete('a')
    expect(c.has('a')).toBe(false)
    expect(c.size).toBe(0)
  })

  it('超容量淘汰最久未使用', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.has('a')).toBe(false)
    expect(c.has('b')).toBe(true)
    expect(c.has('c')).toBe(true)
  })

  it('get 提升最近使用，改变淘汰顺序', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a')
    c.set('c', 3)
    expect(c.has('b')).toBe(false)
    expect(c.has('a')).toBe(true)
  })

  it('set 已存在 key 不触发淘汰且容量不增', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 10)
    expect(c.size).toBe(2)
    expect(c.get('a')).toBe(10)
  })

  it('存储 undefined 值时 get 与缺失无法区分（已知限制）', () => {
    const c = new LRUCache<string, number | undefined>(2)
    c.set('a', undefined)
    expect(c.has('a')).toBe(true)
    expect(c.get('a')).toBeUndefined()
  })

  it('clear 清空', () => {
    const c = new LRUCache<string, number>(2)
    c.set('a', 1)
    c.clear()
    expect(c.size).toBe(0)
  })

  it('可迭代 / entries / keys / values', () => {
    const c = new LRUCache<string, number>(3)
    c.set('a', 1)
    c.set('b', 2)
    expect([...c]).toEqual([['a', 1], ['b', 2]])
    expect([...c.keys()]).toEqual(['a', 'b'])
    expect([...c.values()]).toEqual([1, 2])
    expect([...c.entries()]).toEqual([['a', 1], ['b', 2]])
  })

  it('容量为 1 的边界', () => {
    const c = new LRUCache<string, number>(1)
    c.set('a', 1)
    c.set('b', 2)
    expect(c.size).toBe(1)
    expect(c.get('b')).toBe(2)
  })
})
