import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'

export const readFileTool: ToolDefinition = {
  id: 'read_file',
  name: 'read_file',
  title: '读取文件',
  description: '读取本地文本文件，支持指定起始行和最大行数。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      offset: { type: 'number', description: '起始行号（从1开始，默认1）', minimum: 1 },
      limit: { type: 'number', description: '最大读取行数（默认500）', minimum: 1, maximum: 5000 }
    },
    required: ['path']
  },
  handler: (args: any) => {
    try {
      const filePath = String(args.path || '').trim()
      if (!filePath) return { success: false, error: '文件路径不能为空' }

      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved)) return { success: false, error: `文件不存在: ${filePath}` }
      if (!fs.statSync(resolved).isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

      const content = fs.readFileSync(resolved, 'utf-8')
      const lines = content.replace(/\r\n/g, '\n').split('\n')
      const total = lines.length

      const offset = Math.max(1, args.offset || 1)
      const limit = Math.min(Math.max(args.limit || 500, 1), 5000)

      if (offset > total) return { success: false, error: `起始行 ${offset} 超出文件总行数 ${total}` }

      const start = offset - 1
      const end = Math.min(start + limit, total)
      const selected = lines.slice(start, end)
      const numbered = selected.map((line, i) => `${start + i + 1}| ${line}`)
      let result = numbered.join('\n')

      if (end < total) {
        result += `\n\n(显示第 ${offset}-${end} 行，共 ${total} 行。使用 offset=${end + 1} 继续读取)`
      } else {
        result += `\n\n(文件结束 — 共 ${total} 行)`
      }

      return { success: true, output: result }
    } catch (error: any) {
      return { success: false, error: `读取文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}