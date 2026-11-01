import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { expandGlobPattern, isGlobPattern, isIgnoredDirName } from './glob-engine'
import { getWorkspacePath, isUncreatedWorkspaceRoot, resolveToolPath } from './fs-shared'
import { formatFileSize, relativeDisplayPath } from './utils'

const DEFAULT_MAX_ITEMS = 200
const MAX_ITEMS_LIMIT = 1000

interface ListedEntry {
  full: string
  isDir: boolean
  size: number
}

/** 列出目录内容，或按通配模式枚举文件（与 file_delete 共用通配引擎） */
export const fileListTool: ToolDefinition = {
  id: 'file_list',
  name: 'file_list',
  title: '列出文件',
  summary: 'List files and directories by path or glob to understand project structure and locate files.',
  description: `List a directory's contents, or find files by glob pattern. Use this tool instead of shell ls / find / dir for directory browsing and file lookup.

- path: directory to list (default: current workspace). A file path returns that file's details.
- pattern: optional glob relative to path (* ? [abc] and ** across segments, e.g. "**/*.ts"). Without it, direct children are listed.
- Heavy directories (node_modules, .git, dist, build) are skipped; dot-entries are hidden unless show_hidden=true.
- Returned paths are relative to path; directories end with "/". At most max_items entries are returned, with a truncation notice.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory or file path (absolute, or relative to the workspace). Default: current workspace' },
      pattern: { type: 'string', description: 'Optional glob (* ? [abc], **), resolved relative to path; omit to list direct children' },
      max_items: { type: 'number', description: `Maximum entries to return (default ${DEFAULT_MAX_ITEMS}, max ${MAX_ITEMS_LIMIT})`, minimum: 1, maximum: MAX_ITEMS_LIMIT },
      show_hidden: { type: 'boolean', description: 'Include dot-entries (default false)' },
    },
    required: [],
  },
  handler: async (args: any) => {
    try {
      return await listFiles(args)
    } catch (error: any) {
      return { success: false, error: `列出文件失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
  permission: 'safe',
  onDemand: false,
}

async function listFiles(args: any) {
  const rawPath = String(args.path || '').trim()
  const base = rawPath ? resolveToolPath(rawPath) : (getWorkspacePath() || process.cwd())
  const pattern = String(args.pattern || '').trim()
  const maxItems = Math.min(Math.max(Number(args.max_items) || DEFAULT_MAX_ITEMS, 1), MAX_ITEMS_LIMIT)
  const showHidden = args.show_hidden === true

  if (pattern && !isGlobPattern(pattern)) {
    return { success: false, error: `pattern 不含通配符（* ? [ ]）：${pattern}。请传入通配模式，或去掉 pattern 直接列出目录` }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(base)
  } catch {
    // 工作区懒创建：任务还没写过文件时目录不存在，按空目录返回，避免误导模型去"修路径"
    if (isUncreatedWorkspaceRoot(base)) {
      return {
        success: true,
        output: pattern
          ? `${base}\n匹配 "${pattern}"：共 0 项（工作区尚未创建，首次写入文件时自动创建）`
          : `${base}\n直接子项：共 0 项（工作区尚未创建，首次写入文件时自动创建）`,
      }
    }
    return { success: false, error: `路径不存在: ${base}` }
  }
  if (stat.isFile()) {
    return { success: true, output: `${base}（文件，${formatFileSize(stat.size)}）` }
  }
  if (!stat.isDirectory()) {
    return { success: false, error: `路径既不是文件也不是目录: ${base}` }
  }

  const entries: ListedEntry[] = []
  let truncated = false

  if (pattern) {
    const fullPattern = path.isAbsolute(pattern) ? pattern : path.join(base, pattern)
    const { matches, overflow } = expandGlobPattern(fullPattern, {
      resultLimit: Math.max(maxItems * 4, 1000),
      skipDir: isIgnoredDirName,
    })
    truncated = overflow
    for (const m of matches) {
      if (!showHidden && path.basename(m).startsWith('.')) continue
      let st: fs.Stats
      try { st = fs.statSync(m) } catch { continue }
      entries.push({ full: m, isDir: st.isDirectory(), size: st.size })
    }
  } else {
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(base, { withFileTypes: true })
    } catch (error: any) {
      return { success: false, error: `目录读取失败: ${error?.message || error}` }
    }
    for (const d of dirents) {
      if (!showHidden && d.name.startsWith('.')) continue
      const isDir = d.isDirectory()
      if (isDir && isIgnoredDirName(d.name)) continue
      const full = path.join(base, d.name)
      let size = 0
      if (!isDir) {
        try { size = fs.statSync(full).size } catch { /* 单个条目检查失败不影响列表 */ }
      }
      entries.push({ full, isDir, size })
    }
  }

  // 目录在前，再按名称排序，保证同一目录多次调用结果稳定
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return path.basename(a.full).localeCompare(path.basename(b.full))
  })

  const shown = entries.slice(0, maxItems)
  if (shown.length < entries.length) truncated = true

  const dirCount = entries.filter(e => e.isDir).length
  const header = pattern
    ? `${base}\n匹配 "${pattern}"：共 ${entries.length} 项（目录 ${dirCount} / 文件 ${entries.length - dirCount}）`
    : `${base}\n直接子项：共 ${entries.length} 项（目录 ${dirCount} / 文件 ${entries.length - dirCount}）`

  const lines = shown.map(e =>
    e.isDir
      ? `- ${relativeDisplayPath(base, e.full)}/`
      : `- ${relativeDisplayPath(base, e.full)}  (${formatFileSize(e.size)})`
  )
  if (lines.length === 0) lines.push('（无匹配项）')
  lines.push(`（以上路径相对基准目录 ${base}）`)
  if (truncated) {
    lines.push(`… 结果不完整：已达展示上限或扫描上限，请缩小 path/pattern 范围，或提高 max_items（当前 ${maxItems}）`)
  }

  return { success: true, output: [header, ...lines].join('\n') }
}
