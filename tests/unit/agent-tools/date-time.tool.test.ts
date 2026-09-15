import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dateTimeTool } from '../../../electron/main/services/agent/tools/date-time.tool'

/**
 * date_time 工具（按需工具）：now / format / add_days 三态与非法操作。
 * 用固定系统时间保证断言确定性（formatDate 取本地时区）。
 */
const FIXED = new Date(2026, 6, 24, 15, 30, 45)

describe('agent/tools/date-time.tool', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const run = (args: any) => dateTimeTool.handler!(args, undefined)

  it('工具元信息：按需工具、安全权限、无必填参数', () => {
    expect(dateTimeTool.id).toBe('date_time')
    expect(dateTimeTool.onDemand).toBe(true)
    expect(dateTimeTool.permission).toBe('safe')
    expect(dateTimeTool.parameters.required).toBeUndefined()
  })

  it('默认操作 now：输出本地日期/时间/时间戳', () => {
    const res = run({})
    expect(res.success).toBe(true)
    expect(res.output).toContain('当前日期: 2026-07-24')
    expect(res.output).toContain('时间: 15:30:45')
    expect(res.output).toContain(`时间戳: ${FIXED.getTime()}`)
    expect(res.raw).toEqual({
      date: '2026-07-24',
      time: '15:30:45',
      datetime: FIXED.toISOString(),
      timestamp: FIXED.getTime(),
    })
  })

  it('显式 operation=now 与不传等价', () => {
    expect(run({ operation: 'now' }).output).toBe(run({}).output)
  })

  it('format：按传入格式输出，缺省为完整日期时间', () => {
    expect(run({ operation: 'format', format: 'YYYY/MM/DD' }).output).toBe('2026/07/24')
    expect(run({ operation: 'format' }).output).toBe('2026-07-24 15:30:45')
  })

  it('add_days：支持正负天数', () => {
    expect(run({ operation: 'add_days', days: 1 }).output).toBe('2026-07-25')
    expect(run({ operation: 'add_days', days: -24 }).output).toBe('2026-06-30')
    expect(run({ operation: 'add_days', days: 0 }).output).toBe('2026-07-24')
  })

  it('add_days 缺少 days（或类型非 number）时给出明确的参数错误（不再误报 Unknown operation）', () => {
    const missing = run({ operation: 'add_days' })
    expect(missing.success).toBe(false)
    expect(missing.error).toBe('add_days 需要 days 参数（数字）')

    const wrongType = run({ operation: 'add_days', days: '3' })
    expect(wrongType.success).toBe(false)
    expect(wrongType.error).toBe('add_days 需要 days 参数（数字）')
  })

  it('未知 operation 报错并回显操作名', () => {
    const res = run({ operation: 'tomorrow' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('Unknown operation: tomorrow')
  })

  it('operation 为空串时回退到 now（falsy 兜底）', () => {
    expect(run({ operation: '' }).success).toBe(true)
    expect(run({ operation: '' }).output).toContain('当前日期')
  })

  it('format 长度为 0 的空串回退默认格式（falsy 兜底）', () => {
    expect(run({ operation: 'format', format: '' }).output).toBe('2026-07-24 15:30:45')
  })

  it('format 中的中文/未识别占位符原样保留', () => {
    expect(run({ operation: 'format', format: '今天是 YYYY年MM月DD日' }).output).toBe('今天是 2026年07月24日')
  })
})
