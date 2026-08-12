import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { formatFileSize } from './utils'
import { moveToTrash } from '../../common-utils'
import UnifiedInteractionService, { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import DatabaseService from '../../database.service'

/**
 * 文件操作工具（聚合已拆分，file_edit 保留 operation 字段聚合）：
 *
 * 常驻工具（加入 LLM tools 数组，对话全程不变）：
 *   file_read   读取文件内容
 *   file_write  写入文件（覆盖/追加）
 *   file_edit   编辑文件部分内容（replace/insert/delete 三种模式）
 *
 * 按需工具（通过 list_available_tools + invoke_tool 发现和调用）：
 *   file_mkdir   创建文件夹
 *   file_list    列出目录内容
 *   file_search  按通配符搜索文件名
 *   file_delete  删除（移至回收站）
 *   file_move    移动
 *   file_copy    复制
 *   file_rename  重命名
 *   file_stat    查看文件/目录信息
 */

const ignoreDirs = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.coverage', 'htmlcov', '.idea', '.vs',
  'out', 'target', 'bin', 'obj'
])

/** 当前任务的有效工作区目录：优先任务独立目录，旧对话（无任务目录）回退到员工工作区 */
export function getWorkspacePath(): string | null {
  try {
    const ctx = interactionContext.getStore()
    if (!ctx || !ctx.employeeId) return null
    const db = DatabaseService.getInstance().getDb()
    // 优先使用当前对话的任务工作区（沙箱边界）
    if (ctx.conversationId) {
      const conv = db.prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(ctx.conversationId) as { workspace_path?: string } | undefined
      if (conv?.workspace_path) return conv.workspace_path
    }
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
  // 无交互上下文时默认拒绝，防止自动化任务等后台场景绕过工作区边界
  if (!ctx) return { ok: false, error: `${operation}工作区外文件需要交互确认，但当前无交互上下文（可能是后台任务），已拒绝` }

  if (ctx.highPermission) return { ok: true }

  try {
    const interactionService = UnifiedInteractionService.getInstance()
    const response = await interactionService.request({
      type: 'confirm',
      title: `确认${operation}工作区外文件`,
      message: `即将${operation}工作区外的路径：\n\n${targetPath}\n\n此操作可能影响工作区外的文件，是否确认？`,
      danger: true,
      source: `security:fs_${operation}_outside_workspace`,
      pathScope: targetPath,
    })

    if (response.cancelled || response.confirmed !== true) {
      const reason = response.timedOut
        ? `用户在5分钟内未响应${operation}确认，可能不在电脑旁，操作已取消`
        : `用户取消了${operation}工作区外文件的操作`
      return { ok: false, error: reason }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: `${operation}确认失败，操作已取消` }
  }
}

/** 删除操作（含工作区内）需用户确认，高权限模式下跳过 */
async function confirmDelete(targetPath: string, isDirectory: boolean): Promise<{ ok: boolean; error?: string }> {
  const ctx = interactionContext.getStore()
  // 无交互上下文时默认拒绝，防止后台任务静默删除文件
  if (!ctx) return { ok: false, error: '删除操作需要交互确认，但当前无交互上下文（可能是后台任务），已拒绝' }

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
      pathScope: targetPath,
    })

    if (response.cancelled || response.confirmed !== true) {
      const reason = response.timedOut
        ? '用户在5分钟内未响应删除确认，可能不在电脑旁，操作已取消'
        : '用户取消了删除操作'
      return { ok: false, error: reason }
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

// ====== 常驻工具 ======

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

// ====== file_write：写入文件（覆盖/追加） ======

export const fileWriteTool: ToolDefinition = {
  id: 'file_write',
  name: 'file_write',
  title: '写入文件',
  description: '写入文件，自动建父目录。append=true 追加到文件末尾（默认false，覆盖）。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件绝对路径' },
      content: { type: 'string', description: '写入内容' },
      append: { type: 'boolean', description: '是否追加模式（默认false，覆盖）' },
    },
    required: ['path', 'content'],
  },
  handler: async (args: any) => {
    try {
      return writeFile(args)
    } catch (error: any) {
      return { success: false, error: `文件写入失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_edit：编辑文件部分内容（replace/insert/delete） ======

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
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== report_generated_files：声明需要展示给用户的成品文件 ======

/** 可预览文件扩展名白名单（与前端 GeneratedFilesBar 展示范围一致） */
const PREVIEWABLE_EXTS = new Set([
  'docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt',
  'xlsx', 'xltx', 'xlsm', 'xlsb', 'xls', 'csv', 'ods',
  'pptx', 'pptm', 'potx', 'ppsx', 'ppsm', 'odp',
  'pdf', 'ofd',
  'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml',
  'gif', 'jpg', 'jpeg', 'bmp', 'tiff', 'tif', 'png', 'svg', 'webp', 'ico', 'heic',
])

export const reportGeneratedFilesTool: ToolDefinition = {
  id: 'report_generated_files',
  name: 'report_generated_files',
  title: '展示生成文件',
  summary: '任务中创建或修改了用户关心的成品文档时，调用此工具声明文件路径，前端会在消息下方展示可预览卡片。',
  description: `声明本次任务中要让用户看到的成品文件（如 Word/Excel/PPT/PDF/图片等）。
创建或修改此类文档后，在最终回复前调用一次，传入所有成品文件的绝对路径。
仅声明用户能直接消费的成品，不要声明临时文件、配置、脚本、中间产物。
路径需为绝对路径；不存在或扩展名不在白名单的路径会被静默过滤。`,
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: '成品文件绝对路径列表',
        items: { type: 'string' },
      },
    },
    required: ['files'],
  },
  handler: async (args: any) => {
    const input = Array.isArray(args?.files) ? args.files : []
    if (input.length === 0) {
      return { success: false, error: '参数 files 不能为空' }
    }
    const workspacePath = getWorkspacePath() || process.cwd()
    const generatedFiles: Array<{ path: string; name: string; ext: string; size: number; mtime: number }> = []
    const skipped: string[] = []
    for (const raw of input) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      let resolved: string
      try {
        resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspacePath, raw)
      } catch {
        skipped.push(raw)
        continue
      }
      try {
        if (!fs.existsSync(resolved)) { skipped.push(resolved); continue }
        const stat = fs.statSync(resolved)
        if (!stat.isFile()) { skipped.push(resolved); continue }
        const ext = path.extname(resolved).slice(1).toLowerCase()
        if (!PREVIEWABLE_EXTS.has(ext)) { skipped.push(resolved); continue }
        generatedFiles.push({
          path: resolved,
          name: path.basename(resolved),
          ext,
          size: stat.size,
          mtime: stat.mtimeMs,
        })
      } catch { /* 忽略单个文件检查失败 */ }
    }
    const parts: string[] = [`[report_generated_files] 已声明 ${generatedFiles.length} 个成品文件`]
    if (generatedFiles.length > 0) {
      for (const f of generatedFiles) parts.push(`  ✓ ${f.path}`)
    }
    if (skipped.length > 0) {
      parts.push(`已过滤（不存在/非文件/扩展名不在白名单）${skipped.length} 个：`)
      for (const p of skipped) parts.push(`  ✗ ${p}`)
    }
    return {
      success: true,
      output: parts.join('\n'),
      generatedFiles,
    }
  },
  source: 'builtin',
  permission: 'safe',
  noRetry: true,
}

/** 常驻文件工具：读/写/编辑/成品声明，对话全程加入 LLM tools 数组 */
export const residentFileTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  reportGeneratedFilesTool,
]

// ====== 按需工具 ======

// ====== file_mkdir：创建文件夹 ======

export const fileMkdirTool: ToolDefinition = {
  id: 'file_mkdir',
  name: 'file_mkdir',
  title: '创建文件夹',
  summary: '创建文件夹（-p 语义，自动建父目录）。路径已存在时报错。',
  description: '创建文件夹，自动建父目录（-p 语义）。路径已存在时报错。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件夹绝对路径' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      return createFolder(args)
    } catch (error: any) {
      return { success: false, error: `创建文件夹失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_list：列出目录内容 ======

export const fileListTool: ToolDefinition = {
  id: 'file_list',
  name: 'file_list',
  title: '列出目录',
  summary: '列出目录内容。recursive 递归子目录，max_entries 上限默认200。',
  description: '列出目录内容。recursive=true 递归子目录；max_entries 限制返回条目数（默认200，上限1000）。自动过滤 .git/node_modules 等忽略目录。按文件夹优先、名称排序。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标目录绝对路径' },
      recursive: { type: 'boolean', description: '是否递归子目录（默认false）' },
      max_entries: { type: 'number', description: '最大返回条目数（默认200，上限1000）', minimum: 1, maximum: 1000 },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      return await listDir(args)
    } catch (error: any) {
      return { success: false, error: `列出目录失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
}

// ====== file_search：按通配符搜索文件名 ======

export const fileSearchTool: ToolDefinition = {
  id: 'file_search',
  name: 'file_search',
  title: '搜索文件',
  summary: '按通配符（* 与 ?）搜索目录下的文件名，如 *.txt。',
  description: '按通配符模式搜索目录下的文件名。pattern 支持 * 与 ?（如 *.txt、report-?.md）。递归搜索子目录，自动过滤 .git/node_modules 等忽略目录。max_results 限制结果数（默认50，上限200）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '搜索根目录绝对路径' },
      pattern: { type: 'string', description: '文件名匹配模式，支持通配符 * 与 ?（如 *.txt）' },
      max_results: { type: 'number', description: '最大返回结果数（默认50，上限200）', minimum: 1, maximum: 200 },
    },
    required: ['path', 'pattern'],
  },
  handler: async (args: any) => {
    try {
      return await searchFiles(args)
    } catch (error: any) {
      return { success: false, error: `文件搜索失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
}

// ====== file_delete：删除（移至回收站） ======

export const fileDeleteTool: ToolDefinition = {
  id: 'file_delete',
  name: 'file_delete',
  title: '删除文件',
  summary: '删除文件/文件夹，移至系统回收站可找回。需用户确认。',
  description: '删除文件或文件夹，移至系统回收站（基于 shell.trashItem），可从回收站找回。回收站不可用时回退永久删除。需用户确认（高权限模式跳过）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标路径绝对路径' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      return deleteItem(args)
    } catch (error: any) {
      return { success: false, error: `文件删除失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_move：移动 ======

export const fileMoveTool: ToolDefinition = {
  id: 'file_move',
  name: 'file_move',
  title: '移动文件',
  summary: '移动文件/文件夹到目标路径（含文件名）。目标已存在报错。',
  description: '移动文件或文件夹。source 为源路径，destination 为目标绝对路径（含文件名）。目标路径已存在时报错。自动建目标父目录。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源路径绝对路径' },
      destination: { type: 'string', description: '目标绝对路径（含文件名）' },
    },
    required: ['source', 'destination'],
  },
  handler: async (args: any) => {
    try {
      return moveItem(args)
    } catch (error: any) {
      return { success: false, error: `文件移动失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_copy：复制 ======

export const fileCopyTool: ToolDefinition = {
  id: 'file_copy',
  name: 'file_copy',
  title: '复制文件',
  summary: '复制文件/文件夹到目标路径（-r 语义）。目标已存在报错。',
  description: '复制文件或文件夹。source 为源路径，destination 为目标绝对路径（含文件名）。文件夹递归复制。目标路径已存在时报错。自动建目标父目录。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '源路径绝对路径' },
      destination: { type: 'string', description: '目标绝对路径（含文件名）' },
    },
    required: ['source', 'destination'],
  },
  handler: async (args: any) => {
    try {
      return copyItem(args)
    } catch (error: any) {
      return { success: false, error: `文件复制失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_rename：重命名 ======

export const fileRenameTool: ToolDefinition = {
  id: 'file_rename',
  name: 'file_rename',
  title: '重命名文件',
  summary: '重命名文件/文件夹。new_name 仅文件名不含路径分隔符。',
  description: '重命名文件或文件夹，保持原位置不变。new_name 仅文件名，不能包含路径分隔符或上级引用（..）。目标名称已存在时报错。工作区外操作需确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标路径绝对路径' },
      new_name: { type: 'string', description: '新名称，仅文件名不含路径分隔符' },
    },
    required: ['path', 'new_name'],
  },
  handler: async (args: any) => {
    try {
      return renameItem(args)
    } catch (error: any) {
      return { success: false, error: `文件重命名失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_stat：查看文件/目录信息 ======

export const fileStatTool: ToolDefinition = {
  id: 'file_stat',
  name: 'file_stat',
  title: '文件信息',
  summary: '查看文件/目录信息：大小、类型、修改时间、创建时间、权限。',
  description: '查看文件或目录信息，包括：路径、类型（file/directory）、大小（人类可读+字节数）、修改时间、创建时间、权限（八进制）、扩展名（文件）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标路径绝对路径' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      return getFileInfo(args)
    } catch (error: any) {
      return { success: false, error: `获取文件信息失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: true,
}

/** 按需文件工具：通过 list_available_tools + invoke_tool 发现和调用 */
export const onDemandFileTools: ToolDefinition[] = [
  fileMkdirTool,
  fileListTool,
  fileSearchTool,
  fileDeleteTool,
  fileMoveTool,
  fileCopyTool,
  fileRenameTool,
  fileStatTool,
]

/** 全部文件工具（常驻 + 按需），供 allBuiltinTools 聚合使用 */
export const fileTools: ToolDefinition[] = [...residentFileTools, ...onDemandFileTools]

// ====== 各操作实现 ======

async function listDir(args: any) {
  const dirPath = String(args.path || '').trim()
  if (!dirPath) return { success: false, error: '目录路径不能为空' }

  const resolved = path.resolve(dirPath)
  let rootStats: fs.Stats
  try {
    rootStats = await fs.promises.stat(resolved)
  } catch {
    return { success: false, error: `目录不存在: ${dirPath}` }
  }
  if (!rootStats.isDirectory()) return { success: false, error: `路径不是目录: ${dirPath}` }

  const recursive = args.recursive === true
  const maxEntries = Math.min(Math.max(args.max_entries || 200, 1), 1000)
  const items: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: string }> = []
  let total = 0
  let truncated = false
  let yieldCounter = 0
  const yieldEvery = 20

  const walk = async (current: string, prefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch { return }
    entries = entries
      .filter(e => !ignoreDirs.has(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))

    for (const entry of entries) {
      if (total >= maxEntries) { truncated = true; break }
      total++
      const fullPath = path.join(current, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        items.push({ name: entry.name, path: relativePath, type: 'dir' })
        if (recursive) {
          await walk(fullPath, relativePath)
          if (truncated) break
        }
      } else {
        try {
          const stats = await fs.promises.stat(fullPath)
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
      yieldCounter++
      if (yieldCounter >= yieldEvery) {
        yieldCounter = 0
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }

  await walk(resolved, '')

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
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(resolved)
  } catch {
    return { success: false, error: `文件不存在: ${filePath}` }
  }
  if (!stat.isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

  const offset = Math.max(0, args.offset || 0)
  const maxLength = Math.min(Math.max(args.max_length || DEFAULT_MAX_LENGTH, 1), MAX_LENGTH_LIMIT)
  const enableParse = args.parse === true
  const ext = path.extname(resolved).toLowerCase().slice(1)

  // 大文件保护：超过 50MB 拒绝全量读取（parse 模式由 file-parser 自身控制），防止 OOM 崩溃
  const MAX_FILE_SIZE = 50 * 1024 * 1024
  if (stat.size > MAX_FILE_SIZE && !enableParse) {
    return { success: false, error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制。请使用 offset/max_length 分段读取，或使用专用工具处理大文件` }
  }

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

  const content = (await fs.promises.readFile(resolved, 'utf-8')).replace(/\r\n/g, '\n')
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

async function searchFiles(args: any) {
  const dirPath = String(args.path || '').trim()
  const pattern = String(args.pattern || '').trim()
  if (!dirPath) return { success: false, error: '目录路径不能为空' }
  if (!pattern) return { success: false, error: '搜索模式不能为空' }

  const resolved = path.resolve(dirPath)
  let rootStats: fs.Stats
  try {
    rootStats = await fs.promises.stat(resolved)
  } catch {
    return { success: false, error: `目录不存在: ${dirPath}` }
  }
  if (!rootStats.isDirectory()) return { success: false, error: `路径不是目录: ${dirPath}` }

  const maxResults = Math.min(Math.max(args.max_results || 50, 1), 200)

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const regex = new RegExp(`^${regexStr}$`, 'i')

  const results: string[] = []
  let yieldCounter = 0
  const yieldEvery = 20

  const walk = async (current: string) => {
    if (results.length >= maxResults) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true })
    } catch { return }

    for (const entry of entries) {
      if (results.length >= maxResults) break
      if (ignoreDirs.has(entry.name)) continue

      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else {
        if (regex.test(entry.name)) {
          const relativePath = path.relative(resolved, fullPath).replace(/\\/g, '/')
          try {
            const stat = await fs.promises.stat(fullPath)
            results.push(`📄 ${relativePath} (${formatFileSize(stat.size)})`)
          } catch {
            results.push(`📄 ${relativePath}`)
          }
        }
      }
      yieldCounter++
      if (yieldCounter >= yieldEvery) {
        yieldCounter = 0
        await new Promise(resolve => setImmediate(resolve))
      }
    }
  }

  await walk(resolved)

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
