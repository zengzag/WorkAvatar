import type { ToolDefinition } from '../tool.types'
import { formatDate } from './utils'

export const dateTimeTool: ToolDefinition = {
  id: 'date_time',
  name: 'date_time',
  title: '日期时间',
  description: '获取当前日期时间，或进行日期计算（add_days需传入days参数）',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['now', 'format', 'add_days'],
        description: '操作类型'
      },
      format: { type: 'string', description: '日期格式，如 "YYYY-MM-DD"' },
      days: { type: 'number', description: '要添加的天数' }
    },
    required: ['operation']
  },
  handler: (args: any) => {
    const now = new Date()
    if (args.operation === 'now') {
      return {
        date: now.toISOString().split('T')[0],
        time: now.toTimeString().split(' ')[0],
        datetime: now.toISOString(),
        timestamp: now.getTime()
      }
    }
    if (args.operation === 'format') {
      const fmt = args.format || 'YYYY-MM-DD HH:mm:ss'
      return { formatted: formatDate(now, fmt) }
    }
    if (args.operation === 'add_days' && typeof args.days === 'number') {
      const target = new Date(now.getTime() + args.days * 24 * 60 * 60 * 1000)
      return { result: target.toISOString().split('T')[0] }
    }
    return { error: 'Unknown operation' }
  },
  source: 'builtin'
}