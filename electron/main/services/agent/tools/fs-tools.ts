import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import UnifiedInteractionService, { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import DatabaseService from '../../database.service'

/**
 * 文件操作工具（已简化，仅保留核心读写编辑与成品声明）：
 *
 * 常驻工具（加入 LLM tools 数组，对话全程不变）：
 *   file_read   读取文件内容
 *   file_write  写入文件（覆盖/追加）
 *   file_edit   编辑文件部分内容（replace/insert/delete 三种模式）
 *   report_generated_files  声明需要展示给用户的成品文件
 *
 * 说明：创建/删除/移动/复制/重命名/列目录/搜索/查看信息等文件操作
 * 已移除，统一由 shell_exec 覆盖。
 */

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
    // 通用对话（无 DB 会话记录）直接使用注入的任务工作区
    if (ctx.workspacePath) return ctx.workspacePath
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

// ====== 各操作实现 ======

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
