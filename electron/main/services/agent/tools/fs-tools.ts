import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { formatFileSize } from './utils'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import DatabaseService from '../../database.service'

const ignoreDirs = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.coverage', 'htmlcov', '.idea', '.vs',
  'out', 'target', 'bin', 'obj'
])

/** 获取当前员工的工作区路径 */
function getWorkspacePath(): string | null {
  try {
    const ctx = interactionContext.getStore()
    if (!ctx || !ctx.employeeId) return null
    const db = DatabaseService.getInstance().getDb()
    const employee = db.prepare('SELECT workspace_path FROM employees WHERE id = ?').get(ctx.employeeId) as { workspace_path: string | null } | undefined
    return employee?.workspace_path || null
  } catch {
    return null
  }
}

/** 判断路径是否在工作区内 */
function isPathInWorkspace(filePath: string): boolean {
  const workspacePath = getWorkspacePath()
  if (!workspacePath) return false
  const resolved = path.resolve(filePath)
  const workspaceRoot = path.resolve(workspacePath)
  return resolved.startsWith(workspaceRoot + path.sep) || resolved === workspaceRoot
}

/** 工作区外写/删除操作需用户确认 */
async function confirmOutsideWorkspace(operation: string, targetPath: string): Promise<{ ok: boolean; error?: string }> {
  if (isPathInWorkspace(targetPath)) return { ok: true }

  const ctx = interactionContext.getStore()
  if (!ctx) return { ok: true }

  try {
    const interactionService = UnifiedInteractionService.getInstance()
    const response = await interactionService.request({
      type: 'confirm',
      title: `确认${operation}工作区外文件`,
      message: `即将${operation}工作区外的路径：\n\n${targetPath}\n\n此操作可能影响工作区外的文件，是否确认？`,
      danger: true,
      source: `security:fs_${operation}_outside_workspace`,
    })

    if (response.cancelled || response.confirmed !== true) {
      return { ok: false, error: `用户取消了${operation}工作区外文件的操作` }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: `${operation}确认失败，操作已取消` }
  }
}

/** 删除操作（含工作区内）需用户确认 */
async function confirmDelete(targetPath: string, isDirectory: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = interactionContext.getStore()
  if (!ctx) return { ok: true }

  const typeLabel = isDirectory ? '文件夹' : '文件'
  const inWorkspace = isPathInWorkspace(targetPath)

  try {
    const interactionService = UnifiedInteractionService.getInstance()
    const response = await interactionService.request({
      type: 'confirm',
      title: '确认删除',
      message: `即将删除${inWorkspace ? '工作区中的' : '工作区外的'} ${typeLabel}：\n\n${targetPath}\n\n此操作不可撤销，是否确认？`,
      danger: true,
      source: 'security:fs_delete',
    })

    if (response.cancelled || response.confirmed !== true) {
      return { ok: false, error: '用户取消了删除操作' }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: '删除确认失败，操作已取消' }
  }
}

// ─── list_dir ───

export const listDirTool: ToolDefinition = {
  id: 'list_dir',
  name: 'list_dir',
  title: '列出目录',
  description: '列出指定目录下的文件和子目录，支持递归，自动忽略临时目录。返回结构化的文件列表（名称、类型、大小、修改时间）。',
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
      const items: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: string }> = []
      let total = 0
      let truncated = false

      const walk = (current: string, prefix: string) => {
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(current, { withFileTypes: true })
            .filter(e => !ignoreDirs.has(e.name))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
        } catch { return }

        for (const entry of entries) {
          if (total >= maxEntries) { truncated = true; break }
          total++
          const fullPath = path.join(current, entry.name)
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
          if (entry.isDirectory()) {
            items.push({ name: entry.name, path: relativePath, type: 'dir' })
            if (recursive) walk(fullPath, relativePath)
          } else {
            try {
              const stats = fs.statSync(fullPath)
              items.push({
                name: entry.name,
                path: relativePath,
                type: 'file',
                size: stats.size,
                modified: stats.mtime.toISOString().slice(0, 19),
              })
            } catch {
              items.push({ name: entry.name, path: relativePath, type: 'file' })
            }
          }
        }
      }

      walk(resolved, '')

      if (items.length === 0) return { success: true, output: `目录 ${dirPath} 为空` }

      // 格式化输出：兼顾可读性和结构化信息
      const lines = items.map(item => {
        if (item.type === 'dir') {
          return `📁 ${item.path}/`
        }
        const sizeStr = item.size !== undefined ? ` (${formatFileSize(item.size)})` : ''
        const modStr = item.modified ? ` ${item.modified}` : ''
        return `📄 ${item.path}${sizeStr}${modStr}`
      })

      let result = lines.join('\n')
      if (truncated) result += `\n\n(已截断，显示前 ${total} 条)`
      return { success: true, output: result }
    } catch (error: any) {
      return { success: false, error: `列出目录失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── read_file ───

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
  description: '读取本地文件内容。默认以纯文本方式读取，支持分段读取。设置 parse=true 可解析 PDF、DOCX、XLSX、PPTX、图片等二进制格式。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      parse: { type: 'boolean', description: '是否启用文档解析（解析 PDF/DOCX/XLSX/PPTX/图片OCR 等二进制格式），默认false' },
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
      const enableParse = args.parse === true
      const ext = path.extname(resolved).toLowerCase().slice(1)

      // 默认以纯文本读取，仅当显式设置 parse=true 时才解析二进制文档
      if (enableParse && PARSABLE_EXTENSIONS.has(ext)) {
        const parser = require('../../file-parser.service').default.getInstance()
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

      // 纯文本读取（默认路径）
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

// ─── write_file ───

export const writeFileTool: ToolDefinition = {
  id: 'write_file',
  name: 'write_file',
  title: '写入文件',
  description: '将内容写入本地文件，自动创建父目录。写入工作区外需用户确认。支持 append 模式追加内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' },
      append: { type: 'boolean', description: '是否追加模式（默认false，覆盖写入）' }
    },
    required: ['path', 'content']
  },
  handler: async (args: any) => {
    try {
      const filePath = String(args.path || '').trim()
      if (!filePath) return { success: false, error: '文件路径不能为空' }

      const resolved = path.resolve(filePath)

      // 工作区外需确认
      const confirm = await confirmOutsideWorkspace('写入', resolved)
      if (!confirm.ok) return { success: false, error: confirm.error }

      const dir = path.dirname(resolved)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      const content = String(args.content || '')
      const append = args.append === true

      if (append) {
        fs.appendFileSync(resolved, content, 'utf-8')
      } else {
        fs.writeFileSync(resolved, content, 'utf-8')
      }

      const mode = append ? '追加' : '写入'
      return { success: true, output: `成功${mode} ${resolved}，共 ${content.length} 字符` }
    } catch (error: any) {
      return { success: false, error: `写入文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── create_folder ───

export const createFolderTool: ToolDefinition = {
  id: 'create_folder',
  name: 'create_folder',
  title: '创建文件夹',
  description: '创建文件夹，自动创建父目录。在工作区外创建需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要创建的文件夹绝对路径' },
    },
    required: ['path']
  },
  handler: async (args: any) => {
    try {
      const folderPath = String(args.path || '').trim()
      if (!folderPath) return { success: false, error: '文件夹路径不能为空' }

      const resolved = path.resolve(folderPath)

      // 工作区外需确认
      const confirm = await confirmOutsideWorkspace('创建文件夹于', resolved)
      if (!confirm.ok) return { success: false, error: confirm.error }

      if (fs.existsSync(resolved)) {
        return { success: false, error: `路径已存在: ${resolved}` }
      }

      fs.mkdirSync(resolved, { recursive: true })
      return { success: true, output: `成功创建文件夹: ${resolved}` }
    } catch (error: any) {
      return { success: false, error: `创建文件夹失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── delete_item ───

export const deleteItemTool: ToolDefinition = {
  id: 'delete_item',
  name: 'delete_item',
  title: '删除文件或文件夹',
  description: '删除文件或文件夹，需用户确认。此操作不可撤销。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件或文件夹绝对路径' },
    },
    required: ['path']
  },
  handler: async (args: any) => {
    try {
      const itemPath = String(args.path || '').trim()
      if (!itemPath) return { success: false, error: '路径不能为空' }

      const resolved = path.resolve(itemPath)
      if (!fs.existsSync(resolved)) return { success: false, error: `路径不存在: ${resolved}` }

      const stat = fs.statSync(resolved)
      const isDirectory = stat.isDirectory()

      // 所有删除操作均需确认
      const confirm = await confirmDelete(resolved, isDirectory)
      if (!confirm.ok) return { success: false, error: confirm.error }

      if (isDirectory) {
        fs.rmSync(resolved, { recursive: true, force: true })
      } else {
        fs.unlinkSync(resolved)
      }

      return { success: true, output: `成功删除: ${resolved}` }
    } catch (error: any) {
      return { success: false, error: `删除失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── rename_item ───

export const renameItemTool: ToolDefinition = {
  id: 'rename_item',
  name: 'rename_item',
  title: '重命名文件或文件夹',
  description: '重命名文件或文件夹。重命名工作区外的项目需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要重命名的文件或文件夹绝对路径' },
      new_name: { type: 'string', description: '新的名称（仅文件名/文件夹名，不含路径）' },
    },
    required: ['path', 'new_name']
  },
  handler: async (args: any) => {
    try {
      const itemPath = String(args.path || '').trim()
      const newName = String(args.new_name || '').trim()
      if (!itemPath) return { success: false, error: '路径不能为空' }
      if (!newName) return { success: false, error: '新名称不能为空' }

      // 防止路径遍历
      if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
        return { success: false, error: '新名称不能包含路径分隔符或上级引用' }
      }

      const resolved = path.resolve(itemPath)
      if (!fs.existsSync(resolved)) return { success: false, error: `路径不存在: ${resolved}` }

      const dir = path.dirname(resolved)
      const newPath = path.join(dir, newName)

      // 工作区外需确认
      const confirm = await confirmOutsideWorkspace('重命名', resolved)
      if (!confirm.ok) return { success: false, error: confirm.error }

      if (fs.existsSync(newPath)) {
        return { success: false, error: `目标名称已存在: ${newPath}` }
      }

      fs.renameSync(resolved, newPath)
      return { success: true, output: `成功重命名: ${resolved} → ${newPath}` }
    } catch (error: any) {
      return { success: false, error: `重命名失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── move_item ───

export const moveItemTool: ToolDefinition = {
  id: 'move_item',
  name: 'move_item',
  title: '移动文件或文件夹',
  description: '将文件或文件夹移动到新位置。移动到工作区外或从工作区外移动需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件或文件夹绝对路径' },
      destination: { type: 'string', description: '目标绝对路径（含文件名）' },
    },
    required: ['source', 'destination']
  },
  handler: async (args: any) => {
    try {
      const sourcePath = String(args.source || '').trim()
      const destPath = String(args.destination || '').trim()
      if (!sourcePath) return { success: false, error: '源路径不能为空' }
      if (!destPath) return { success: false, error: '目标路径不能为空' }

      const resolvedSource = path.resolve(sourcePath)
      const resolvedDest = path.resolve(destPath)

      if (!fs.existsSync(resolvedSource)) return { success: false, error: `源路径不存在: ${resolvedSource}` }
      if (fs.existsSync(resolvedDest)) return { success: false, error: `目标路径已存在: ${resolvedDest}` }

      // 源或目标在工作区外需确认
      const confirmSrc = await confirmOutsideWorkspace('移动', resolvedSource)
      if (!confirmSrc.ok) return { success: false, error: confirmSrc.error }
      const confirmDest = await confirmOutsideWorkspace('移动至', resolvedDest)
      if (!confirmDest.ok) return { success: false, error: confirmDest.error }

      // 确保目标父目录存在
      const destDir = path.dirname(resolvedDest)
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

      fs.renameSync(resolvedSource, resolvedDest)
      return { success: true, output: `成功移动: ${resolvedSource} → ${resolvedDest}` }
    } catch (error: any) {
      return { success: false, error: `移动失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── copy_item ───

export const copyItemTool: ToolDefinition = {
  id: 'copy_item',
  name: 'copy_item',
  title: '复制文件或文件夹',
  description: '复制文件或文件夹到新位置。复制到工作区外需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源文件或文件夹绝对路径' },
      destination: { type: 'string', description: '目标绝对路径（含文件名）' },
    },
    required: ['source', 'destination']
  },
  handler: async (args: any) => {
    try {
      const sourcePath = String(args.source || '').trim()
      const destPath = String(args.destination || '').trim()
      if (!sourcePath) return { success: false, error: '源路径不能为空' }
      if (!destPath) return { success: false, error: '目标路径不能为空' }

      const resolvedSource = path.resolve(sourcePath)
      const resolvedDest = path.resolve(destPath)

      if (!fs.existsSync(resolvedSource)) return { success: false, error: `源路径不存在: ${resolvedSource}` }
      if (fs.existsSync(resolvedDest)) return { success: false, error: `目标路径已存在: ${resolvedDest}` }

      // 目标在工作区外需确认
      const confirm = await confirmOutsideWorkspace('复制至', resolvedDest)
      if (!confirm.ok) return { success: false, error: confirm.error }

      // 确保目标父目录存在
      const destDir = path.dirname(resolvedDest)
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

      const stat = fs.statSync(resolvedSource)
      if (stat.isDirectory()) {
        fs.cpSync(resolvedSource, resolvedDest, { recursive: true })
      } else {
        fs.copyFileSync(resolvedSource, resolvedDest)
      }

      return { success: true, output: `成功复制: ${resolvedSource} → ${resolvedDest}` }
    } catch (error: any) {
      return { success: false, error: `复制失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── get_file_info ───

export const getFileInfoTool: ToolDefinition = {
  id: 'get_file_info',
  name: 'get_file_info',
  title: '获取文件信息',
  description: '获取文件或文件夹的详细信息（大小、类型、修改时间、权限等）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件或文件夹绝对路径' },
    },
    required: ['path']
  },
  handler: (args: any) => {
    try {
      const itemPath = String(args.path || '').trim()
      if (!itemPath) return { success: false, error: '路径不能为空' }

      const resolved = path.resolve(itemPath)
      if (!fs.existsSync(resolved)) return { success: false, error: `路径不存在: ${resolved}` }

      const stat = fs.statSync(resolved)
      const info: Record<string, any> = {
        path: resolved,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isDirectory() ? undefined : formatFileSize(stat.size),
        sizeBytes: stat.size,
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        permissions: stat.mode.toString(8).slice(-3),
      }

      if (stat.isFile()) {
        const ext = path.extname(resolved).toLowerCase()
        info.extension = ext || '(无扩展名)'
      }

      const lines = Object.entries(info)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)

      return { success: true, output: lines.join('\n') }
    } catch (error: any) {
      return { success: false, error: `获取文件信息失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}

// ─── search_files ───

export const searchFilesTool: ToolDefinition = {
  id: 'search_files',
  name: 'search_files',
  title: '搜索文件',
  description: '在指定目录下按名称模式搜索文件，支持通配符（* 和 ?）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '搜索的根目录绝对路径' },
      pattern: { type: 'string', description: '文件名匹配模式，支持通配符 * 和 ?（如 *.txt、report*.xlsx）' },
      max_results: { type: 'number', description: '最大返回结果数（默认50）', minimum: 1, maximum: 200 },
    },
    required: ['path', 'pattern']
  },
  handler: (args: any) => {
    try {
      const dirPath = String(args.path || '').trim()
      const pattern = String(args.pattern || '').trim()
      if (!dirPath) return { success: false, error: '目录路径不能为空' }
      if (!pattern) return { success: false, error: '搜索模式不能为空' }

      const resolved = path.resolve(dirPath)
      if (!fs.existsSync(resolved)) return { success: false, error: `目录不存在: ${dirPath}` }
      if (!fs.statSync(resolved).isDirectory()) return { success: false, error: `路径不是目录: ${dirPath}` }

      const maxResults = Math.min(Math.max(args.max_results || 50, 1), 200)

      // 将通配符模式转换为正则
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
      const regex = new RegExp(`^${regexStr}$`, 'i')

      const results: string[] = []

      const walk = (current: string) => {
        if (results.length >= maxResults) return
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(current, { withFileTypes: true })
        } catch { return }

        for (const entry of entries) {
          if (results.length >= maxResults) break
          if (ignoreDirs.has(entry.name)) continue

          const fullPath = path.join(current, entry.name)
          if (entry.isDirectory()) {
            walk(fullPath)
          } else {
            if (regex.test(entry.name)) {
              const relativePath = path.relative(resolved, fullPath).replace(/\\/g, '/')
              const stat = fs.statSync(fullPath)
              results.push(`📄 ${relativePath} (${formatFileSize(stat.size)})`)
            }
          }
        }
      }

      walk(resolved)

      if (results.length === 0) {
        return { success: true, output: `未找到匹配 "${pattern}" 的文件` }
      }

      let output = results.join('\n')
      if (results.length >= maxResults) {
        output += `\n\n(已达到最大结果数 ${maxResults}，可能还有更多匹配)`
      }
      return { success: true, output }
    } catch (error: any) {
      return { success: false, error: `搜索文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
