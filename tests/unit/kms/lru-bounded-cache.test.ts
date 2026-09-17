import { describe, it, expect, vi } from 'vitest'
import { LRUBoundedCache } from '../../../electron/main/services/kms/lru-bounded-cache'

const byteSize = (s: string) => s.length

describe('LRUBoundedCache', () => {
  it('基本 set/get/has/delete', () => {
    const c = new LRUBoundedCache<string>(100, byteSize)
    c.set('a', 'aaaa')
    expect(c.has('a')).toBe(true)
    expect(c.get('a')).toBe('aaaa')
    c.delete('a')
    expect(c.has('a')).toBe(false)
    expect(c.get('a')).toBeUndefined()
    expect(c.getBytes()).toBe(0)
  })

  it('get 提升为最近使用', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aa') // 2
    c.set('b', 'bb') // 2
    c.get('a') // a 变为最近，最旧变为 b
    c.set('c', 'cccccc') // 6 → 总 10
    c.set('d', 'dd') // 2 → 需淘汰最旧 b
    expect(c.has('b')).toBe(false)
    expect(c.has('a')).toBe(true)
    expect(c.has('c')).toBe(true)
  })

  it('超限淘汰最旧条目直至放下新条目', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aaaa') // 4
    c.set('b', 'bbbb') // 4
    c.set('c', 'cc') // 2 → 总 10
    expect(c.getBytes()).toBe(10)
    c.set('d', 'dd') // 2 → 需要 12 > 10，淘汰 a
    expect(c.has('a')).toBe(false)
    expect(c.getBytes()).toBe(8)
  })

  it('单条目超过上限拒绝缓存', () => {
    const c = new LRUBoundedCache<string>(4, byteSize)
    c.set('big', 'toolongvalue')
    expect(c.has('big')).toBe(false)
    expect(c.getBytes()).toBe(0)
  })

  it('set 已存在 key 时重算字节不重复累计', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aaaa') // 4
    c.set('a', 'aa') // 2
    expect(c.getBytes()).toBe(2)
    c.set('a', 'aaaaaaaaaa') // 10
    expect(c.getBytes()).toBe(10)
  })

  it('update 原地修改并重算字节', () => {
    const c = new LRUBoundedCache<{ buf: string }>(100, v => v.buf.length)
    c.set('a', { buf: 'aaaa' })
    c.update('a', v => { v.buf += 'bb' })
    expect(c.get('a')!.buf).toBe('aaaabb')
    expect(c.getBytes()).toBe(6)
  })

  it('update 不存在的 key 是 no-op', () => {
    const c = new LRUBoundedCache<{ buf: string }>(100, v => v.buf.length)
    expect(() => c.update('missing', () => { throw new Error('should not call') })).not.toThrow()
  })

  it('update 超过单条上限时移除该条目', () => {
    const c = new LRUBoundedCache<{ buf: string }>(10, v => v.buf.length)
    c.set('a', { buf: 'aa' })
    c.set('b', { buf: 'bb' })
    c.update('b', v => { v.buf = 'x'.repeat(20) })
    expect(c.has('b')).toBe(false)
    expect(c.getBytes()).toBe(2)
  })

  it('update 触发淘汰最旧条目（增量写入路径同样受 maxBytes 约束）', () => {
    const c = new LRUBoundedCache<{ buf: string }>(10, v => v.buf.length)
    c.set('a', { buf: 'aaaa' })
    c.set('b', { buf: 'bbbb' })
    c.update('b', v => { v.buf += 'bb' }) // b=6, 总 10
    c.update('b', v => { v.buf += 'bb' }) // b=8, 总 12 > 10 → 淘汰 a
    expect(c.has('a')).toBe(false)
    expect(c.has('b')).toBe(true)
    expect(c.getBytes()).toBe(8)
  })

  it('update 把条目提升为最近使用', () => {
    const c = new LRUBoundedCache<{ buf: string }>(8, v => v.buf.length)
    c.set('a', { buf: 'aa' })
    c.set('b', { buf: 'bb' })
    c.update('a', v => { v.buf += 'c' }) // a=3 b=2 总 5；a 提升为最近
    c.set('c', { buf: 'dd' }) // 总 7
    c.set('d', { buf: 'ee' }) // 总 9 > 8 → 淘汰最旧 b
    expect(c.has('b')).toBe(false)
    expect(c.has('a')).toBe(true)
  })

  it('clear 清空全部', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aa')
    c.set('b', 'bb')
    c.clear()
    expect(c.getBytes()).toBe(0)
    expect(c.has('a')).toBe(false)
  })

  it('computeSize 返回 0 的条目可正常缓存', () => {
    const c = new LRUBoundedCache<string>(10, () => 0)
    c.set('a', 'x')
    expect(c.get('a')).toBe('x')
    expect(c.getBytes()).toBe(0)
  })

  it('淘汰循环在清空后仍不超出上限（连续写入压力）', () => {
    const c = new LRUBoundedCache<string>(6, byteSize)
    for (let i = 0; i < 100; i++) {
      c.set(`k${i}`, 'xxx')
      expect(c.getBytes()).toBeLessThanOrEqual(6)
    }
  })
})

describe('LRUBoundedCache 边界补充', () => {
  it('maxBytes = 0 时非空条目被拒绝、零字节条目可缓存', () => {
    const c = new LRUBoundedCache<string>(0, byteSize)
    c.set('a', 'x')
    expect(c.has('a')).toBe(false)

    const zero = new LRUBoundedCache<string>(0, () => 0)
    zero.set('a', 'x')
    expect(zero.get('a')).toBe('x')
    expect(zero.getBytes()).toBe(0)
  })

  it('maxBytes 为负数时所有条目（含零字节）都被拒绝', () => {
    const c = new LRUBoundedCache<string>(-1, () => 0)
    c.set('a', 'x')
    expect(c.has('a')).toBe(false)
    expect(c.getBytes()).toBe(0)
  })

  it('get 未命中 key 不改变字节统计与顺序', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aaa')
    expect(c.get('missing')).toBeUndefined()
    expect(c.getBytes()).toBe(3)
    c.set('b', 'bbbbbb') // 3 + 6 = 9
    c.set('c', 'cc') // 11 > 10 → 淘汰 a
    expect(c.has('a')).toBe(false)
  })

  it('重复 set 超过上限的新值会移除原条目', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aa')
    c.set('b', 'bb')
    c.set('a', 'x'.repeat(11))
    expect(c.has('a')).toBe(false)
    expect(c.getBytes()).toBe(2)
  })

  it('delete 不存在的 key 是 no-op', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    c.set('a', 'aa')
    c.delete('missing')
    expect(c.getBytes()).toBe(2)
  })

  it('空缓存 clear 不抛错', () => {
    const c = new LRUBoundedCache<string>(10, byteSize)
    expect(() => c.clear()).not.toThrow()
    expect(c.getBytes()).toBe(0)
  })

  it('update 对 falsy 值（0/空串/false）同样生效（存在性用 has() 判定）', () => {
    // 修复前用 !value 判定存在性，falsy 值会被当成「不存在」而静默跳过更新
    const zero = new LRUBoundedCache<number>(10, () => 1)
    zero.set('a', 0)
    const mZero = vi.fn()
    zero.update('a', mZero)
    expect(mZero).toHaveBeenCalledWith(0)

    const empty = new LRUBoundedCache<string>(10, () => 1)
    empty.set('a', '')
    const mEmpty = vi.fn()
    empty.update('a', mEmpty)
    expect(mEmpty).toHaveBeenCalledWith('')

    const falsy = new LRUBoundedCache<boolean>(10, () => 1)
    falsy.set('a', false)
    const mBool = vi.fn()
    falsy.update('a', mBool)
    expect(mBool).toHaveBeenCalledWith(false)
  })

  it('update 传入的 mutator 抛错时缓存状态可能不一致（当前行为）', () => {
    const c = new LRUBoundedCache<{ buf: string }>(100, v => v.buf.length)
    c.set('a', { buf: 'aa' })
    expect(() => c.update('a', () => { throw new Error('boom') })).toThrow('boom')
    expect(c.getBytes()).toBe(2) // mutator 抛错时字节数未被修改
  })

  it('utf8 字节计算下超长 value 仍受上限约束', () => {
    const utf8 = (s: string) => Buffer.byteLength(s, 'utf8')
    const c = new LRUBoundedCache<string>(100, utf8)
    c.set('a', '中'.repeat(30)) // 90 字节
    expect(c.getBytes()).toBe(90)
    c.set('b', '中'.repeat(4)) // 12 → 102 > 100 → 淘汰 a
    expect(c.has('a')).toBe(false)
    expect(c.getBytes()).toBe(12)
  })
})
