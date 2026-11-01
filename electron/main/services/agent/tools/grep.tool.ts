import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { expandGlobPattern, isIgnoredDirName } from './glob-engine'
import { getWorkspacePath, isUncreatedWorkspaceRoot, resolveToolPath } from './fs-shared'
import { relativeDisplayPath } from './utils'

const DEFAULT_MAX_RESULTS = 200
const MAX_RESULTS_LIMIT = 1000
/** 单文件体积上限：超过则跳过（避免读入超大文件拖垮检索） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 候选文件数上限：防止在巨大目录树上枚举失控 */
const MAX_CANDIDATE_FILES = 20000
/** 单行预览字节上限：压缩后的 JS / 单行 JSON 不应整段进入上下文 */
const MAX_LINE_PREVIEW_BYTES = 2000
/** 单次检索输出的总字节上限 */
const MAX_OUTPUT_BYTES = 256 * 1024

/** 按字节截断单行预览（保留 UTF-8 字符边界） */
function truncateLinePreview(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_LINE_PREVIEW_BYTES) return text
  let cut = Buffer.from(text, 'utf8').subarray(0, MAX_LINE_PREVIEW_BYTES).toString('utf-8')
  // 截断点可能落在多字节字符中间，去掉不完整的替换字符
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return `${cut}… (该行超过 ${MAX_LINE_PREVIEW_BYTES} 字节已截断)`
}

interface GrepLine {
  lineNo: number
  text: string
  match: boolean
}

/** 按内容/正则检索文件（跨文件定位符号与字符串） */
export const grepTool: ToolDefinition = {
  id: 'grep',
  name: 'grep',
  title: '内容检索',
  summary: 'Search file contents by regular expression and return path:line matches for symbols, strings, and config keys.',
  description: `Search file contents by regular expression and return "path:line: content". Use this tool instead of shell grep / rg / Select-String for content search.

- pattern: regular expression (required). Escape special characters for literal matches (e.g. "\\.json", "getUser\\(").
- path: search root or a single file (default: current workspace).
- glob: optional file filter (* ? [abc], **, e.g. "**/*.ts"); by default all text files are searched.
- ignore_case: case-insensitive search (default false); context_lines: lines of context before and after each match (0-5, default 0, rendered as "path-line- content").
- Heavy directories (node_modules, .git, dist) are skipped, as are binary files and files over 2MB.
- A line preview is cut at 2000 bytes; output stops at 256KB. At most max_results matches are returned, with a truncation notice.`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Search root or a single file (absolute, or relative to the workspace). Default: current workspace' },
      glob: { type: 'string', description: 'Optional file filter (* ? [abc], **), resolved relative to path' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false)' },
      context_lines: { type: 'number', description: 'Lines of context around each match (0-5, default 0)', minimum: 0, maximum: 5 },
      max_results: { type: 'number', description: `Maximum matching lines to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_LIMIT})`, minimum: 1, maximum: MAX_RESULTS_LIMIT },
    },
    required: ['pattern'],
  },
  handler: async (args: any) => {
    try {
      return await grepFiles(args)
    } catch (error: any) {
      return { success: false, error: `内容检索失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
  permission: 'safe',
  onDemand: false,
}

async function grepFiles(args: any) {
  const pattern = String(args.pattern ?? '')
  if (!pattern) return { success: false, error: 'pattern 不能为空' }

  let re: RegExp
  try {
    re = new RegExp(pattern, args.ignore_case === true ? 'i' : '')
  } catch (error: any) {
    return { success: false, error: `正则表达式无效: ${error?.message || error}。若只想按字面量匹配，请对 \\. ( ) [ ] 等特殊字符转义` }
  }

  const rawPath = String(args.path || '').trim()
  const root = rawPath ? resolveToolPath(rawPath) : (getWorkspacePath() || process.cwd())
  const glob = String(args.glob || '').trim()
  const contextLines = Math.min(Math.max(Number(args.context_lines) || 0, 0), 5)
  const maxResults = Math.min(Math.max(Number(args.max_results) || DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_LIMIT)

  let rootStat: fs.Stats
  try {
    rootStat = fs.statSync(root)
  } catch {
    // 工作区懒创建：任务未写过文件时目录不存在，按「无文件可搜索」返回
    if (isUncreatedWorkspaceRoot(root)) {
      return {
        success: true,
        output: `${root} 中搜索 /${pattern}/${args.ignore_case === true ? 'i' : ''}\n命中 0 处（工作区尚未创建，首次写入文件时自动创建）`,
      }
    }
    return { success: false, error: `路径不存在: ${root}` }
  }

  // 候选文件：单文件直接用；目录走通配枚举（不传 glob 时用 **/* 枚举全部文本候选）
  let candidates: string[]
  let displayBase: string
  let truncated = false
  if (rootStat.isFile()) {
    candidates = [root]
    displayBase = path.dirname(root)
  } else {
    displayBase = root
    const fullPattern = glob
      ? (path.isAbsolute(glob) ? glob : path.join(root, glob))
      : path.join(root, '**/*')
    const expanded = expandGlobPattern(fullPattern, {
      resultLimit: MAX_CANDIDATE_FILES,
      scanLimit: Math.max(MAX_CANDIDATE_FILES * 10, 100000),
      skipDir: isIgnoredDirName,
    })
    candidates = expanded.matches
    truncated = expanded.overflow
  }
  candidates.sort()

  let scannedFiles = 0
  let skippedLarge = 0
  let skippedBinary = 0
  let totalHits = 0
  const groups: Array<{ file: string; lines: GrepLine[] }> = []

  for (const file of candidates) {
    if (totalHits >= maxResults) { truncated = true; break }

    let stat: fs.Stats
    try { stat = fs.statSync(file) } catch { continue }
    if (!stat.isFile()) continue
    scannedFiles++
    if (stat.size > MAX_FILE_BYTES) { skippedLarge++; continue }

    let buf: Buffer
    try { buf = fs.readFileSync(file) } catch { continue }
    if (buf.includes(0)) { skippedBinary++; continue }

    const lines = buf.toString('utf-8').split('\n')
    const matchedIdx: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matchedIdx.push(i)
    }
    if (matchedIdx.length === 0) continue

    const fileLines: GrepLine[] = []
    let lastEmitted = -1
    for (const i of matchedIdx) {
      if (totalHits >= maxResults) { truncated = true; break }
      const start = Math.max(0, i - contextLines)
      const end = Math.min(lines.length - 1, i + contextLines)
      for (let j = start; j <= end; j++) {
        if (j <= lastEmitted) continue
        fileLines.push({ lineNo: j + 1, text: lines[j].replace(/\r$/, ''), match: j === i })
        lastEmitted = j
      }
      totalHits++
    }
    if (fileLines.length > 0) groups.push({ file, lines: fileLines })
  }

  const flag = args.ignore_case === true ? 'i' : ''
  const header = [
    `${root} 中搜索 /${pattern}/${flag}`,
    `命中 ${totalHits} 处，涉及 ${groups.length} 个文件（已扫描 ${scannedFiles} 个文件）`,
  ]

  const body: string[] = []
  let bodyBytes = 0
  let outputCapped = false
  for (const g of groups) {
    const display = relativeDisplayPath(displayBase, g.file)
    for (const l of g.lines) {
      const line = l.match
        ? `${display}:${l.lineNo}: ${truncateLinePreview(l.text)}`
        : `${display}-${l.lineNo}- ${truncateLinePreview(l.text)}`
      const bytes = Buffer.byteLength(line, 'utf8') + 1
      if (bodyBytes + bytes > MAX_OUTPUT_BYTES) { outputCapped = true; break }
      bodyBytes += bytes
      body.push(line)
    }
    if (outputCapped) break
  }
  if (body.length === 0) body.push('（未找到匹配）')

  const notes: string[] = []
  if (skippedLarge > 0) notes.push(`跳过 ${skippedLarge} 个超过 2MB 的文件`)
  if (skippedBinary > 0) notes.push(`跳过 ${skippedBinary} 个二进制文件`)
  if (truncated) notes.push(`结果不完整：请缩小 path/glob 范围，或提高 max_results（当前 ${maxResults}）`)
  if (outputCapped) notes.push(`输出已达 ${MAX_OUTPUT_BYTES / 1024}KB 上限，请缩小 path/glob 范围或提高 pattern 精确度`)
  if (notes.length > 0) body.push(`… ${notes.join('；')}`)

  return { success: true, output: [...header, ...body].join('\n') }
}
