import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { normalizePath, isWithinPath, commonParentDir, isFsRoot } from '../../../electron/main/services/path-normalize'

const IS_WINDOWS = process.platform === 'win32'

describe('path-normalize / normalizePath', () => {
  it('空输入返回空串', () => {
    expect(normalizePath('')).toBe('')
    expect(normalizePath(null as any)).toBe('')
  })

  it('相对路径解析为绝对路径', () => {
    const r = normalizePath('./foo/bar')
    expect(path.isAbsolute(r)).toBe(true)
  })

  it('同一物理目录不同写法结果一致（大小写不敏感）', () => {
    if (!IS_WINDOWS) return
    const a = normalizePath(os.tmpdir().toUpperCase())
    const b = normalizePath(os.tmpdir().toLowerCase())
    expect(a).toBe(b)
  })

  it('存在目录返回 realpath（去除尾分隔符）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-np-'))
    try {
      const r = normalizePath(dir)
      expect(r.toLowerCase()).toBe(fs.realpathSync.native(dir).toLowerCase().replace(/[\\/]+$/, ''))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在的路径：存在祖先 + 后缀拼接（幂等）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-np-'))
    try {
      const child = path.join(base, 'not-exist-dir', 'file.txt')
      const r1 = normalizePath(child)
      const r2 = normalizePath(r1)
      expect(r1).toBe(r2)
      expect(r1.toLowerCase()).toContain('not-exist-dir')
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('正斜杠与反斜杠等价', () => {
    if (!IS_WINDOWS) return
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-np-'))
    try {
      expect(normalizePath(base + '\\sub')).toBe(normalizePath(base + '/sub'))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('幂等：对已规范化路径再次规范化结果不变', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-np-'))
    try {
      const once = normalizePath(base)
      expect(normalizePath(once)).toBe(once)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('path-normalize / isWithinPath', () => {
  it('相等视为在内', () => {
    expect(isWithinPath('C:\\data', 'C:\\data')).toBe(true)
  })

  it('子路径在内', () => {
    expect(isWithinPath('C:\\data\\sub\\file.txt', 'C:\\data')).toBe(true)
  })

  it('前缀字符串但不构成路径边界（防 C:\\data2 误判）', () => {
    expect(isWithinPath('C:\\data2\\file', 'C:\\data')).toBe(false)
  })

  it('root 带尾分隔符', () => {
    expect(isWithinPath('C:\\data\\file', 'C:\\data\\')).toBe(true)
    expect(isWithinPath('C:\\data2\\file', 'C:\\data\\')).toBe(false)
  })

  it('父路径不在子路径内', () => {
    expect(isWithinPath('C:\\data', 'C:\\data\\sub')).toBe(false)
  })

  it('空输入返回 false', () => {
    expect(isWithinPath('', 'C:\\data')).toBe(false)
    expect(isWithinPath('C:\\data', '')).toBe(false)
  })
})

describe('path-normalize / commonParentDir', () => {
  it('两个兄弟目录求公共父', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cp-'))
    try {
      const d1 = path.join(base, 'a')
      const d2 = path.join(base, 'b')
      fs.mkdirSync(d1)
      fs.mkdirSync(d2)
      expect(normalizePath(commonParentDir([d1, d2])!)).toBe(normalizePath(base))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('嵌套路径求最浅公共父', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cp-'))
    try {
      const d1 = path.join(base, 'a', 'b', 'c.txt')
      const d2 = path.join(base, 'a', 'd.txt')
      expect(normalizePath(commonParentDir([d1, d2])!)).toBe(normalizePath(path.join(base, 'a')))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('单路径返回其父目录', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cp-'))
    try {
      expect(normalizePath(commonParentDir([path.join(base, 'x.txt')])!)).toBe(normalizePath(base))
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  it('空数组/空字符串输入返回 null', () => {
    expect(commonParentDir([])).toBeNull()
    expect(commonParentDir([''])).toBeNull()
  })

  it('空白字符串路径被拒绝（normalizePath 返回空串，不再静默解析为 cwd）', () => {
    expect(normalizePath('   ')).toBe('')
    expect(commonParentDir(['   '])).toBeNull()
  })

  it('不同盘符（Windows）返回 null', () => {
    if (!IS_WINDOWS) return
    expect(commonParentDir(['C:\\a\\b', 'D:\\a\\b'])).toBeNull()
  })
})

describe('path-normalize / isFsRoot', () => {
  it('识别盘根与文件系统根', () => {
    expect(isFsRoot('c:\\')).toBe(true)
    expect(isFsRoot('C:\\')).toBe(true)
    expect(isFsRoot('/')).toBe(true)
  })

  it('盘根下的子路径不是根', () => {
    expect(isFsRoot('c:\\users')).toBe(false)
    expect(isFsRoot('/tmp')).toBe(false)
    expect(isFsRoot('c:')).toBe(false) // 缺分隔符的盘符相对写法
    expect(isFsRoot('')).toBe(false)
  })

  it('规范化后的盘根仍被识别', () => {
    const root = path.parse(os.tmpdir()).root
    expect(isFsRoot(normalizePath(root))).toBe(true)
  })
})
