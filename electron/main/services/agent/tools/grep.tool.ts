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
  summary: '在文件内容中按正则检索，返回文件:行号与匹配行，用于定位符号、字符串、配置项。',
  description: `在文件内容中按正则检索，返回 "路径:行号: 内容"。用于跨文件定位函数名、变量、字符串、配置项——内容检索请用本工具，不要用 shell 的 grep / rg / Select-String 代替。

- pattern：正则表达式（必填）。仅需字面量匹配时请转义特殊字符（如 "\\.json"、"getUser\\("）。
- path：搜索根目录或单个文件，默认当前工作目录。
- glob：可选文件过滤模式（支持 * ? [abc] 与 **，如 "**/*.ts"、"src/**/*.test.ts"）；不传则搜索全部文本文件。
- ignore_case：忽略大小写（默认false）；context_lines：匹配行上下各展示几行（0-5，默认0，上下文行以 "路径-行号- 内容" 呈现）。
- 自动跳过 node_modules / .git / dist 等重目录，以及二进制文件与超过 2MB 的文件。
- 单行预览超过 2000 字节会截断，单次输出超过 256KB 会停止追加并提示。
- 最多返回 max_results 处匹配，超限会在末尾提示。`,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要检索的正则表达式' },
      path: { type: 'string', description: '搜索根目录或单个文件（绝对路径，或相对当前工作目录）。默认当前工作目录' },
      glob: { type: 'string', description: '可选文件过滤模式（支持 * ? [abc] 与 **），相对 path 解析' },
      ignore_case: { type: 'boolean', description: '是否忽略大小写（默认false）' },
      context_lines: { type: 'number', description: '匹配行上下各展示几行（0-5，默认0）', minimum: 0, maximum: 5 },
      max_results: { type: 'number', description: `最多返回的匹配行数（默认${DEFAULT_MAX_RESULTS}，上限${MAX_RESULTS_LIMIT}）`, minimum: 1, maximum: MAX_RESULTS_LIMIT },
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
