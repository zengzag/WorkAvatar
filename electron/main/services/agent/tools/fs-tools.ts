import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { formatFileSize } from './utils'
import { moveToTrash } from '../../common-utils'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import DatabaseService from '../../database.service'

/**
 * 文件操作工具（拆分为 5 个独立工具，降低参数互斥混淆）：
 *   file_read   读取文件内容
 *   file_write  写入文件 / 创建文件夹
 *   file_edit   编辑文件部分内容（替换/插入/删除）
 *   file_manage 删除 / 移动 / 复制 / 重命名 / 查看信息
 *   file_list   列出目录 / 按名称搜索文件
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
      message: `即将删除${inWorkspace ? '工作区中的' : '工作区外的'} ${typeLabel}：\n\n${targetPath}\n\n文件将移至回收站，可从回收站找回，是否确认？`,
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

// ====== file_read：读取文件内容 ======

export const fileReadTool: ToolDefinition = {
  id: 'file_read',
  name: 'file_read',
  title: '读取文件',
  description: `读取本地文件内容。支持文本文件直接读取，parse=true 可解析 PDF/DOCX/XLSX/PPTX/图片 OCR。offset/max_length 分段读取（默认${DEFAULT_MAX_LENGTH}字符），默认显示行号。`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件绝对路径' },
      offset: { type: 'number', description: '起始字符偏移量（默认0）', minimum: 0 },
      max_length: { type: 'number', description: `最大返回字符数（默认${DEFAULT_MAX_LENGTH}，上限${MAX_LENGTH_LIMIT}）`, minimum: 1, maximum: MAX_LENGTH_LIMIT },
      parse: { type: 'boolean', description: '是否解析二进制文档（PDF/DOCX/XLSX/PPTX/图片OCR），默认false' },
      show_line_numbers: { type: 'boolean', description: '是否显示行号（默认true）' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      return await readFile(args)
    } catch (error: any) {
      return { success: false, error: `文件读取失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

// ====== file_write：写入文件 / 创建文件夹 ======

export const fileWriteTool: ToolDefinition = {
  id: 'file_write',
  name: 'file_write',
  title: '写入文件',
  description: '写入文件或创建文件夹。write 写入文件（自动建父目录，append=true 追加，默认覆盖）；mkdir 创建文件夹（-p 语义，自动建父目录）。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['write', 'mkdir'],
        description: '操作类型：write 写文件 / mkdir 创建文件夹',
      },
      path: { type: 'string', description: '目标路径绝对路径' },
      content: { type: 'string', description: '写入内容（write 使用）' },
      append: { type: 'boolean', description: 'write 是否追加模式（默认false，覆盖）' },
    },
    required: ['operation', 'path'],
  },
  handler: async (args: any) => {
    try {
      const op = String(args.operation || '')
      switch (op) {
        case 'write':
          return writeFile(args)
        case 'mkdir':
          return createFolder(args)
        default:
          return { success: false, error: `不支持的 operation: ${op}（可用 write/mkdir）` }
      }
    } catch (error: any) {
      return { success: false, error: `文件写入失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

// ====== file_edit：编辑文件部分内容（替换/插入/删除） ======

export const fileEditTool: ToolDefinition = {
  id: 'file_edit',
  name: 'file_edit',
  title: '编辑文件',
  summary: '对文件部分内容做精确修改（替换/插入/删除），避免全量重写。replace 精确字符串替换；insert 按行号或锚点插入；delete 按行范围或锚点删除。',
  description: '对已有文件进行部分内容修改，避免每次全量重写。replace: 精确字符串替换（old_string→new_string，默认唯一匹配，replace_all=true 替换全部，new_string 为空即删除）；insert: 插入内容（after_string 锚点优先，否则按 line 行号前插入，都不传则追加末尾）；delete: 删除内容（old_string 精确删除优先，否则按 start_line/end_line 行范围删除）。文件必须已存在。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: '操作类型：replace 替换 / insert 插入 / delete 删除',
      },
      path: { type: 'string', description: '目标文件绝对路径（必须已存在）' },
      old_string: { type: 'string', description: 'replace: 要查找的精确文本；delete: 要删除的精确文本。默认必须唯一匹配，replace_all=true 时替换全部' },
      new_string: { type: 'string', description: 'replace: 替换文本（空字符串=删除该文本）' },
      replace_all: { type: 'boolean', description: 'replace: 是否替换所有匹配（默认false，仅替换唯一匹配）' },
      content: { type: 'string', description: 'insert: 要插入的内容' },
      after_string: { type: 'string', description: 'insert: 在该字符串首次出现后插入（优先于 line）' },
      line: { type: 'number', description: 'insert: 在该行号前插入（1-based，0或不传=追加末尾）', minimum: 0 },
      start_line: { type: 'number', description: 'delete: 起始行号（1-based，含）', minimum: 1 },
      end_line: { type: 'number', description: 'delete: 结束行号（1-based，含）', minimum: 1 },
    },
    required: ['operation', 'path'],
  },
  handler: async (args: any) => {
    try {
      const op = String(args.operation || '')
      switch (op) {
        case 'replace':
          return editReplace(args)
        case 'insert':
          return editInsert(args)
        case 'delete':
          return editDelete(args)
        default:
          return { success: false, error: `不支持的 operation: ${op}（可用 replace/insert/delete）` }
      }
    } catch (error: any) {
      return { success: false, error: `文件编辑失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

// ====== file_manage：删除 / 移动 / 复制 / 重命名 / 查看信息 ======

export const fileManageTool: ToolDefinition = {
  id: 'file_manage',
  name: 'file_manage',
  title: '文件管理',
  description: '文件/目录管理操作：rm 删除（移至回收站，可找回，需确认）、mv 移动（目标含文件名）、cp 复制（-r 语义）、rename 仅改文件名（new_name 不含路径分隔符）、stat 查看信息（大小/类型/修改时间/权限）。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['rm', 'mv', 'cp', 'rename', 'stat'],
        description: '操作类型',
      },
      path: { type: 'string', description: '目标路径绝对路径（rm/rename/stat 使用）' },
      source: { type: 'string', description: '源路径绝对路径（mv/cp 使用）' },
      destination: { type: 'string', description: '目标绝对路径含文件名（mv/cp 使用）' },
      new_name: { type: 'string', description: '新名称，仅文件名不含路径（rename 使用）' },
    },
    required: ['operation'],
  },
  handler: async (args: any) => {
    try {
      const op = String(args.operation || '')
      switch (op) {
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
        default:
          return { success: false, error: `不支持的 operation: ${op}（可用 rm/mv/cp/rename/stat）` }
      }
    } catch (error: any) {
      return { success: false, error: `文件管理失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

// ====== file_list：列出目录 / 按名称搜索文件 ======

export const fileListTool: ToolDefinition = {
  id: 'file_list',
  name: 'file_list',
  title: '列出与搜索',
  description: '列出目录内容或按名称搜索文件。不传 pattern 时列出目录（recursive 递归，max_entries 上限默认200）；传 pattern 时按通配符搜索文件名（支持 * 与 ?，如 *.txt）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标目录绝对路径' },
      recursive: { type: 'boolean', description: '列出时是否递归子目录（默认false）' },
      max_entries: { type: 'number', description: '最大返回条目数（默认200，上限1000）', minimum: 1, maximum: 1000 },
      pattern: { type: 'string', description: '文件名匹配模式，支持通配符 * 与 ?（如 *.txt）。传入时执行搜索而非列出目录' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      const pattern = String(args.pattern || '').trim()
      if (pattern) {
        return searchFiles({ ...args, max_results: args.max_entries })
      }
      return listDir(args)
    } catch (error: any) {
      return { success: false, error: `文件列表失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
}

export const fileTools: ToolDefinition[] = [fileReadTool, fileWriteTool, fileEditTool, fileManageTool, fileListTool]

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

  await moveToTrash(resolved)

  return { success: true, output: `成功移至回收站: ${resolved}` }
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

// ====== file_edit 各操作实现 ======

/** 读取目标文件内容并校验，返回 { content, resolved } 或错误对象 */
async function readEditTarget(args: any): Promise<{ content: string; resolved: string } | { success: false; error: string }> {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return { success: false, error: `文件不存在: ${filePath}（file_edit 不会创建文件，请用 file_write 创建）` }
  if (!fs.statSync(resolved).isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

  const confirm = await confirmOutsideWorkspace('编辑', resolved)
  if (!confirm.ok) return { success: false, error: confirm.error || '编辑操作已取消' }

  const content = fs.readFileSync(resolved, 'utf-8').replace(/\r\n/g, '\n')
  return { content, resolved }
}

/** replace: 精确字符串替换 */
async function editReplace(args: any) {
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  if (!oldString) return { success: false, error: 'old_string 不能为空' }
  if (oldString === newString) return { success: false, error: 'old_string 与 new_string 相同，无需替换' }

  const target = await readEditTarget(args)
  if (!('content' in target)) return target

  const replaceAll = args.replace_all === true
  const occurrences = target.content.split(oldString).length - 1

  if (occurrences === 0) {
    return { success: false, error: `未找到匹配文本。请检查 old_string 是否精确匹配文件内容（含缩进/空格/换行）` }
  }
  if (!replaceAll && occurrences > 1) {
    return {
      success: false,
      error: `old_string 在文件中匹配 ${occurrences} 处，不唯一。请提供更多上下文使匹配唯一，或设置 replace_all=true 替换全部`,
    }
  }

  // 使用 split/join 和 slice 避免正则/ `$` 特殊字符问题（String.replace 的 replacement 会解释 $& 等）
  const newContent = replaceAll
    ? target.content.split(oldString).join(newString)
    : (() => {
        const idx = target.content.indexOf(oldString)
        return target.content.slice(0, idx) + newString + target.content.slice(idx + oldString.length)
      })()

  fs.writeFileSync(target.resolved, newContent, 'utf-8')

  const count = replaceAll ? occurrences : 1
  return {
    success: true,
    output: `✓ replace: 替换 ${count} 处（${oldString.length} 字符 → ${newString.length} 字符）\n文件: ${target.resolved}`,
  }
}

/** insert: 插入内容 */
async function editInsert(args: any) {
  const content = String(args.content ?? '')
  if (!content) return { success: false, error: 'content 不能为空' }

  const target = await readEditTarget(args)
  if (!('content' in target)) return target

  const afterString = args.after_string != null ? String(args.after_string) : ''
  const hasAfterString = afterString !== ''
  const lineNum = args.line != null ? Number(args.line) : null

  let newContent: string
  let positionDesc: string

  if (hasAfterString) {
    const idx = target.content.indexOf(afterString)
    if (idx === -1) {
      return { success: false, error: `after_string 未在文件中找到，无法定位插入位置` }
    }
    const insertPos = idx + afterString.length
    newContent = target.content.slice(0, insertPos) + content + target.content.slice(insertPos)
    positionDesc = `在指定文本后`
  } else if (lineNum != null && lineNum > 0) {
    const lines = target.content.split('\n')
    if (lineNum > lines.length + 1) {
      return { success: false, error: `line ${lineNum} 超出文件总行数 ${lines.length}（可插入范围 1~${lines.length + 1}）` }
    }
    const insertIdx = lineNum - 1
    lines.splice(insertIdx, 0, content)
    newContent = lines.join('\n')
    positionDesc = `在第 ${lineNum} 行前`
  } else {
    // 追加到末尾
    newContent = target.content.endsWith('\n') || target.content === ''
      ? target.content + content
      : target.content + '\n' + content
    positionDesc = `在文件末尾`
  }

  fs.writeFileSync(target.resolved, newContent, 'utf-8')

  const insertLines = content.split('\n').length
  return {
    success: true,
    output: `✓ insert: ${positionDesc}插入 ${insertLines} 行内容\n文件: ${target.resolved}`,
  }
}

/** delete: 删除内容 */
async function editDelete(args: any) {
  const target = await readEditTarget(args)
  if (!('content' in target)) return target

  const oldString = args.old_string != null ? String(args.old_string) : ''
  const hasOldString = oldString !== ''
  const startLine = args.start_line != null ? Number(args.start_line) : null
  const endLine = args.end_line != null ? Number(args.end_line) : null

  let newContent: string
  let desc: string

  if (hasOldString) {
    const occurrences = target.content.split(oldString).length - 1
    if (occurrences === 0) {
      return { success: false, error: `old_string 未在文件中找到` }
    }
    if (occurrences > 1) {
      return {
        success: false,
        error: `old_string 在文件中匹配 ${occurrences} 处，不唯一。请提供更多上下文使匹配唯一`,
      }
    }
    const delIdx = target.content.indexOf(oldString)
    newContent = target.content.slice(0, delIdx) + target.content.slice(delIdx + oldString.length)
    desc = `删除指定文本（${oldString.length} 字符）`
  } else if (startLine != null && endLine != null) {
    if (startLine < 1 || endLine < 1) {
      return { success: false, error: 'start_line 和 end_line 必须 ≥ 1' }
    }
    if (startLine > endLine) {
      return { success: false, error: `start_line(${startLine}) 不能大于 end_line(${endLine})` }
    }
    const lines = target.content.split('\n')
    if (startLine > lines.length) {
      return { success: false, error: `start_line ${startLine} 超出文件总行数 ${lines.length}` }
    }
    const actualEnd = Math.min(endLine, lines.length)
    const deletedCount = actualEnd - startLine + 1
    lines.splice(startLine - 1, deletedCount)
    newContent = lines.join('\n')
    desc = `删除第 ${startLine}-${actualEnd} 行（共 ${deletedCount} 行）`
  } else {
    return { success: false, error: '请提供 old_string 或 start_line+end_line 来指定删除范围' }
  }

  fs.writeFileSync(target.resolved, newContent, 'utf-8')

  return {
    success: true,
    output: `✓ delete: ${desc}\n文件: ${target.resolved}`,
  }
}
