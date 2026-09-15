import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isColorDark, formatFileSize, formatMessageTime, formatRelativeTimeShort } from '../../../src/utils/format'

/** src/utils/format 边界补充：颜色亮度阈值、shorthand hex、时间片边界、负数/未来时间戳 */

const t = (key: string, options?: Record<string, any>) => {
  if (key === 'workbench.justNow') return '刚刚'
  if (key === 'workbench.yesterday') return '昨天'
  if (key === 'workbench.monthDay') return `${options?.month}月${options?.day}日`
  if (key === 'workbench.yearMonthDay') return `${options?.year}年${options?.month}月${options?.day}日`
  return key
}

describe('format / isColorDark 亮度边界', () => {
  it('阈值 0.5 两侧（#7f7f7f 暗 / #808080 亮）', () => {
    expect(isColorDark('#7f7f7f')).toBe(true)
    expect(isColorDark('#808080')).toBe(false)
  })

  it('灰阶序列与加权亮度一致（绿色权重最高）', () => {
    expect(isColorDark('#00ff00')).toBe(false)
    expect(isColorDark('#0000ff')).toBe(true)
    expect(isColorDark('#ff0000')).toBe(true)
  })

  it('8 位 hex 忽略 alpha 位', () => {
    expect(isColorDark('#000000ff')).toBe(true)
    expect(isColorDark('#ffffff00')).toBe(false)
  })

  it('3 位 shorthand hex 展开后参与亮度计算（#000 暗 / #fff 亮）', () => {
    expect(isColorDark('#000')).toBe(true)
    expect(isColorDark('#fff')).toBe(false)
    expect(isColorDark('#0f0')).toBe(false)
    expect(isColorDark('#00f')).toBe(true)
  })

  it('长度不足/非 3 位 shorthand 的输入不抛错', () => {
    expect(() => isColorDark('#')).not.toThrow()
    expect(() => isColorDark('1')).not.toThrow()
    expect(isColorDark('#12')).toBe(false)
  })
})

describe('format / formatFileSize 边界', () => {
  it('负数与超大值仍返回字符串', () => {
    expect(typeof formatFileSize(-1)).toBe('string')
    expect(formatFileSize(-1)).toContain('B')
    expect(formatFileSize(1e12)).toMatch(/TB/)
  })

  it('SI 基数为 1000（1024 字节 ≈ 1.02 kB）', () => {
    expect(formatFileSize(1024)).toMatch(/kB/)
  })
})

describe('format / formatMessageTime 边界', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('59.999 秒显示"刚刚"，整 60 秒进入"今天 HH:mm"', () => {
    expect(formatMessageTime(new Date(2026, 8, 13, 11, 59, 0, 1).getTime(), t)).toBe('刚刚')
    expect(formatMessageTime(new Date(2026, 8, 13, 11, 59, 0, 0).getTime(), t)).toBe('11:59')
  })

  it('今天较早时间按 HH:mm 补零', () => {
    expect(formatMessageTime(new Date(2026, 8, 13, 0, 0, 0).getTime(), t)).toBe('00:00')
  })

  it('未来时间戳不显示"刚刚"，按日期规则展示（跨天/跨年同样）', () => {
    expect(formatMessageTime(new Date(2026, 8, 13, 23, 59, 0).getTime(), t)).toBe('23:59')
    expect(formatMessageTime(new Date(2026, 8, 14, 9, 0, 0).getTime(), t)).toBe('9月14日 09:00')
    expect(formatMessageTime(new Date(2027, 0, 1, 0, 0, 0).getTime(), t)).toBe('2027年1月1日 00:00')
  })

  it('跨年昨天优先按"昨天"展示', () => {
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0))
    expect(formatMessageTime(new Date(2025, 11, 31, 22, 30, 0).getTime(), t)).toBe('昨天 22:30')
  })

  it('时间戳非法（NaN）不抛错', () => {
    expect(() => formatMessageTime(NaN, t)).not.toThrow()
  })
})

describe('format / formatRelativeTimeShort 边界', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const now = () => Math.floor(Date.now() / 1000)

  it('分段边界：60s / 3600s / 86400s', () => {
    expect(formatRelativeTimeShort(now() - 59)).toBe('1分钟')
    expect(formatRelativeTimeShort(now() - 60)).toBe('1分钟')
    expect(formatRelativeTimeShort(now() - 3599)).toBe('59分钟')
    expect(formatRelativeTimeShort(now() - 3600)).toBe('1小时')
    expect(formatRelativeTimeShort(now() - 86399)).toBe('23小时')
    expect(formatRelativeTimeShort(now() - 86400)).toBe('1天')
  })

  it('30 天边界：29 天仍为"天"，满 30 天转日期', () => {
    expect(formatRelativeTimeShort(now() - 86400 * 30 + 1)).toBe('29天')
    const ts = now() - 86400 * 30
    expect(formatRelativeTimeShort(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('语言前缀判定：zh* 中文，其它英文', () => {
    expect(formatRelativeTimeShort(now() - 61, 'zh')).toBe('1分钟')
    expect(formatRelativeTimeShort(now() - 61, 'zh-TW')).toBe('1分钟')
    expect(formatRelativeTimeShort(now() - 61, 'en-GB')).toBe('1 minute')
    expect(formatRelativeTimeShort(now() - 61, 'fr-FR')).toBe('1 minute')
  })

  it('英文复数规则：1 无 s、2 有 s', () => {
    expect(formatRelativeTimeShort(now() - 120, 'en-US')).toBe('2 minutes')
    expect(formatRelativeTimeShort(now() - 7200, 'en-US')).toBe('2 hours')
    expect(formatRelativeTimeShort(now() - 86400 * 2, 'en-US')).toBe('2 days')
  })

  it('非正/非有限时间戳统一返回 "-"', () => {
    expect(formatRelativeTimeShort(-1)).toBe('-')
    expect(formatRelativeTimeShort(0)).toBe('-')
    expect(formatRelativeTimeShort(NaN)).toBe('-')
    expect(formatRelativeTimeShort(Infinity)).toBe('-')
  })

  it('未来时间戳（秒）返回 "-"', () => {
    expect(formatRelativeTimeShort(now() + 60)).toBe('-')
  })
})
