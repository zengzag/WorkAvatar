import { describe, it, expect } from 'vitest'
import { pathToAppFileUrl } from '../../../src/utils/file-url'

describe('src/utils/file-url / pathToAppFileUrl', () => {
  it('Windows 反斜杠路径转正斜杠', () => {
    expect(pathToAppFileUrl('C:\\data\\file.txt')).toBe('app-file:///C:/data/file.txt')
  })

  it('已含特殊字符的路径', () => {
    expect(pathToAppFileUrl('C:\\my dir\\文件.txt')).toBe('app-file:///C:/my%20dir/%E6%96%87%E4%BB%B6.txt')
  })

  it('路径含 # 时应编码为 %23，避免 URL fragment 截断', () => {
    const url = pathToAppFileUrl('C:\\repos\\a#b\\c.txt')
    expect(url).toBe('app-file:///C:/repos/a%23b/c.txt')
  })

  it('路径含 ? 时应编码为 %3F', () => {
    const url = pathToAppFileUrl('C:\\repos\\a?b\\c.txt')
    expect(url).toBe('app-file:///C:/repos/a%3Fb/c.txt')
  })
})
