import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'
import FilePermissionService from '../../file-permission.service'
import { moveToTrash } from '../../common-utils'
import { isFsRoot, isWithinPath, normalizePath } from '../../path-normalize'
import { buildUnifiedDiff } from './text-diff'
import { expandGlobPattern, isGlobPattern } from './glob-engine'
import { isIrreversibleTool } from './tool-permission'
import { getWorkspacePath, readFileState, resolveToolPath } from './fs-shared'
import { filesEditTool } from './files-edit.tool'

/**
 * 文件操作工具（核心读写与成品声明/复制/删除）：
 *
 * 常驻工具（加入 LLM tools 数组，对话全程不变）：
 *   file_read    读取文件内容
 *   file_write   写入文件（覆盖/追加）
 *   files_edit   精确修改单个或多个文件（替换/整文件写入，合并为一次确认）
 *   file_copy    复制文件/目录（可复制到工作区外，需授权）
 *   file_delete  删除文件/目录（移入回收站）
 *   report_generated_files  声明需要展示给用户的成品文件
 *
 * 说明：列目录与按内容/通配检索由编程工具 file_list / grep 提供（见 file-list.tool.ts、grep.tool.ts）；
 * 创建/移动/重命名/查看信息等其余文件操作仍由 shell_exec 覆盖。
 * 删除是唯一例外——shell_exec 中的删除一律被拒绝，必须走 file_delete
 * （路径可静态判定、移入回收站可恢复、操作可审计）。
 *
 * 工作区边界判定、授权缓存与区外确认统一由 FilePermissionService 负责；
 * 路径解析与文本状态读取等共用能力见 fs-shared.ts。
 */

const filePermission = FilePermissionService.getInstance()

const PARSABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

const DEFAULT_LINE_LIMIT = 800
const MAX_LINE_LIMIT = 5000
/** 单行输出上限：压缩后的 JS / 单行 JSON 不占满整页 */
const MAX_LINE_CHARS = 2000
/** 单页输出字节上限：超出后停在整行边界，并提示用 offset 续读 */
const MAX_PAGE_BYTES = 50 * 1024
/** 超过该大小的文件拒绝整读（行窗口仍需扫全文件统计总行数） */
const MAX_FILE_SIZE = 50 * 1024 * 1024

// ====== 常驻工具 ======

// ====== file_read：读取文件内容 ======

export const fileReadTool: ToolDefinition = {
  id: 'file_read',
  name: 'file_read',
  title: '读取文件',
  description: `Read a local file. Text files are paginated by line: offset is the 1-based first line and limit is the number of lines. Each line is cut after ${MAX_LINE_CHARS} characters and one page stops at ${MAX_PAGE_BYTES / 1024}KB. Set parse=true to extract text from PDF/DOCX/XLSX/PPTX instead of reading raw bytes; for text inside an image use ocr_image.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
      offset: { type: 'number', description: '1-based first line to return (default 1)', minimum: 1 },
      limit: { type: 'number', description: `Max lines to return (default ${DEFAULT_LINE_LIMIT}, max ${MAX_LINE_LIMIT})`, minimum: 1, maximum: MAX_LINE_LIMIT },
      parse: { type: 'boolean', description: 'Extract text from PDF/DOCX/XLSX/PPTX (default false)' },
      show_line_numbers: { type: 'boolean', description: 'Prefix each line with its number (default true)' },
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
  permission: 'safe',
}

// ====== file_write：写入文件（覆盖/追加） ======

export const fileWriteTool: ToolDefinition = {
  id: 'file_write',
  name: 'file_write',
  title: '写入文件',
  description: 'Write a file, creating parent directories as needed. Overwrites by default; append=true appends to the end. Writes outside the workspace need user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path' },
      content: { type: 'string', description: 'File content' },
      append: { type: 'boolean', description: 'Append instead of overwrite (default false)' },
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
  permission: 'requires_confirmation',
  selfAuthorized: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_delete：删除文件/目录（移入回收站，支持批量与通配符） ======

export const fileDeleteTool: ToolDefinition = {
  id: 'file_delete',
  name: 'file_delete',
  title: '删除文件/文件夹',
  summary: '删除文件或文件夹（移入回收站，可恢复），支持一次传多个路径与 * ? ** 通配符批量删除。',
  description: `Delete files or directories by moving them to the system trash (recoverable).

- path or paths: several targets may be passed at once; each may contain the wildcards * ? ** and every real match is deleted.
- recursive=true is required to delete a non-empty directory; without it you get an error rather than a silent delete.
- Drive roots, filesystem roots, and the workspace root (or any ancestor of it) are refused.
- Targets outside the workspace need confirmation. Deletion is irreversible, so the confirmation cannot be covered by "always allow".`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to delete (absolute path, or relative to the workspace). Provide this or paths' },
      paths: {
        type: 'array',
        description: 'Targets to delete; plain paths and wildcard patterns (* ? **) may be mixed. Relative paths resolve against the workspace',
        items: { type: 'string' },
      },
      recursive: { type: 'boolean', description: 'Delete the contents of a directory as well (default false)' },
    },
    required: [],
  },
  handler: async (args: any) => {
    try {
      return await deleteFile(args)
    } catch (error: any) {
      return { success: false, error: `删除失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  // 不可逆（isIrreversibleTool）：确认不可被"始终允许/本轮不再提醒"绕过，由 FilePermissionService 强制
  permission: 'requires_confirmation',
  selfAuthorized: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}

// ====== file_copy：复制文件/目录（可复制到工作区外，需授权） ======

export const fileCopyTool: ToolDefinition = {
  id: 'file_copy',
  name: 'file_copy',
  title: '复制文件/文件夹',
  summary: '复制文件或目录到目标位置（目录递归复制）。用于把工作区里的成品交付到用户指定目录（工作区外会弹一次授权）。',
  description: `Copy a file or a directory to a destination — use it to deliver a finished artifact from the workspace to the user's folder.

- source / destination: absolute, or relative to the workspace.
- source may be a file or a directory; directories are copied recursively.
- If destination is an existing directory, the source is copied into it keeping its own name.
- overwrite=true replaces an existing target (an existing directory is moved to the trash first); default false reports the conflict instead.
- The destination may be outside the workspace: the user is asked once and can allow the whole folder for later copies.
- A directory cannot be copied into itself or one of its subdirectories.`,
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'File or directory to copy (absolute path, or relative to the workspace)' },
      destination: { type: 'string', description: 'Target path, or an existing directory to copy into (absolute, or relative to the workspace)' },
      overwrite: { type: 'boolean', description: 'Replace the target when it already exists (default false)' },
    },
    required: ['source', 'destination'],
  },
  handler: async (args: any) => {
    try {
      return await copyFile(args)
    } catch (error: any) {
      return { success: false, error: `复制失败: ${error.message || error}` }
    }
  },
  source: 'builtin',
  permission: 'requires_confirmation',
  selfAuthorized: true,
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
  summary: '声明本次任务的成品文件路径，前端会在消息下方展示可预览卡片。',
  description: `Declare the deliverable files this task produced (Word / Excel / PowerPoint / PDF / images) so the user gets preview cards.

Paths that do not exist, are not files, or have an extension outside the preview whitelist are silently dropped.`,
  parameters: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        description: 'Absolute paths of the deliverable files',
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
    const generatedFiles: Array<{ path: string; name: string; ext: string; size: number; mtime: number }> = []
    const skipped: string[] = []
    for (const raw of input) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      let resolved: string
      try {
        resolved = resolveToolPath(raw)
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

/** 常驻文件工具：读取/写入/精确修改/复制/删除/成品声明，对话全程加入 LLM tools 数组 */
export const residentFileTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  filesEditTool,
  fileCopyTool,
  fileDeleteTool,
  reportGeneratedFilesTool,
]

// ====== 各操作实现 ======

async function readFile(args: any) {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = resolveToolPath(filePath)
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(resolved)
  } catch {
    return { success: false, error: `文件不存在: ${filePath}` }
  }
  if (!stat.isFile()) return { success: false, error: `路径不是文件: ${filePath}` }

  const offset = Math.max(1, Math.floor(Number(args.offset) || 1))
  const limit = Math.min(Math.max(Math.floor(Number(args.limit) || DEFAULT_LINE_LIMIT), 1), MAX_LINE_LIMIT)
  const showLineNumbers = args.show_line_numbers !== false
  const enableParse = args.parse === true
  const ext = path.extname(resolved).toLowerCase().slice(1)

  // 大文件保护：行窗口仍需扫全文件统计总行数，超过 50MB 拒绝（parse 模式由 file-parser 自身控制）
  if (stat.size > MAX_FILE_SIZE && !enableParse) {
    return { success: false, error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_FILE_SIZE / 1024 / 1024}MB 限制。请使用 offset/limit 分段读取，或使用专用工具处理大文件` }
  }

  let chunks: AsyncIterable<string> | Iterable<string>
  if (enableParse && PARSABLE_EXTENSIONS.has(ext)) {
    const parser = require('../../file-parser.service').default.getInstance()
    const result = await parser.parseFilePath(resolved)
    chunks = [result.fullText]
  } else {
    // 流式读取：大文件不在内存里整份驻留
    chunks = fs.createReadStream(resolved, { encoding: 'utf-8' }) as unknown as AsyncIterable<string>
  }

  const window = await buildReadWindow(chunks, { offset, limit })

  // 空文件直接返回，避免「偏移量超出」的误导性报错
  if (window.totalLines === 0) {
    return { success: true, output: '(文件为空 — 0 行)' }
  }
  if (offset > window.totalLines) {
    return { success: false, error: `偏移量 ${offset} 超出文件总行数 ${window.totalLines}` }
  }

  const startLine = window.lines[0].number
  const endLine = window.lines[window.lines.length - 1].number
  let output = showLineNumbers
    ? window.lines.map(l => `${l.number}| ${l.text}`).join('\n')
    : window.lines.map(l => l.text).join('\n')

  if (window.truncatedByBytes) {
    output += `\n\n(输出已达上限，显示第 ${startLine}-${endLine} 行，共 ${window.totalLines} 行。使用 offset=${endLine + 1} 继续读取)`
  } else if (endLine < window.totalLines) {
    output += `\n\n(显示第 ${startLine}-${endLine} 行，共 ${window.totalLines} 行。使用 offset=${endLine + 1} 继续读取)`
  } else {
    output += `\n\n(文件结束 — 共 ${window.totalLines} 行)`
  }

  return { success: true, output }
}

interface ReadWindowLine {
  number: number
  text: string
}

interface ReadWindowResult {
  lines: ReadWindowLine[]
  totalLines: number
  /** 是否因单页字节上限提前停止收集（总行数仍完整统计） */
  truncatedByBytes: boolean
}

/**
 * 从流式文本块构建行窗口：按行计数、按行截断超长行、按字节上限停止收集；
 * 即使提前停止也继续扫描到文件末尾，保证片段外的 totalLines 准确。
 */
async function buildReadWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  opts: { offset: number; limit: number },
): Promise<ReadWindowResult> {
  const lines: ReadWindowLine[] = []
  let totalLines = 0
  let outputBytes = 0
  let truncatedByBytes = false
  // 多留一个字符即可判定超长，避免单行无限累积
  const lineBufferCap = MAX_LINE_CHARS + 1
  let lineBuffer = ''

  const pushLine = (rawLine: string): void => {
    totalLines++
    if (truncatedByBytes || totalLines < opts.offset || lines.length >= opts.limit) return

    const text = rawLine.length > MAX_LINE_CHARS
      ? `${rawLine.slice(0, MAX_LINE_CHARS)}... (该行超过 ${MAX_LINE_CHARS} 字符已截断)`
      : rawLine
    const bytes = Buffer.byteLength(text, 'utf8') + (lines.length > 0 ? 1 : 0)
    if (outputBytes + bytes > MAX_PAGE_BYTES) {
      truncatedByBytes = true
      return
    }
    outputBytes += bytes
    lines.push({ number: totalLines, text })
  }

  const appendToLineBuffer = (segment: string): void => {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  const flushLine = (): void => {
    pushLine(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let start = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', start)) !== -1) {
      appendToLineBuffer(chunk.slice(start, newlinePos))
      flushLine()
      start = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(start))
  }
  // 末行无换行符时补齐；以换行结尾的文件不会多出一行
  if (lineBuffer.length > 0) flushLine()

  return { lines, totalLines, truncatedByBytes }
}

async function writeFile(args: any) {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = resolveToolPath(filePath)
  const append = args.append === true
  const content = String(args.content || '')

  const before = readFileState(resolved)
  const after = append ? before.content + content : content
  const diff = buildUnifiedDiff(before.exists ? before.content : '', after)

  const confirm = await filePermission.authorizeFileOperation(append ? '追加' : '写入', [resolved], { diff })
  if (!confirm.allowed) return { success: false, error: confirm.error }

  const dir = path.dirname(resolved)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  if (append) {
    fs.appendFileSync(resolved, content, 'utf-8')
  } else {
    fs.writeFileSync(resolved, content, 'utf-8')
  }

  const mode = append ? '追加' : '写入'
  return { success: true, output: `成功${mode} ${resolved}，共 ${content.length} 字符` }
}

// ====== file_copy 实现 ======

async function copyFile(args: any) {
  const rawSource = String(args.source || '').trim()
  const rawDestination = String(args.destination || '').trim()
  if (!rawSource) return { success: false, error: 'source 不能为空' }
  if (!rawDestination) return { success: false, error: 'destination 不能为空' }

  const source = resolveToolPath(rawSource)
  if (!fs.existsSync(source)) return { success: false, error: `源路径不存在: ${source}` }
  const sourceStat = fs.statSync(source)
  const sourceIsDir = sourceStat.isDirectory()
  if (!sourceIsDir && !sourceStat.isFile()) {
    return { success: false, error: `源路径既不是文件也不是目录: ${source}` }
  }

  // 目标为已存在的目录时，按源名复制进去（文件或目录均适用）
  let destination = resolveToolPath(rawDestination)
  try {
    if (fs.existsSync(destination) && fs.statSync(destination).isDirectory()) {
      destination = path.join(destination, path.basename(source))
    }
  } catch { /* 目标不可访问时按字面路径处理 */ }

  const sourceNorm = normalizePath(source)
  const destinationNorm = normalizePath(destination)
  if (!sourceNorm || !destinationNorm) return { success: false, error: '路径无效' }
  if (sourceNorm === destinationNorm) return { success: false, error: '源与目标路径相同' }
  // 目录不能复制到自身或子目录内（cpSync 会递归到新目录，导致无限增长）
  if (sourceIsDir && isWithinPath(destinationNorm, sourceNorm)) {
    return { success: false, error: '不能把目录复制到其自身或子目录内' }
  }

  const overwrite = args.overwrite === true
  const targetExists = fs.existsSync(destination)
  if (!overwrite && targetExists) {
    return { success: false, error: `目标已存在: ${destination}（如需覆盖请传 overwrite=true）` }
  }

  const targetWasDir = targetExists && fs.statSync(destination).isDirectory()
  const confirm = await filePermission.authorizeFileOperation('复制到', [destination])
  if (!confirm.allowed) return { success: false, error: confirm.error }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (targetExists) {
    if (targetWasDir) {
      // 目录整体替换：旧目录移入回收站，再复制新目录
      await moveToTrash(destination)
    } else {
      fs.rmSync(destination, { force: true })
    }
  }

  if (sourceIsDir) {
    fs.cpSync(source, destination, { recursive: true, force: true })
  } else {
    fs.copyFileSync(source, destination)
  }

  if (sourceIsDir) {
    return { success: true, output: `已复制目录 ${source} → ${destination}` }
  }
  const size = sourceStat.size >= 1024
    ? `${(sourceStat.size / 1024).toFixed(1)} KB`
    : `${sourceStat.size} B`
  return { success: true, output: `已复制 ${source} → ${destination}（${size}）` }
}

// ====== file_delete 实现 ======

async function deleteFile(args: any) {
  // 兼容单个 path 与批量 paths 两种入参
  const inputs: string[] = []
  if (typeof args.path === 'string' && args.path.trim()) inputs.push(args.path.trim())
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string' && p.trim()) inputs.push(p.trim())
    }
  }
  if (inputs.length === 0) return { success: false, error: '文件路径不能为空（path 或 paths 至少提供一个）' }

  const recursive = args.recursive === true

  // 展开为待删目标集合：字面路径直接解析；通配路径按匹配到的真实路径展开
  const targetSet = new Set<string>()
  const unmatched: string[] = []
  for (const raw of inputs) {
    if (isGlobPattern(raw)) {
      const matched = expandGlobPattern(resolveToolPath(raw)).matches
      if (matched.length === 0) unmatched.push(raw)
      else for (const m of matched) targetSet.add(path.resolve(m))
    } else {
      targetSet.add(resolveToolPath(raw))
    }
  }

  // 逐目标安全校验，被拒目标记录原因、不删除
  const rejected: string[] = []
  const deletable: Array<{ resolved: string; isDir: boolean }> = []
  const workspaceNorm = normalizePath(getWorkspacePath() || process.cwd())
  for (const resolved of targetSet) {
    const norm = normalizePath(resolved)
    if (!norm) { rejected.push(`${resolved}（路径无效）`); continue }
    // 盘根等于整盘，工作区根（及其上级）会摧毁任务工作区，二者都属于"绝不允许"的删除目标
    if (isFsRoot(norm)) { rejected.push(`${resolved}（盘根/文件系统根目录禁止删除）`); continue }
    if (workspaceNorm && isWithinPath(workspaceNorm, norm)) {
      rejected.push(`${resolved}（工作区根目录或其上级目录禁止删除）`); continue
    }
    if (!fs.existsSync(resolved)) { rejected.push(`${resolved}（路径不存在）`); continue }
    const stat = fs.lstatSync(resolved)
    if (stat.isDirectory() && !recursive) {
      const count = fs.readdirSync(resolved).length
      rejected.push(count > 0
        ? `${resolved}（目录非空（${count} 项），需传 recursive=true）`
        : `${resolved}（目录删除需显式传 recursive=true）`)
      continue
    }
    deletable.push({ resolved, isDir: stat.isDirectory() })
  }

  if (deletable.length === 0) {
    const reasons = [
      unmatched.length > 0 ? `通配路径未匹配到任何文件: ${unmatched.join(', ')}` : '',
      ...rejected,
    ].filter(Boolean)
    return { success: false, error: reasons.length > 0 ? `没有可删除的目标:\n${reasons.join('\n')}` : '没有可删除的目标' }
  }

  // 权限判定使用展开后的全部真实绝对路径，一次确认批量授权。
  // 删除不可逆：传 irreversible 使确认不可被"始终允许 / 本轮不再提醒"绕过
  const confirm = await filePermission.authorizeFileOperation('删除', deletable.map(t => t.resolved), {
    irreversible: isIrreversibleTool(fileDeleteTool.id),
  })
  if (!confirm.allowed) return { success: false, error: confirm.error || '删除操作已取消' }

  const results: string[] = []
  const failures: string[] = []
  for (const t of deletable) {
    try {
      const via = await moveToTrash(t.resolved)
      const kind = t.isDir ? '目录' : '文件'
      results.push(via === 'trash'
        ? `✓ 已删除${kind}（移入回收站，可恢复）: ${t.resolved}`
        : `✓ 已删除${kind}（系统回收站不可用，已永久删除，不可恢复）: ${t.resolved}`)
    } catch (e: any) {
      failures.push(`✗ ${t.resolved}: ${e.message || e}`)
    }
  }

  const parts: string[] = [`共 ${deletable.length} 个目标，已删除 ${results.length} 个`]
  parts.push(...results)
  if (failures.length > 0) parts.push(...failures)
  if (unmatched.length > 0) parts.push(`未匹配到文件的通配路径: ${unmatched.join(', ')}`)
  if (rejected.length > 0) parts.push(`已跳过 ${rejected.length} 个:\n${rejected.map(r => `  ${r}`).join('\n')}`)

  return {
    success: results.length > 0,
    output: parts.join('\n'),
  }
}



