import { describe, it, expect } from 'vitest'
import { pathToAppFileUrl } from '../../../src/utils/file-url'

/** src/utils/file-url 边界补充：空/根路径、盘符、UNC、保留字符、Unicode */

describe('file-url / pathToAppFileUrl 边界', () => {
  it('空字符串 → app-file:///', () => {
    expect(pathToAppFileUrl('')).toBe('app-file:///')
  })

  it('仅有分隔符时逐段编码（空段保留）', () => {
    expect(pathToAppFileUrl('/')).toBe('app-file:////')
    expect(pathToAppFileUrl('C:\\')).toBe('app-file:///C:/')
  })

  it('结尾分隔符保留', () => {
    expect(pathToAppFileUrl('C:/docs/sub/')).toBe('app-file:///C:/docs/sub/')
  })

  it('小写盘符同样保留冒号', () => {
    expect(pathToAppFileUrl('d:\\data\\a.txt')).toBe('app-file:///d:/data/a.txt')
  })

  it('仅第一段的冒号不被编码（盘符），后续段的冒号编码', () => {
    expect(pathToAppFileUrl('C:\\weird:a\\b.txt')).toBe('app-file:///C:/weird%3Aa/b.txt')
  })

  it('UNC 路径逐段编码（保留双前导斜杠，得到 5 个斜杠）', () => {
    expect(pathToAppFileUrl('\\\\server\\share\\a.txt')).toBe('app-file://///server/share/a.txt')
  })

  it('相对路径不额外加盘符', () => {
    expect(pathToAppFileUrl('docs/my file.md')).toBe('app-file:///docs/my%20file.md')
  })

  it('百分号与 & 需转义，避免二次解析', () => {
    expect(pathToAppFileUrl('C:\\a%b\\c&d.txt')).toBe('app-file:///C:/a%25b/c%26d.txt')
  })

  it('Unicode 与表情符号逐字节编码', () => {
    expect(pathToAppFileUrl('C:\\目录\\😀.txt')).toBe(
      'app-file:///C:/%E7%9B%AE%E5%BD%95/%F0%9F%98%80.txt',
    )
  })

  it('已经是正斜杠的路径不重复处理', () => {
    expect(pathToAppFileUrl('C:/a/b.txt')).toBe('app-file:///C:/a/b.txt')
  })
})
