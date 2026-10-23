import type { ToolDefinition } from './types'
import { formatDate } from './utils'

export const dateTimeTool: ToolDefinition = {
  id: 'date_time',
  name: 'date_time',
  title: '日期时间',
  summary: 'Get the current date and time, or perform date arithmetic.',
  description: 'Get the current date and time, or add a number of days to the current date.',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['now', 'format', 'add_days'],
        description: 'Operation to perform (default "now")'
      },
      format: { type: 'string', description: 'Output format, e.g. "YYYY-MM-DD"' },
      days: { type: 'number', description: 'Number of days to add (add_days only)' }
    },
  },
  handler: (args: any) => {
    const now = new Date()
    const operation = args.operation || 'now'
    // 日期/时间统一取本地时区（toISOString 是 UTC，UTC+8 在 0:00-8:00 会给出昨天的日期）
    const localDate = formatDate(now, 'YYYY-MM-DD')
    const localTime = formatDate(now, 'HH:mm:ss')
    if (operation === 'now') {
      return {
        success: true,
        output: `当前日期: ${localDate}, 时间: ${localTime}, 完整时间: ${now.toISOString()}, 时间戳: ${now.getTime()}`,
        raw: {
          date: localDate,
          time: localTime,
          datetime: now.toISOString(),
          timestamp: now.getTime()
        }
      }
    }
    if (operation === 'format') {
      const fmt = args.format || 'YYYY-MM-DD HH:mm:ss'
      return { success: true, output: formatDate(now, fmt) }
    }
    if (operation === 'add_days') {
      // 单独校验参数：缺 days 时不能落到「未知操作」分支，否则提示误导 LLM
      if (typeof args.days !== 'number') {
        return { success: false, error: 'add_days 需要 days 参数（数字）' }
      }
      const target = new Date(now.getTime() + args.days * 24 * 60 * 60 * 1000)
      return { success: true, output: formatDate(target, 'YYYY-MM-DD') }
    }
    return { success: false, error: `Unknown operation: ${operation}` }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}