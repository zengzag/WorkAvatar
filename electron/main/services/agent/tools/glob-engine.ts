import * as fs from 'fs'
import * as path from 'path'

/**
 * 通配路径展开引擎（file_delete / file_list / grep 共用）。
 * 支持 * ? [abc] [!abc] 段内通配与 ** 跨段匹配；不支持花括号展开。
 */

export const IS_WINDOWS = process.platform === 'win32'

/** 默认结果数上限（单个通配模式一次最多返回多少条） */
export const GLOB_RESULT_LIMIT = 1000
/** 默认扫描条目上限（进入 walk 的目录/条目计数），防止失控扫描 */
export const GLOB_SCAN_LIMIT = 20000

/** 扫描超限信号：由 tick 抛出，调用方决定静默截断还是提示 */
export class GlobScanOverflow extends Error {}

/** 遍历目录时默认剪枝的重目录：依赖、构建产物、版本库元数据 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.output', '.turbo', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.venv', 'venv', '.tox', '.gradle', '.dart_tool', '.idea', '.vs',
])

export function isIgnoredDirName(name: string): boolean {
  return IGNORED_DIR_NAMES.has(name)
}

/** 是否含 glob 通配符（* ? [..]） */
export function isGlobPattern(p: string): boolean {
  return /[*?[]/.test(p)
}

/** 将单个路径段通配转为正则源（* ? [abc] [!abc]），不跨目录分隔符 */
export function segmentToRegexSource(seg: string): string {
  let re = ''
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (ch === '*') { re += '[^\\\\/]*'; continue }
    if (ch === '?') { re += '[^\\\\/]'; continue }
    if (ch === '[') {
      const close = seg.indexOf(']', i + 1)
      if (close === -1) { re += '\\['; continue }
      let body = seg.slice(i + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      re += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`
      i = close
      continue
    }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return re
}

export interface ExpandGlobOptions {
  /** 结果数上限，默认 GLOB_RESULT_LIMIT */
  resultLimit?: number
  /** 扫描条目上限，默认 GLOB_SCAN_LIMIT */
  scanLimit?: number
  /** 目录剪枝：返回 true 的目录不展开（file_delete 不传，保持原有行为） */
  skipDir?: (name: string) => boolean
}

export interface ExpandGlobResult {
  matches: string[]
  /** 是否因结果/扫描上限被截断 */
  overflow: boolean
}

/** 递归通配匹配：segs 为按 / 拆分的模式段，idx 从首个通配段开始 */
function walkMatch(
  dir: string,
  segs: string[],
  idx: number,
  out: string[],
  tick: () => void,
  opts: { resultLimit: number; skipDir?: (name: string) => boolean },
): void {
  if (out.length >= opts.resultLimit) return
  tick()
  if (idx >= segs.length) { out.push(dir); return }
  const seg = segs[idx]
  const isLast = idx === segs.length - 1

  if (seg === '**') {
    // ** 可匹配零段或多段目录
    if (!isLast) walkMatch(dir, segs, idx + 1, out, tick, opts)
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory() && opts.skipDir?.(e.name)) continue
      const full = path.join(dir, e.name)
      if (isLast) {
        out.push(full)
        if (e.isDirectory()) walkMatch(full, segs, idx, out, tick, opts)
      } else if (e.isDirectory()) {
        walkMatch(full, segs, idx, out, tick, opts)
      }
      if (out.length >= opts.resultLimit) return
    }
    return
  }

  const re = new RegExp(`^${segmentToRegexSource(seg)}$`, IS_WINDOWS ? 'i' : '')
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!re.test(e.name)) continue
    const full = path.join(dir, e.name)
    if (isLast) out.push(full)
    else if (e.isDirectory()) {
      if (opts.skipDir?.(e.name)) continue
      walkMatch(full, segs, idx + 1, out, tick, opts)
    }
    if (out.length >= opts.resultLimit) return
  }
}

/**
 * 展开通配路径为匹配到的真实绝对路径。
 * resolvedPattern 必须是绝对路径（调用方先按工作区解析）。
 */
export function expandGlobPattern(resolvedPattern: string, options: ExpandGlobOptions = {}): ExpandGlobResult {
  if (!isGlobPattern(resolvedPattern)) {
    return { matches: fs.existsSync(resolvedPattern) ? [resolvedPattern] : [], overflow: false }
  }

  const resultLimit = options.resultLimit ?? GLOB_RESULT_LIMIT
  const scanLimit = options.scanLimit ?? GLOB_SCAN_LIMIT

  // 从首个通配字符前的静态前缀确定扫描起点
  const firstGlobChar = resolvedPattern.search(/[*?[]/)
  const staticPart = firstGlobChar === -1 ? resolvedPattern : resolvedPattern.slice(0, firstGlobChar)
  const base = /[\\/]$/.test(staticPart)
    ? path.resolve(staticPart)
    : path.dirname(path.resolve(staticPart))
  const segs = resolvedPattern.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')
  const firstGlobSeg = segs.findIndex(isGlobPattern)

  const out: string[] = []
  let scanned = 0
  let overflow = false
  try {
    walkMatch(base, segs, firstGlobSeg, out, () => {
      if (++scanned > scanLimit) throw new GlobScanOverflow()
    }, { resultLimit, skipDir: options.skipDir })
  } catch (e) {
    if (!(e instanceof GlobScanOverflow)) throw e
    overflow = true
  }
  if (out.length >= resultLimit) overflow = true
  return { matches: out, overflow }
}
