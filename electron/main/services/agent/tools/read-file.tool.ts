import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import FileParserService from '../../file-parser.service'

const PARSABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

const DEFAULT_MAX_LENGTH = 5000
const MAX_LENGTH_LIMIT = 50000

export const readFileTool: ToolDefinition = {
  id: 'read_file',
  name: 'read_file',
  title: '读取文件',
  description: '读取本地文件内容。支持纯文本文件和多种二进制格式（PDF、DOCX、DOC、XLSX、XLS、CSV、PPTX、图片OCR）。默认最多返回5000字符，可通过offset和max_length参数分段读取大文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      offset: { type: 'number', description: '起始字符偏移量（默认0）', minimum: 0 },
      max_length: { type: 'number', description: `最大返回字符数（默认${DEFAULT_MAX_LENGTH}，最大${MAX_LENGTH_LIMIT}）`, minimum: 1, maximum: MAX_LENGTH_LIMIT }
    },
    required: ['path']
  },
  handler: async (args: any) => {
    try {
      const filePath = String(args.path || '').trim()
      if (!filePath) return { success: false, error: '文件路径不能为空' }

      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved)) return { success: false, error: `文件不存在: ${filePath}` }
      if (!fs.statSync(resolved).isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

      const offset = Math.max(0, args.offset || 0)
      const maxLength = Math.min(Math.max(args.max_length || DEFAULT_MAX_LENGTH, 1), MAX_LENGTH_LIMIT)
      const ext = path.extname(resolved).toLowerCase().slice(1)

      if (PARSABLE_EXTENSIONS.has(ext)) {
        const parser = FileParserService.getInstance()
        const result = await parser.parseFilePath(resolved)
        const fullText = result.fullText
        const totalChars = fullText.length

        if (offset >= totalChars) {
          return { success: false, error: `偏移量 ${offset} 超出文件总字符数 ${totalChars}` }
        }

        const end = Math.min(offset + maxLength, totalChars)
        const content = fullText.slice(offset, end)

        let output = content
        if (end < totalChars) {
          output += `\n\n(显示字符 ${offset + 1}-${end}，共 ${totalChars} 字符。使用 offset=${end} 继续读取)`
        } else {
          output += `\n\n(文件结束 — 共 ${totalChars} 字符)`
        }

        return { success: true, output }
      }

      const content = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n')
      const totalChars = content.length

      if (offset >= totalChars) {
        return { success: false, error: `偏移量 ${offset} 超出文件总字符数 ${totalChars}` }
      }

      const end = Math.min(offset + maxLength, totalChars)
      const sliced = content.slice(offset, end)

      const beforeOffset = content.slice(0, offset)
      const startLine = (beforeOffset.match(/\n/g) || []).length + 1
      const lines = sliced.split('\n')
      const numbered = lines.map((line, i) => `${startLine + i}| ${line}`)
      let output = numbered.join('\n')

      const totalLines = (content.match(/\n/g) || []).length + 1
      if (end < totalChars) {
        output += `\n\n(显示字符 ${offset + 1}-${end}，第 ${startLine}-${startLine + lines.length - 1} 行，共 ${totalChars} 字符 ${totalLines} 行。使用 offset=${end} 继续读取)`
      } else {
        output += `\n\n(文件结束 — 共 ${totalChars} 字符，${totalLines} 行)`
      }

      return { success: true, output }
    } catch (error: any) {
      return { success: false, error: `读取文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
