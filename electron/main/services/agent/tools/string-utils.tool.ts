import type { ToolDefinition } from '../tool.types'

export const stringUtilsTool: ToolDefinition = {
  id: 'string_utils',
  name: 'string_utils',
  title: '字符串工具',
  description: '字符串处理工具：截取、替换、统计、格式化等',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['length', 'substring', 'replace', 'split', 'trim', 'uppercase', 'lowercase', 'reverse', 'pad_start', 'pad_end', 'includes', 'index_of', 'count'],
        description: '操作类型'
      },
      text: { type: 'string', description: '输入文本' },
      start: { type: 'number', description: '起始位置' },
      end: { type: 'number', description: '结束位置' },
      search: { type: 'string', description: '搜索字符串' },
      replacement: { type: 'string', description: '替换字符串' },
      delimiter: { type: 'string', description: '分隔符' },
      target_length: { type: 'number', description: '目标长度（用于pad操作）' },
      pad_string: { type: 'string', description: '填充字符（用于pad操作）' }
    },
    required: ['operation', 'text']
  },
  handler: (args: any) => {
    const { operation, text } = args
    switch (operation) {
      case 'length': return { result: text.length }
      case 'substring': return { result: text.substring(args.start || 0, args.end || text.length) }
      case 'replace': return { result: text.replaceAll(args.search || '', args.replacement || '') }
      case 'split': return { result: text.split(args.delimiter || ',') }
      case 'trim': return { result: text.trim() }
      case 'uppercase': return { result: text.toUpperCase() }
      case 'lowercase': return { result: text.toLowerCase() }
      case 'reverse': return { result: text.split('').reverse().join('') }
      case 'pad_start': return { result: text.padStart(args.target_length || 0, args.pad_string || ' ') }
      case 'pad_end': return { result: text.padEnd(args.target_length || 0, args.pad_string || ' ') }
      case 'includes': return { result: text.includes(args.search || '') }
      case 'index_of': return { result: text.indexOf(args.search || '') }
      case 'count': {
        const matches = text.match(new RegExp(args.search || '', 'g'))
        return { result: matches ? matches.length : 0 }
      }
      default: return { error: 'Unknown operation' }
    }
  },
  source: 'builtin'
}