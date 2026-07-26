import type { ToolDefinition } from './types'
import { formatDate } from './utils'

export const dateTimeTool: ToolDefinition = {
  id: 'date_time',
  name: 'date_time',
  title: '日期时间',
  summary: '获取当前日期时间或进行日期计算。需要时间信息时使用。',
  description: '获取当前日期时间，或进行日期计算（add_days需传入days参数）',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['now', 'format', 'add_days'],
        description: '操作类型（可选，不传默认 "now"）'
      },
      format: { type: 'string', description: '日期格式，如 "YYYY-MM-DD"' },
      days: { type: 'number', description: '要添加的天数' }
    },
  },
  handler: (args: any) => {
    const now = new Date()
    const operation = args.operation || 'now'
    if (operation === 'now') {
      return {
        success: true,
        output: `当前日期: ${now.toISOString().split('T')[0]}, 时间: ${now.toTimeString().split(' ')[0]}, 完整时间: ${now.toISOString()}, 时间戳: ${now.getTime()}`,
        raw: {
          date: now.toISOString().split('T')[0],
          time: now.toTimeString().split(' ')[0],
          datetime: now.toISOString(),
          timestamp: now.getTime()
        }
      }
    }
    if (operation === 'format') {
      const fmt = args.format || 'YYYY-MM-DD HH:mm:ss'
      return { success: true, output: formatDate(now, fmt) }
    }
    if (operation === 'add_days' && typeof args.days === 'number') {
      const target = new Date(now.getTime() + args.days * 24 * 60 * 60 * 1000)
      return { success: true, output: target.toISOString().split('T')[0] }
    }
    return { success: false, error: `Unknown operation: ${operation}` }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}