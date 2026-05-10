import type { ToolDefinition } from '../tool.types'
import * as fs from 'fs'
import * as path from 'path'
import { formatFileSize } from './utils'

const ignoreDirs = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.coverage', 'htmlcov', '.idea', '.vs',
  'out', 'target', 'bin', 'obj'
])

export const listDirTool: ToolDefinition = {
  id: 'list_dir',
  name: 'list_dir',
  title: '列出目录',
  description: '列出指定目录下的文件和子目录。支持递归列出，自动忽略常见的临时目录。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录绝对路径' },
      recursive: { type: 'boolean', description: '是否递归列出子目录内容（默认false）' },
      max_entries: { type: 'number', description: '最大返回条目数（默认200）', minimum: 1, maximum: 1000 }
    },
    required: ['path']
  },
  handler: (args: any) => {
    try {
      const dirPath = String(args.path || '').trim()
      if (!dirPath) return { success: false, error: '目录路径不能为空' }

      const resolved = path.resolve(dirPath)
      if (!fs.existsSync(resolved)) return { success: false, error: `目录不存在: ${dirPath}` }
      if (!fs.statSync(resolved).isDirectory()) return { success: false, error: `路径不是目录: ${dirPath}` }

      const recursive = args.recursive === true
      const maxEntries = Math.min(Math.max(args.max_entries || 200, 1), 1000)
      const items: string[] = []
      let total = 0

      if (recursive) {
        const walk = (current: string, prefix: string) => {
          const entries = fs.readdirSync(current, { withFileTypes: true })
            .filter(e => !ignoreDirs.has(e.name))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

          for (const entry of entries) {
            if (total >= maxEntries) break
            total++
            const fullPath = path.join(current, entry.name)
            const display = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory()) {
              items.push(`📁 ${display}/`)
              walk(fullPath, display)
            } else {
              const stats = fs.statSync(fullPath)
              items.push(`📄 ${display} (${formatFileSize(stats.size)})`)
            }
          }
        }
        walk(resolved, '')
      } else {
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
          .filter(e => !ignoreDirs.has(e.name))
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

        for (const entry of entries) {
          total++
          if (items.length < maxEntries) {
            if (entry.isDirectory()) {
              items.push(`📁 ${entry.name}/`)
            } else {
              const fullPath = path.join(resolved, entry.name)
              const stats = fs.statSync(fullPath)
              items.push(`📄 ${entry.name} (${formatFileSize(stats.size)})`)
            }
          }
        }
      }

      if (items.length === 0) return { success: true, output: `目录 ${dirPath} 为空` }

      let result = items.join('\n')
      if (total > maxEntries) result += `\n\n(已截断，显示前 ${maxEntries} 条，共 ${total} 条)`
      return { success: true, output: result }
    } catch (error: any) {
      return { success: false, error: `列出目录失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}