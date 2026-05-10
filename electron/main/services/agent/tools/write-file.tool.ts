import type { ToolDefinition } from '../tool.types'
import * as fs from 'fs'
import * as path from 'path'

export const writeFileTool: ToolDefinition = {
  id: 'write_file',
  name: 'write_file',
  title: '写入文件',
  description: '将内容写入到本地文件。如果文件已存在则覆盖，会自动创建父目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' }
    },
    required: ['path', 'content']
  },
  handler: (args: any) => {
    try {
      const filePath = String(args.path || '').trim()
      if (!filePath) return { success: false, error: '文件路径不能为空' }

      const resolved = path.resolve(filePath)
      const dir = path.dirname(resolved)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      fs.writeFileSync(resolved, String(args.content || ''), 'utf-8')
      return { success: true, output: `成功写入 ${resolved}，共 ${String(args.content || '').length} 字符` }
    } catch (error: any) {
      return { success: false, error: `写入文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}