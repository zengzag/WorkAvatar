import type { ToolDefinition } from './types'
import { generateUUID } from './utils'

export const randomUtilsTool: ToolDefinition = {
  id: 'random_utils',
  name: 'random_utils',
  title: '随机工具',
  description: '生成随机数、UUID、随机选择、打乱顺序、随机布尔值。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['number', 'uuid', 'choice', 'shuffle', 'boolean'],
        description: '操作类型: number随机数, uuid唯一标识, choice随机选择, shuffle打乱顺序, boolean随机布尔'
      },
      min: { type: 'number', description: '最小值（number时使用，默认0）' },
      max: { type: 'number', description: '最大值（number时使用，默认100）' },
      items: { type: 'array', description: '选项数组（choice/shuffle时使用）' },
      count: { type: 'number', description: '生成数量（number/uuid/boolean时使用，默认1）' }
    },
    required: ['operation']
  },
  handler: (args: any) => {
    try {
      const { operation } = args
      switch (operation) {
        case 'number': {
          const min = args.min ?? 0
          const max = args.max ?? 100
          const count = Math.min(Math.max(args.count || 1, 1), 100)
          const results: number[] = []
          for (let i = 0; i < count; i++) {
            results.push(Math.floor(Math.random() * (max - min + 1)) + min)
          }
          return { success: true, result: count === 1 ? results[0] : results }
        }
        case 'uuid': {
          const count = Math.min(Math.max(args.count || 1, 1), 100)
          const results: string[] = []
          for (let i = 0; i < count; i++) {
            results.push(generateUUID())
          }
          return { success: true, result: count === 1 ? results[0] : results }
        }
        case 'choice': {
          const items = args.items || []
          if (items.length === 0) return { success: false, error: '选项数组不能为空' }
          return { success: true, result: items[Math.floor(Math.random() * items.length)] }
        }
        case 'shuffle': {
          const items = [...(args.items || [])]
          for (let i = items.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [items[i], items[j]] = [items[j], items[i]]
          }
          return { success: true, result: items }
        }
        case 'boolean': {
          const count = Math.min(Math.max(args.count || 1, 1), 100)
          const results: boolean[] = []
          for (let i = 0; i < count; i++) {
            results.push(Math.random() < 0.5)
          }
          return { success: true, result: count === 1 ? results[0] : results }
        }
        default: return { success: false, error: 'Unknown operation' }
      }
    } catch (error: any) {
      return { success: false, error: `随机工具失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}