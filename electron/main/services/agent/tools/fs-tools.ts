import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { formatFileSize } from './utils'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import DatabaseService from '../../database.service'

/**
 * 文件操作工具（合并为单个 file 工具）
 * operation 字段沿用类 Unix 命令名，复用 LLM 已有知识，减少说明成本：
 *   ls / cat / write / mkdir / rm / mv / cp / rename / stat / find
 */

const ignoreDirs = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.coverage', 'htmlcov', '.idea', '.vs',
  'out', 'target', 'bin', 'obj'
])

export function getWorkspacePath(): string | null {
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

export function isPathInWorkspace(filePath: string): boolean {
  const workspacePath = getWorkspacePath()
  if (!workspacePath) return false
  const resolved = path.resolve(filePath)
  const workspaceRoot = path.resolve(workspacePath)
  return resolved.startsWith(workspaceRoot + path.sep) || resolved === workspaceRoot
}

/** 工作区外写/删除操作需用户确认，高权限模式下跳过 */
export async function confirmOutsideWorkspace(operation: string, targetPath: string): Promise<{ ok: boolean; error?: string }> {
  if (isPathInWorkspace(targetPath)) return { ok: true }

  const ctx = interactionContext.getStore()
  if (!ctx) return { ok: true }

  if (ctx.highPermission) return { ok: true }

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

/** 删除操作（含工作区内）需用户确认，高权限模式下跳过 */
async function confirmDelete(targetPath: string, isDirectory: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = interactionContext.getStore()
  if (!ctx) return { ok: true }

  if (ctx.highPermission) return { ok: true }

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

const PARSABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

const DEFAULT_MAX_LENGTH = 5000
const MAX_LENGTH_LIMIT = 50000

const FILE_TOOL_DESCRIPTION = `本地文件/目录操作，operation 为类 Unix 命令名（语义与终端一致）：
- ls <path>：列出目录，recursive 递归，max_entries 上限（默认200）
- cat <path>：读取文件，offset/max_length 分段（默认${DEFAULT_MAX_LENGTH}字符），parse=true 解析 PDF/DOCX/XLSX/PPTX/图片，show_line_numbers=false 关闭行号
- write <path> <content>：写文件（自动建父目录），append=true 追加；工作区外需确认
- mkdir <path>：创建文件夹（-p 语义，自动建父目录）；工作区外需确认
- rm <path>：删除文件/文件夹（-rf 语义），需确认
- mv <source> <destination>：移动/重命名（目标含文件名），工作区外需确认
- cp <source> <destination>：复制（-r 语义，目标含文件名），工作区外需确认
- rename <path> <new_name>：仅改文件名（new_name 不含路径分隔符）
- stat <path>：查看文件/目录信息（大小/类型/修改时间/权限）
- find <path> <pattern>：按名称通配符搜索（支持 * 与 ?，如 *.txt）`

export const fileTool: ToolDefinition = {
  id: 'file',
  name: 'file',
  title: '文件操作',
  description: FILE_TOOL_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['ls', 'cat', 'write', 'mkdir', 'rm', 'mv', 'cp', 'rename', 'stat', 'find'],
        description: '操作类型（类 Unix 命令名）',
      },
      path: { type: 'string', description: '目标路径绝对路径（ls/cat/write/mkdir/rm/rename/stat/find 使用）' },
      source: { type: 'string', description: '源路径绝对路径（mv/cp 使用）' },
      destination: { type: 'string', description: '目标绝对路径含文件名（mv/cp 使用）' },
      new_name: { type: 'string', description: '新名称，仅文件名不含路径（rename 使用）' },
      content: { type: 'string', description: '写入内容（write 使用）' },
      append: { type: 'boolean', description: 'write 是否追加模式（默认false，覆盖）' },
      recursive: { type: 'boolean', description: 'ls 是否递归列出子目录（默认false）' },
      max_entries: { type: 'number', description: 'ls 最大返回条目数（默认200，上限1000）', minimum: 1, maximum: 1000 },
      parse: { type: 'boolean', description: 'cat 是否解析二进制文档（PDF/DOCX/XLSX/PPTX/图片OCR），默认false' },
      offset: { type: 'number', description: 'cat 起始字符偏移量（默认0）', minimum: 0 },
      max_length: { type: 'number', description: `cat 最大返回字符数（默认${DEFAULT_MAX_LENGTH}，上限${MAX_LENGTH_LIMIT}）`, minimum: 1, maximum: MAX_LENGTH_LIMIT },
      show_line_numbers: { type: 'boolean', description: 'cat 是否显示行号（默认true）' },
      pattern: { type: 'string', description: 'find 文件名匹配模式，支持通配符 * 与 ?（如 *.txt）' },
      max_results: { type: 'number', description: 'find 最大返回结果数（默认50，上限200）', minimum: 1, maximum: 200 },
    },
    required: ['operation'],
  },
  handler: async (args: any) => {
    try {
      const op = String(args.operation || '')
      switch (op) {
        case 'ls':
          return listDir(args)
        case 'cat':
          return readFile(args)
        case 'write':
          return writeFile(args)
        case 'mkdir':
          return createFolder(args)
        case 'rm':
          return deleteItem(args)
        case 'mv':
          return moveItem(args)
        case 'cp':
          return copyItem(args)
        case 'rename':
          return renameItem(args)
        case 'stat':
          return getFileInfo(args)
        case 'find':
          return searchFiles(args)
        default:
          return { success: false, error: `不支持的 operation: ${op}（可用 ls/cat/write/mkdir/rm/mv/cp/rename/stat/find）` }
      }
    } catch (error: any) {
      return { success: false, error: `文件操作失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

// ====== 各操作实现 ======

function listDir(args: any) {
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
}

async function readFile(args: any) {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return { success: false, error: `文件不存在: ${filePath}` }
  if (!fs.statSync(resolved).isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

  const offset = Math.max(0, args.offset || 0)
  const maxLength = Math.min(Math.max(args.max_length || DEFAULT_MAX_LENGTH, 1), MAX_LENGTH_LIMIT)
  const enableParse = args.parse === true
  const ext = path.extname(resolved).toLowerCase().slice(1)

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

  const content = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n')
  const totalChars = content.length

  if (offset >= totalChars) {
    return { success: false, error: `偏移量 ${offset} 超出文件总字符数 ${totalChars}` }
  }

  const end = Math.min(offset + maxLength, totalChars)
  const sliced = content.slice(offset, end)

  const beforeOffset = content.slice(0, offset)
  const showLineNumbers = args.show_line_numbers !== false
  const startLine = (beforeOffset.match(/\n/g) || []).length + 1
  const lines = sliced.split('\n')
  let output: string
  if (showLineNumbers) {
    const numbered = lines.map((line, i) => `${startLine + i}| ${line}`)
    output = numbered.join('\n')
  } else {
    output = sliced
  }

  const totalLines = (content.match(/\n/g) || []).length + 1
  if (end < totalChars) {
    output += `\n\n(显示字符 ${offset + 1}-${end}，第 ${startLine}-${startLine + lines.length - 1} 行，共 ${totalChars} 字符 ${totalLines} 行。使用 offset=${end} 继续读取)`
  } else {
    output += `\n\n(文件结束 — 共 ${totalChars} 字符，${totalLines} 行)`
  }

  return { success: true, output }
}

async function writeFile(args: any) {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = path.resolve(filePath)
  const append = args.append === true

  const confirm = await confirmOutsideWorkspace(append ? '追加' : '写入', resolved)
  if (!confirm.ok) return { success: false, error: confirm.error }

  const dir = path.dirname(resolved)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const content = String(args.content || '')

  if (append) {
    fs.appendFileSync(resolved, content, 'utf-8')
  } else {
    fs.writeFileSync(resolved, content, 'utf-8')
  }

  const mode = append ? '追加' : '写入'
  return { success: true, output: `成功${mode} ${resolved}，共 ${content.length} 字符` }
}

async function createFolder(args: any) {
  const folderPath = String(args.path || '').trim()
  if (!folderPath) return { success: false, error: '文件夹路径不能为空' }

  const resolved = path.resolve(folderPath)

  const confirm = await confirmOutsideWorkspace('创建文件夹于', resolved)
  if (!confirm.ok) return { success: false, error: confirm.error }

  if (fs.existsSync(resolved)) {
    return { success: false, error: `路径已存在: ${resolved}` }
  }

  fs.mkdirSync(resolved, { recursive: true })
  return { success: true, output: `成功创建文件夹: ${resolved}` }
}

async function deleteItem(args: any) {
  const itemPath = String(args.path || '').trim()
  if (!itemPath) return { success: false, error: '路径不能为空' }

  const resolved = path.resolve(itemPath)
  if (!fs.existsSync(resolved)) return { success: false, error: `路径不存在: ${resolved}` }

  const stat = fs.statSync(resolved)
  const isDirectory = stat.isDirectory()

  const confirm = await confirmDelete(resolved, isDirectory)
  if (!confirm.ok) return { success: false, error: confirm.error }

  if (isDirectory) {
    fs.rmSync(resolved, { recursive: true, force: true })
  } else {
    fs.unlinkSync(resolved)
  }

  return { success: true, output: `成功删除: ${resolved}` }
}

async function moveItem(args: any) {
  const sourcePath = String(args.source || '').trim()
  const destPath = String(args.destination || '').trim()
  if (!sourcePath) return { success: false, error: '源路径不能为空' }
  if (!destPath) return { success: false, error: '目标路径不能为空' }

  const resolvedSource = path.resolve(sourcePath)
  const resolvedDest = path.resolve(destPath)

  if (!fs.existsSync(resolvedSource)) return { success: false, error: `源路径不存在: ${resolvedSource}` }
  if (fs.existsSync(resolvedDest)) return { success: false, error: `目标路径已存在: ${resolvedDest}` }

  const confirmSrc = await confirmOutsideWorkspace('移动', resolvedSource)
  if (!confirmSrc.ok) return { success: false, error: confirmSrc.error }
  const confirmDest = await confirmOutsideWorkspace('移动至', resolvedDest)
  if (!confirmDest.ok) return { success: false, error: confirmDest.error }

  const destDir = path.dirname(resolvedDest)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

  fs.renameSync(resolvedSource, resolvedDest)
  return { success: true, output: `成功移动: ${resolvedSource} → ${resolvedDest}` }
}

async function copyItem(args: any) {
  const sourcePath = String(args.source || '').trim()
  const destPath = String(args.destination || '').trim()
  if (!sourcePath) return { success: false, error: '源路径不能为空' }
  if (!destPath) return { success: false, error: '目标路径不能为空' }

  const resolvedSource = path.resolve(sourcePath)
  const resolvedDest = path.resolve(destPath)

  if (!fs.existsSync(resolvedSource)) return { success: false, error: `源路径不存在: ${resolvedSource}` }
  if (fs.existsSync(resolvedDest)) return { success: false, error: `目标路径已存在: ${resolvedDest}` }

  const confirm = await confirmOutsideWorkspace('复制至', resolvedDest)
  if (!confirm.ok) return { success: false, error: confirm.error }

  const destDir = path.dirname(resolvedDest)
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })

  const stat = fs.statSync(resolvedSource)
  if (stat.isDirectory()) {
    fs.cpSync(resolvedSource, resolvedDest, { recursive: true })
  } else {
    fs.copyFileSync(resolvedSource, resolvedDest)
  }

  return { success: true, output: `成功复制: ${resolvedSource} → ${resolvedDest}` }
}

async function renameItem(args: any) {
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

  const confirm = await confirmOutsideWorkspace('重命名', resolved)
  if (!confirm.ok) return { success: false, error: confirm.error }

  if (fs.existsSync(newPath)) {
    return { success: false, error: `目标名称已存在: ${newPath}` }
  }

  fs.renameSync(resolved, newPath)
  return { success: true, output: `成功重命名: ${resolved} → ${newPath}` }
}

function getFileInfo(args: any) {
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
}

function searchFiles(args: any) {
  const dirPath = String(args.path || '').trim()
  const pattern = String(args.pattern || '').trim()
  if (!dirPath) return { success: false, error: '目录路径不能为空' }
  if (!pattern) return { success: false, error: '搜索模式不能为空' }

  const resolved = path.resolve(dirPath)
  if (!fs.existsSync(resolved)) return { success: false, error: `目录不存在: ${dirPath}` }
  if (!fs.statSync(resolved).isDirectory()) return { success: false, error: `路径不是目录: ${dirPath}` }

  const maxResults = Math.min(Math.max(args.max_results || 50, 1), 200)

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
}
