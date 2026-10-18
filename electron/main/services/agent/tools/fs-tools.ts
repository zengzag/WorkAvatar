import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'
import FilePermissionService from '../../file-permission.service'
import FileSnapshotService, { MAX_SNAPSHOT_FILE_BYTES, type FileChangeKind } from '../../file-snapshot.service'
import { moveToTrash } from '../../common-utils'
import { isFsRoot, isWithinPath, normalizePath } from '../../path-normalize'
import { buildUnifiedDiff } from './text-diff'
import { expandGlobPattern, isGlobPattern } from './glob-engine'
import { isIrreversibleTool } from './tool-permission'
import type { DiffDisclosure } from '../../../../shared/types'

/**
 * 文件操作工具（仅保留核心读写编辑与成品声明/删除）：
 *
 * 常驻工具（加入 LLM tools 数组，对话全程不变）：
 *   file_read    读取文件内容
 *   file_write   写入文件（覆盖/追加）
 *   file_edit    编辑文件部分内容（replace/insert/delete 三种模式）
 *   file_delete  删除文件/目录（移入回收站）
 *   report_generated_files  声明需要展示给用户的成品文件
 *
 * 说明：列目录与按内容/通配检索由编程工具 file_list / grep 提供（见 file-list.tool.ts、grep.tool.ts）；
 * 创建/移动/复制/重命名/查看信息等其余文件操作仍由 shell_exec 覆盖。
 * 删除是唯一例外——shell_exec / javascript_exec 中的删除一律被拒绝，必须走 file_delete
 * （路径可静态判定、移入回收站可恢复、操作可审计）。
 *
 * 工作区边界判定、授权缓存与区外确认统一由 FilePermissionService 负责。
 */

const filePermission = FilePermissionService.getInstance()

/** 当前任务的有效工作区目录：优先任务独立目录，旧对话（无任务目录）回退到员工工作区 */
export function getWorkspacePath(): string | null {
  return filePermission.getWorkspacePath()
}

/** 解析工具入参路径：绝对路径原样；相对路径按工作区解析（无工作区时回退主进程 cwd），不落到应用目录 */
export function resolveToolPath(raw: string): string {
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(getWorkspacePath() || process.cwd(), raw)
}

const PARSABLE_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx',
  'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'
])

const DEFAULT_MAX_LENGTH = 5000
const MAX_LENGTH_LIMIT = 50000

// ====== 常驻工具 ======

// ====== 改动快照与 diff 预览（file_write / file_edit / file_delete 共用） ======

const fileSnapshot = FileSnapshotService.getInstance()

/** 读取文件改动前状态：内容超上限/二进制/非 UTF-8 时只登记存在性（不可还原），避免回滚损坏原文件 */
export function readFileState(filePath: string): { exists: boolean; content: string; restorable: boolean } {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { exists: true, content: '', restorable: false }
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) return { exists: true, content: '', restorable: false }
    const buf = fs.readFileSync(filePath)
    // NUL 字节 → 二进制文件；无效 UTF-8（如 GBK）→ 无法无损还原，均不做快照内容记录
    if (buf.includes(0)) return { exists: true, content: '', restorable: false }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { exists: true, content: text, restorable: true }
    } catch {
      return { exists: true, content: '', restorable: false }
    }
  } catch {
    return { exists: false, content: '', restorable: true }
  }
}

/** 授权通过后登记快照（被拒绝的操作不产生回滚记录） */
export function recordSnapshot(
  toolName: string,
  changeKind: FileChangeKind,
  filePath: string,
  before: { exists: boolean; content: string; restorable: boolean },
): void {
  fileSnapshot.recordChange({
    toolName,
    changeKind,
    path: filePath,
    existed: before.exists,
    beforeContent: before.restorable ? before.content : null,
    restorable: before.restorable,
  })
}

/** 工具结果中的 diff 展示块（无改动时返回空串；截断提示由 buildUnifiedDiff 内嵌，不重复追加） */
export function diffSuffix(diff: DiffDisclosure): string {
  if (!diff.content) return ''
  return `\n\n\`\`\`diff\n${diff.content}\n\`\`\``
}

/**
 * 读取可编辑的 UTF-8 文本文件（file_edit / apply_patch 共用）。
 * 二进制与非 UTF-8（如 GBK）显式拒绝——写回会静默损坏原文件。
 */
export function readEditableText(
  filePath: string,
  resolved: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!fs.existsSync(resolved)) return { ok: false, error: `文件不存在: ${filePath}` }
  if (!fs.statSync(resolved).isFile()) return { ok: false, error: `路径不是文件: ${filePath}` }
  const buf = fs.readFileSync(resolved)
  if (buf.includes(0)) return { ok: false, error: `文件是二进制文件，无法进行文本编辑: ${filePath}` }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return { ok: true, content: text.replace(/\r\n/g, '\n') }
  } catch {
    return { ok: false, error: `文件不是有效的 UTF-8 文本，无法进行文本编辑（请用 shell 命令处理编码转换后重试）: ${filePath}` }
  }
}

// ====== file_read：读取文件内容 ======

export const fileReadTool: ToolDefinition = {
  id: 'file_read',
  name: 'file_read',
  title: '读取文件',
  description: `Read a local file. Text files are returned as-is, line-numbered by default; page through large files with offset/max_length. Set parse=true to extract text from PDF/DOCX/XLSX/PPTX or run OCR on an image instead of reading raw bytes.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute file path' },
      offset: { type: 'number', description: 'Start character offset (default 0)', minimum: 0 },
      max_length: { type: 'number', description: `Max characters to return (default ${DEFAULT_MAX_LENGTH}, max ${MAX_LENGTH_LIMIT})`, minimum: 1, maximum: MAX_LENGTH_LIMIT },
      parse: { type: 'boolean', description: 'Extract text from PDF/DOCX/XLSX/PPTX/images (default false)' },
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

// ====== file_edit：编辑文件部分内容（replace/insert/delete） ======

export const fileEditTool: ToolDefinition = {
  id: 'file_edit',
  name: 'file_edit',
  title: '编辑文件',
  summary: '对文件部分内容做精确修改（替换/插入/删除），避免全量重写。replace 精确字符串替换；insert 按行号或锚点插入；delete 按行范围或锚点删除。',
  description: `Make a targeted change to an existing file instead of rewriting it whole.

replace needs old_string to match the file exactly and uniquely — add surrounding context, or set replace_all=true. insert and delete locate their target by an anchor string or by line number.

The file must already exist: use file_write to create it, or apply_patch to change several files in one step.`,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: 'replace / insert / delete',
      },
      path: { type: 'string', description: 'Absolute file path (must already exist)' },
      old_string: { type: 'string', description: 'replace/delete: exact text to find; must match uniquely unless replace_all=true' },
      new_string: { type: 'string', description: 'replace: replacement text (empty string deletes the match)' },
      replace_all: { type: 'boolean', description: 'replace: replace every occurrence (default false)' },
      content: { type: 'string', description: 'insert: content to insert' },
      after_string: { type: 'string', description: 'insert: insert right after this string (takes precedence over line)' },
      line: { type: 'number', description: 'insert: insert before this line (1-based; 0 or omitted appends at end)', minimum: 0 },
      start_line: { type: 'number', description: 'delete: first line to remove (1-based, inclusive)', minimum: 1 },
      end_line: { type: 'number', description: 'delete: last line to remove (1-based, inclusive)', minimum: 1 },
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
  summary: '删除文件或文件夹（移入回收站，可恢复），支持一次传多个路径与 * ? ** 通配符批量删除。删除一律使用本工具，禁止用 shell 命令或脚本删除。',
  description: `Delete files or directories by moving them to the system trash (recoverable).

- path or paths: several targets may be passed at once; each may contain the wildcards * ? ** and every real match is deleted.
- recursive=true is required to delete a non-empty directory; without it you get an error rather than a silent delete.
- Drive roots, filesystem roots, and the workspace root (or any ancestor of it) are refused.
- Deletion must always go through file_delete: rm / del / Remove-Item and script-based deletion are rejected by policy.
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
  description: `Declare the deliverable files this task produced (Word / Excel / PowerPoint / PDF / images) so the user gets preview cards.

Call it once before your final reply, passing the absolute path of every deliverable. Declare only what the user will consume — not temporary files, configs, scripts or intermediate artifacts. Paths that do not exist, are not files, or have an extension outside the preview whitelist are silently dropped.`,
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

/** 常驻文件工具：读/写/编辑/删除/成品声明，对话全程加入 LLM tools 数组 */
export const residentFileTools: ToolDefinition[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
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

    // 空文件直接返回，避免「偏移量 0 超出文件总字符数 0」的误导性报错
    if (totalChars === 0) {
      return { success: true, output: '(文件为空 — 0 字符)' }
    }

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

  // 空文件直接返回，避免「偏移量 0 超出文件总字符数 0」的误导性报错
  if (totalChars === 0) {
    return { success: true, output: '(文件为空 — 0 字符)' }
  }

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
  // 写盘成功后登记快照（写失败时不产生"从未发生"的回滚记录）
  recordSnapshot('file_write', append ? 'append' : 'write', resolved, before)

  const mode = append ? '追加' : '写入'
  return { success: true, output: `成功${mode} ${resolved}，共 ${content.length} 字符${diffSuffix(diff)}` }
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

  // 删除前读取改动前状态（目录不可还原，仅登记路径供展示），删除成功后登记快照
  const beforeStates = new Map(deletable.map(t => [t.resolved, t.isDir ? null : readFileState(t.resolved)]))

  const results: string[] = []
  const failures: string[] = []
  for (const t of deletable) {
    try {
      const via = await moveToTrash(t.resolved)
      if (t.isDir) {
        fileSnapshot.recordChange({
          toolName: 'file_delete', changeKind: 'delete', path: t.resolved, existed: true, beforeContent: null, restorable: false,
        })
      } else {
        recordSnapshot('file_delete', 'delete', t.resolved, beforeStates.get(t.resolved)!)
      }
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

// ====== file_edit 各操作实现 ======

/** 读取目标文件内容并校验，返回 { content, resolved } 或错误对象（授权在计算改动后统一进行） */
async function loadEditTarget(args: any): Promise<{ content: string; resolved: string } | { success: false; error: string }> {
  const filePath = String(args.path || '').trim()
  if (!filePath) return { success: false, error: '文件路径不能为空' }

  const resolved = resolveToolPath(filePath)
  if (!fs.existsSync(resolved)) return { success: false, error: `文件不存在: ${filePath}（file_edit 不会创建文件，请用 file_write 创建）` }

  const read = readEditableText(filePath, resolved)
  if (!read.ok) return { success: false, error: read.error }
  return { content: read.content, resolved }
}

/**
 * 编辑收尾：按改动生成 diff → 权限确认（弹窗内展示 diff）→ 落盘 → 登记快照。
 * 授权发生在计算改动之后，使确认弹窗能展示真实 diff。
 */
async function commitEdit(
  resolved: string,
  before: string,
  after: string,
): Promise<{ ok: true; diff: DiffDisclosure } | { ok: false; error: string }> {
  const diff = buildUnifiedDiff(before, after)
  const confirm = await filePermission.authorizeFileOperation('编辑', [resolved], { diff })
  if (!confirm.allowed) return { ok: false, error: confirm.error || '编辑操作已取消' }

  fs.writeFileSync(resolved, after, 'utf-8')
  // 写盘成功后登记快照（写失败时不产生"从未发生"的回滚记录）；按字节而非字符数判断上限
  const restorable = Buffer.byteLength(before, 'utf-8') <= MAX_SNAPSHOT_FILE_BYTES
  fileSnapshot.recordChange({
    toolName: 'file_edit',
    changeKind: 'edit',
    path: resolved,
    existed: true,
    beforeContent: restorable ? before : null,
    restorable,
  })
  return { ok: true, diff }
}

/** replace: 精确字符串替换 */
async function editReplace(args: any) {
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  if (!oldString) return { success: false, error: 'old_string 不能为空' }
  if (oldString === newString) return { success: false, error: 'old_string 与 new_string 相同，无需替换' }

  const target = await loadEditTarget(args)
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

  const commit = await commitEdit(target.resolved, target.content, newContent)
  if (!commit.ok) return { success: false, error: commit.error }

  const count = replaceAll ? occurrences : 1
  return {
    success: true,
    output: `✓ replace: 替换 ${count} 处（${oldString.length} 字符 → ${newString.length} 字符）\n文件: ${target.resolved}${diffSuffix(commit.diff)}`,
  }
}

/** insert: 插入内容 */
async function editInsert(args: any) {
  const content = String(args.content ?? '')
  if (!content) return { success: false, error: 'content 不能为空' }

  const target = await loadEditTarget(args)
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

  const commit = await commitEdit(target.resolved, target.content, newContent)
  if (!commit.ok) return { success: false, error: commit.error }

  const insertLines = content.split('\n').length
  return {
    success: true,
    output: `✓ insert: ${positionDesc}插入 ${insertLines} 行内容\n文件: ${target.resolved}${diffSuffix(commit.diff)}`,
  }
}

/** delete: 删除内容 */
async function editDelete(args: any) {
  const target = await loadEditTarget(args)
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

  const commit = await commitEdit(target.resolved, target.content, newContent)
  if (!commit.ok) return { success: false, error: commit.error }

  return {
    success: true,
    output: `✓ delete: ${desc}\n文件: ${target.resolved}${diffSuffix(commit.diff)}`,
  }
}
