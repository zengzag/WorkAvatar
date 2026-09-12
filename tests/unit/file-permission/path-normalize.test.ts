import { describe, it, expect } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { normalizePath, isWithinPath, commonParentDir } from '../../../electron/main/services/path-normalize'

/** 创建一个临时根目录，用后清理 */
function makeTempRoot(prefix = 'wa-norm-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

describe('normalizePath', () => {
  it('已存在目录：统一分隔符与大小写', () => {
    const dir = makeTempRoot()
    try {
      const mixed = process.platform === 'win32'
        ? dir.replace(/\\/g, '/').toUpperCase()
        : dir
      expect(normalizePath(mixed)).toBe(normalizePath(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在的路径：基于存在祖先的 realpath 拼接剩余片段', () => {
    const dir = makeTempRoot()
    try {
      const child = path.join(dir, 'not-exist', 'deep', 'file.txt')
      const n = normalizePath(child)
      expect(isWithinPath(n, normalizePath(dir))).toBe(true)
      expect(n.endsWith('file.txt')).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('符号链接：解析到真实路径', () => {
    const dir = makeTempRoot()
    try {
      const real = path.join(dir, 'real')
      fs.mkdirSync(real)
      const link = path.join(dir, 'link')
      try {
        fs.symlinkSync(real, link, 'directory')
      } catch {
        return // 平台不支持符号链接则跳过
      }
      expect(normalizePath(path.join(link, 'a.txt'))).toBe(normalizePath(path.join(real, 'a.txt')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('空路径返回空字符串', () => {
    expect(normalizePath('')).toBe('')
    expect(normalizePath(null as unknown as string)).toBe('')
  })

  it('幂等性：对不存在路径二次规范化结果一致', () => {
    const dir = makeTempRoot()
    try {
      const child = path.join(dir, 'not-exist', 'deep', 'file.txt')
      const once = normalizePath(child)
      expect(normalizePath(once)).toBe(once)
      // 不得丢失或重复中间段
      expect(once).toContain('not-exist')
      expect(once).toContain('deep')
      expect(once.endsWith('file.txt')).toBe(true)
      expect(once.endsWith('file.txt\\file.txt')).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不存在路径段大小写归一（Windows 不区分大小写，POSIX 保持原样）', () => {
    const dir = makeTempRoot()
    try {
      const upper = normalizePath(path.join(dir, 'NewFolder', 'MixedCase.TXT'))
      const lower = normalizePath(path.join(dir, 'newfolder', 'mixedcase.txt'))
      if (process.platform === 'win32') {
        const weird = normalizePath(path.join(dir.toUpperCase(), 'NEWFOLDER', 'MIXEDCASE.TXT'))
        expect(upper).toBe(lower)
        expect(upper).toBe(weird)
      } else {
        // POSIX 大小写敏感：不同大小写是不同路径，保持各自写法
        expect(upper).not.toBe(lower)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('带尾分隔符的根目录规范化后仍可用于边界判定', () => {
    const root = makeTempRoot()
    try {
      const rootNorm = normalizePath(root)
      const withSlash = normalizePath(root + path.sep)
      expect(withSlash).toBe(rootNorm)
      expect(isWithinPath(normalizePath(path.join(root, 'a.txt')), withSlash)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('文件系统根（/ 或盘符根）规范化结果非空且子路径判定正确', () => {
    const fsRoot = process.platform === 'win32'
      ? process.cwd().slice(0, 3) // 例如 C:\（保留尾斜杠的盘符根）
      : '/'
    const norm = normalizePath(fsRoot)
    expect(norm).toBeTruthy()
    expect(norm).not.toBe('')
    const child = process.platform === 'win32'
      ? normalizePath(path.join(fsRoot, 'Windows'))
      : '/home'
    expect(isWithinPath(child, norm)).toBe(true)
  })
})

describe('isWithinPath', () => {
  it('子路径在根内', () => {
    const root = makeTempRoot()
    try {
      expect(isWithinPath(normalizePath(path.join(root, 'a', 'b.txt')), normalizePath(root))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('根自身算在内', () => {
    const root = normalizePath(makeTempRoot())
    expect(isWithinPath(root, root)).toBe(true)
  })

  it('前缀相同但目录名不同不算在内（防 sibling 前缀误判）', () => {
    const root = makeTempRoot()
    try {
      const sibling = root + path.sep + '2' // 与 root+任意子目录不同：root2 与 root 同级前缀陷阱用 root 本身 + '2' 后缀模拟
      const prefixTrap = normalizePath(root) + '-sibling'
      expect(isWithinPath(normalizePath(sibling), normalizePath(root))).toBe(true)
      expect(isWithinPath(prefixTrap, normalizePath(root))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('空参数返回 false', () => {
    expect(isWithinPath('', 'x')).toBe(false)
    expect(isWithinPath('x', '')).toBe(false)
  })
})

describe('commonParentDir', () => {
  it('返回公共父目录', () => {
    const root = makeTempRoot()
    try {
      const result = commonParentDir([
        path.join(root, 'a.txt'),
        path.join(root, 'sub', 'b.txt'),
      ])
      expect(result).toBe(normalizePath(root))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('空数组返回 null', () => {
    expect(commonParentDir([])).toBeNull()
  })

  it('单个文件路径返回其父目录（目录目标需由调用方通过 scopeDir 显式指定授权范围）', () => {
    const root = makeTempRoot()
    try {
      const file = path.join(root, 'a.txt')
      expect(commonParentDir([file])).toBe(normalizePath(root))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('跨盘符/无公共父目录时返回 null', () => {
    if (process.platform !== 'win32') {
      // POSIX 下任意两路径至少有公共根 /
      expect(commonParentDir(['/home/a/x', '/var/b/y'])).toBe(normalizePath('/'))
      return
    }
    expect(commonParentDir(['C:\\a\\x', 'D:\\b\\y'])).toBeNull()
  })
})
