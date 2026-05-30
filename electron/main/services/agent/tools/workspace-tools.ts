import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import WorkspaceManagerService from '../../workspace-manager.service'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import FileParserService from '../../file-parser.service'

const PARSABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

const DEFAULT_MAX_LENGTH = 5000
const MAX_LENGTH_LIMIT = 50000

export function createWorkspaceTools(workspacePath: string): ToolDefinition[] {
  if (!workspacePath) return []

  const workspaceManager = WorkspaceManagerService.getInstance()

  const workspaceListFiles: ToolDefinition = {
    id: 'workspace_list_files',
    name: 'workspace_list_files',
    title: '列出工作区文件',
    description: '列出工作区文件和文件夹，支持子目录和递归。',
    parameters: {
      type: 'object',
      properties: {
        sub_path: { type: 'string', description: '相对于工作区的子目录路径，留空表示根目录' },
        recursive: { type: 'boolean', description: '是否递归列出子目录内容（默认false）' },
      },
      required: [],
    },
    handler: (args: any) => {
      return workspaceManager.listWorkspaceFiles(workspacePath, args.sub_path, args.recursive)
    },
    source: 'workspace',
  }

  const workspaceReadFile: ToolDefinition = {
    id: 'workspace_read_file',
    name: 'workspace_read_file',
    title: '读取工作区文件',
    description: '读取工作区指定文件内容，支持多种格式（PDF、DOCX、DOC、XLSX、XLS、CSV、PPTX、图片OCR）。默认最多返回5000字符，可通过offset和max_length参数分段读取大文件。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对于工作区的文件路径' },
        offset: { type: 'number', description: '起始字符偏移量（默认0）', minimum: 0 },
        max_length: { type: 'number', description: `最大返回字符数（默认${DEFAULT_MAX_LENGTH}，最大${MAX_LENGTH_LIMIT}）`, minimum: 1, maximum: MAX_LENGTH_LIMIT },
      },
      required: ['file_path'],
    },
    handler: async (args: any) => {
      const { fullPath, error: resolveError } = workspaceManager.resolveWorkspacePath(workspacePath, args.file_path)
      if (resolveError) return { success: false, error: resolveError }
      if (!fs.existsSync(fullPath)) return { success: false, error: '文件不存在' }
      if (!fs.statSync(fullPath).isFile()) return { success: false, error: '路径不是文件' }

      const offset = Math.max(0, args.offset || 0)
      const maxLength = Math.min(Math.max(args.max_length || DEFAULT_MAX_LENGTH, 1), MAX_LENGTH_LIMIT)
      const ext = path.extname(fullPath).toLowerCase().slice(1)

      try {
        if (PARSABLE_EXTENSIONS.has(ext)) {
          const parser = FileParserService.getInstance()
          const result = await parser.parseFilePath(fullPath)
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

        const content = fs.readFileSync(fullPath, 'utf-8').replace(/\r\n/g, '\n')
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
      } catch (e: any) {
        return { success: false, error: `读取文件失败: ${e.message}` }
      }
    },
    source: 'workspace',
  }

  const workspaceWriteFile: ToolDefinition = {
    id: 'workspace_write_file',
    name: 'workspace_write_file',
    title: '写入工作区文件',
    description: '向工作区文件写入内容，自动创建父目录，已存在则覆盖。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对于工作区的文件路径' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['file_path', 'content'],
    },
    handler: (args: any) => {
      return workspaceManager.writeWorkspaceFile(workspacePath, args.file_path, args.content)
    },
    source: 'workspace',
  }

  const workspaceCreateFolder: ToolDefinition = {
    id: 'workspace_create_folder',
    name: 'workspace_create_folder',
    title: '创建工作区文件夹',
    description: '在工作区创建文件夹，自动创建父目录。',
    parameters: {
      type: 'object',
      properties: {
        folder_path: { type: 'string', description: '相对于工作区的文件夹路径' },
      },
      required: ['folder_path'],
    },
    handler: (args: any) => {
      return workspaceManager.createWorkspaceFolder(workspacePath, args.folder_path)
    },
    source: 'workspace',
  }

  const workspaceDeleteItem: ToolDefinition = {
    id: 'workspace_delete_item',
    name: 'workspace_delete_item',
    title: '删除工作区文件或文件夹',
    description: '删除工作区文件或文件夹，需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        item_path: { type: 'string', description: '相对于工作区的文件或文件夹路径' },
      },
      required: ['item_path'],
    },
    handler: async (args: any) => {
      const itemPath = String(args.item_path || '').trim()
      if (!itemPath) return { success: false, error: '路径不能为空' }

      const ctx = interactionContext.getStore()
      if (ctx) {
        try {
          const interactionService = UnifiedInteractionService.getInstance()
          const response = await interactionService.request({
            type: 'confirm',
            title: '确认删除',
            message: `即将删除工作区中的 "${itemPath}"，此操作不可撤销。是否确认？`,
            danger: true,
            source: 'security:workspace_delete',
          })

          if (response.cancelled || response.confirmed !== true) {
            return { success: false, error: '用户取消了删除操作' }
          }
        } catch {
          return { success: false, error: '删除确认失败，操作已取消' }
        }
      }

      return workspaceManager.deleteWorkspaceItem(workspacePath, args.item_path)
    },
    source: 'workspace',
  }

  const workspaceRenameItem: ToolDefinition = {
    id: 'workspace_rename_item',
    name: 'workspace_rename_item',
    title: '重命名工作区文件或文件夹',
    description: '重命名工作区文件或文件夹。',
    parameters: {
      type: 'object',
      properties: {
        item_path: { type: 'string', description: '相对于工作区的文件或文件夹路径' },
        new_name: { type: 'string', description: '新的名称（仅文件名/文件夹名，不含路径）' },
      },
      required: ['item_path', 'new_name'],
    },
    handler: (args: any) => {
      return workspaceManager.renameWorkspaceItem(workspacePath, args.item_path, args.new_name)
    },
    source: 'workspace',
  }

  return [
    workspaceListFiles,
    workspaceReadFile,
    workspaceWriteFile,
    workspaceCreateFolder,
    workspaceDeleteItem,
    workspaceRenameItem,
  ]
}

export function getWorkspacePrompt(workspacePath: string): string {
  if (!workspacePath) return ''

  return [
    `\n## 工作区`,
    `工作区根目录：${workspacePath}`,
  ].join('\n')
}
