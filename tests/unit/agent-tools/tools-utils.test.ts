import { describe, it, expect } from 'vitest'
import { formatFileSize, parseNaturalTime } from '../../../electron/main/services/agent/tools/utils'

describe('agent/tools/utils / formatFileSize', () => {
  it('0 返回 0 B', () => {
    expect(formatFileSize(0)).toBe('0 B')
  })

  it('各级换算', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 ** 2)).toBe('1 MB')
  })
})

describe('agent/tools/utils / parseNaturalTime', () => {
  it('null/undefined/空串返回 null', () => {
    expect(parseNaturalTime(null)).toBeNull()
    expect(parseNaturalTime(undefined)).toBeNull()
    expect(parseNaturalTime('')).toBeNull()
    expect(parseNaturalTime('   ')).toBeNull()
  })

  it('数值输入按 unix 秒处理', () => {
    expect(parseNaturalTime(1750000000)).toBe(1750000000)
    expect(parseNaturalTime(1750000000.9)).toBe(1750000000)
  })

  it('NaN 数值输入最终返回 null（Date 解析失败兜底）', () => {
    expect(parseNaturalTime(NaN)).toBeNull()
  })

  it('10 位数字串按 unix 秒', () => {
    expect(parseNaturalTime('1750000000')).toBe(1750000000)
  })

  it('13 位数字串按毫秒转秒', () => {
    expect(parseNaturalTime('1750000000000')).toBe(1750000000)
  })

  it('date-only 按本地时区 00:00 解析', () => {
    const expected = Math.floor(new Date(2026, 6, 24).getTime() / 1000)
    expect(parseNaturalTime('2026-07-24')).toBe(expected)
    expect(parseNaturalTime('2026/7/24')).toBe(expected)
    expect(parseNaturalTime('2026.7.24')).toBe(expected)
  })

  it('日期时间（空格/T 分隔、中文冒号、缺秒）', () => {
    const expected = Math.floor(new Date(2026, 6, 24, 15, 30, 0).getTime() / 1000)
    expect(parseNaturalTime('2026-07-24 15:30')).toBe(expected)
    expect(parseNaturalTime('2026-07-24T15:30:00')).toBe(expected)
    expect(parseNaturalTime('2026/07/24 15：30：05')).toBe(
      Math.floor(new Date(2026, 6, 24, 15, 30, 5).getTime() / 1000)
    )
  })

  it('无法解析返回 null', () => {
    expect(parseNaturalTime('明天下午')).toBeNull()
    expect(parseNaturalTime('not a date')).toBeNull()
  })
})
