import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatFileSize,
  isColorDark,
  formatMessageTime,
  shouldShowTimeSeparator,
  formatRelativeTimeShort,
} from '../../../src/utils/format'

describe('src/utils/format / formatFileSize', () => {
  it('0 字节', () => {
    expect(formatFileSize(0)).toContain('0')
  })

  it('KB/MB 换算（filesize 库默认 1000 基 SI 单位）', () => {
    expect(formatFileSize(1000)).toMatch(/1(\.\d+)?\s?kB/)
    expect(formatFileSize(1000 * 1000)).toMatch(/1(\.\d+)?\s?MB/)
  })
})

describe('src/utils/format / isColorDark', () => {
  it('黑色为暗、白色为亮', () => {
    expect(isColorDark('#000000')).toBe(true)
    expect(isColorDark('#ffffff')).toBe(false)
  })

  it('不带 # 前缀也可判断', () => {
    expect(isColorDark('000000')).toBe(true)
  })

  it('无效输入返回 false（NaN 比较）', () => {
    expect(isColorDark('#zzzzzz')).toBe(false)
    expect(isColorDark('')).toBe(false)
  })
})

describe('src/utils/format / formatMessageTime', () => {
  const t = (key: string, options?: Record<string, any>) => {
    if (key === 'workbench.justNow') return '刚刚'
    if (key === 'workbench.yesterday') return '昨天'
    if (key === 'workbench.monthDay') return `${options?.month}月${options?.day}日`
    if (key === 'workbench.yearMonthDay') return `${options?.year}年${options?.month}月${options?.day}日`
    return key
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('1 分钟内显示"刚刚"', () => {
    const ts = new Date(2026, 8, 13, 11, 59, 30).getTime()
    expect(formatMessageTime(ts, t)).toBe('刚刚')
  })

  it('今天显示 HH:mm', () => {
    const ts = new Date(2026, 8, 13, 9, 5, 0).getTime()
    expect(formatMessageTime(ts, t)).toBe('09:05')
  })

  it('昨天显示"昨天 HH:mm"', () => {
    const ts = new Date(2026, 8, 12, 9, 5, 0).getTime()
    expect(formatMessageTime(ts, t)).toBe('昨天 09:05')
  })

  it('今年更早显示 M月D日 HH:mm', () => {
    const ts = new Date(2026, 0, 5, 8, 0, 0).getTime()
    expect(formatMessageTime(ts, t)).toBe('1月5日 08:00')
  })

  it('往年显示完整年月日', () => {
    const ts = new Date(2024, 11, 31, 23, 59, 0).getTime()
    expect(formatMessageTime(ts, t)).toBe('2024年12月31日 23:59')
  })

  it('未来时间不显示"刚刚"（按日期规则退化为今天的 HH:mm）', () => {
    const ts = new Date(2026, 8, 13, 12, 0, 30).getTime()
    expect(formatMessageTime(ts, t)).toBe('12:00')
  })
})

describe('src/utils/format / shouldShowTimeSeparator', () => {
  it('间隔超过 5 分钟显示分隔', () => {
    expect(shouldShowTimeSeparator(1000000, 1000000 + 5 * 60 * 1000 + 1)).toBe(true)
  })

  it('间隔恰为 5 分钟不显示（边界不含）', () => {
    expect(shouldShowTimeSeparator(1000000, 1000000 + 5 * 60 * 1000)).toBe(false)
  })

  it('时间倒序（负间隔）不显示', () => {
    expect(shouldShowTimeSeparator(2000000, 1000000)).toBe(false)
  })
})

describe('src/utils/format / formatRelativeTimeShort', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 13, 12, 0, 0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('无效时间戳返回 -', () => {
    expect(formatRelativeTimeShort(0)).toBe('-')
    expect(formatRelativeTimeShort(NaN)).toBe('-')
  })

  it('未来时间返回 -', () => {
    expect(formatRelativeTimeShort(Math.floor(Date.now() / 1000) + 100)).toBe('-')
  })

  it('1 分钟内显示 1分钟', () => {
    expect(formatRelativeTimeShort(Math.floor(Date.now() / 1000) - 30, 'zh-CN')).toBe('1分钟')
  })

  it('分钟/小时/天（中文与英文复数）', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatRelativeTimeShort(now - 5 * 60, 'zh-CN')).toBe('5分钟')
    expect(formatRelativeTimeShort(now - 5 * 60, 'en-US')).toBe('5 minutes')
    expect(formatRelativeTimeShort(now - 2 * 3600, 'zh-CN')).toBe('2小时')
    expect(formatRelativeTimeShort(now - 2 * 3600, 'en-US')).toBe('2 hours')
    expect(formatRelativeTimeShort(now - 3 * 86400, 'zh-CN')).toBe('3天')
    expect(formatRelativeTimeShort(now - 3 * 86400, 'en-US')).toBe('3 days')
  })

  it('英文单数无 s', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(formatRelativeTimeShort(now - 60, 'en-US')).toBe('1 minute')
  })

  it('超过 30 天显示日期', () => {
    const ts = Math.floor(new Date(2026, 0, 5, 12, 0, 0).getTime() / 1000)
    expect(formatRelativeTimeShort(ts, 'zh-CN')).toBe('2026-01-05')
  })
})
