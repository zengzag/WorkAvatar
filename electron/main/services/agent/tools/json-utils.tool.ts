import type { ToolDefinition } from './types'

export const jsonUtilsTool: ToolDefinition = {
  id: 'json_utils',
  name: 'json_utils',
  title: 'JSON工具',
  description: 'JSON解析、序列化、路径查询、验证、格式化、压缩。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['parse', 'stringify', 'get', 'validate', 'beautify', 'minify'],
        description: '操作类型: parse解析, stringify序列化, get按路径获取, validate验证, beautify格式化, minify压缩'
      },
      data: { type: 'string', description: 'JSON字符串（parse/validate/beautify/minify时使用）' },
      obj: { type: 'object', description: 'JavaScript对象（stringify时使用）' },
      path: { type: 'string', description: 'JSON路径，如 "users.0.name"（get时使用）' },
      indent: { type: 'number', description: '格式化缩进空格数（默认2）' }
    },
    required: ['operation']
  },
  handler: (args: any) => {
    try {
      const { operation } = args
      switch (operation) {
        case 'parse': return { success: true, result: JSON.parse(args.data || '{}') }
        case 'stringify': return { success: true, result: JSON.stringify(args.obj || {}, null, args.indent || 2) }
        case 'get': {
          const parsed = JSON.parse(args.data || '{}')
          const keys = (args.path || '').split('.')
          let current = parsed
          for (const key of keys) {
            if (current === null || current === undefined) break
            current = current[key]
          }
          return { success: true, result: current }
        }
        case 'validate': {
          JSON.parse(args.data || '{}')
          return { success: true, result: true, message: '有效的JSON' }
        }
        case 'beautify': {
          const parsed = JSON.parse(args.data || '{}')
          return { success: true, result: JSON.stringify(parsed, null, args.indent || 2) }
        }
        case 'minify': {
          const parsed = JSON.parse(args.data || '{}')
          return { success: true, result: JSON.stringify(parsed) }
        }
        default: return { success: false, error: 'Unknown operation' }
      }
    } catch (error: any) {
      return { success: false, error: `JSON操作失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}