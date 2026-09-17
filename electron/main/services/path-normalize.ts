import * as fs from 'fs'
import * as path from 'path'

const IS_WINDOWS = process.platform === 'win32'

/** 去除 Windows 扩展路径前缀（\\?\C:\... → C:\...，\\?\UNC\server\share → \\server\share） */
function stripExtendedPrefix(p: string): string {
  if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8)
  if (/^\\\\\?\\/i.test(p)) return p.slice(4)
  return p
}

/**
 * 是否为盘根/文件系统根（`C:\`、`/`）。
 * 授权这个范围等于授权整盘，权限判定中一律视为过宽，与所在盘是否与应用数据目录相同无关。
 */
export function isFsRoot(normPath: string): boolean {
  if (!normPath) return false
  return normPath === '/' || /^[a-z]:\\$/i.test(normPath)
}

/**
 * 规范化路径用于权限边界比较：
 * - path.resolve 展开相对路径与正斜杠
 * - 对最长存在祖先做 realpath（展开符号链接/junction/OneDrive 重定向/8.3 短名）
 * - Windows 统一小写、反斜杠分隔
 * 不存在的路径用存在祖先的 realpath + 剩余片段拼接，保证同一物理目录不同写法得到相同结果。
 */
export function normalizePath(p: string): string {
  if (!p || typeof p !== 'string') return ''
  const trimmed = p.trim()
  // 纯空白路径静默解析为 cwd（resolve('')），权限边界比较会拿到非预期根，直接拒绝
  if (!trimmed) return ''
  let resolved = path.resolve(trimmed)
  if (IS_WINDOWS) resolved = resolved.replace(/\//g, '\\')
  let cur = resolved
  for (let guard = 0; guard < 64; guard++) {
    try {
      const realRaw = stripExtendedPrefix(fs.realpathSync.native(cur))
      // 根目录（C:\ 或 /）去尾分隔符会变成 C: 或空串，必须保留分隔符
      const real = isFsRoot(realRaw) ? realRaw : realRaw.replace(/[\\/]+$/, '')
      // 不存在的末段以"存在祖先的 realpath + 剩余片段"拼接，保证幂等
      const suffix = resolved.slice(cur.length)
      // Windows 不区分大小写，suffix 一并小写，保证同一文件不同写法缓存键一致
      if (IS_WINDOWS) return real.toLowerCase() + suffix.toLowerCase()
      return real + suffix
    } catch { /* 不存在，继续向上找 */ }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  // path.resolve 仅根目录保留尾分隔符，直接返回（剥掉会得到 C: 或空串）
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

/** 判断 child 是否等于 root 或位于 root 之下（两参数均需已规范化） */
export function isWithinPath(child: string, root: string): boolean {
  if (!child || !root) return false
  if (child === root) return true
  const sep = root.endsWith('\\') || root.endsWith('/') ? '' : path.sep
  return child.startsWith(root + sep)
}

/** 求一组路径的最浅公共父目录（返回规范化路径）；单个路径返回其父目录 */
export function commonParentDir(paths: string[]): string | null {
  const norms = [...new Set(paths.map(normalizePath).filter(Boolean))]
  if (norms.length === 0) return null
  let candidate = path.dirname(norms[0])
  while (true) {
    let ok = true
    for (const p of norms) {
      if (!isWithinPath(p, candidate)) {
        const parent = path.dirname(candidate)
        if (parent === candidate) return null
        candidate = parent
        ok = false
        break
      }
    }
    if (ok) return candidate
  }
}
