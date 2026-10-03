import { describe, it, expect } from 'vitest'
import { isBlockedOpenPath } from '../../../electron/main/services/open-path-guard'

describe('open-path-guard / isBlockedOpenPath', () => {
  it('正常文档路径放行（含任务生成文件、附件目录）', () => {
    expect(isBlockedOpenPath('C:\\Users\\me\\report.docx')).toBe(false)
    expect(isBlockedOpenPath('D:\\workspace\\task\\out.xlsx')).toBe(false)
    expect(isBlockedOpenPath('/home/me/notes/a.md')).toBe(false)
  })

  it('可执行/脚本扩展名拒绝（大小写不敏感）', () => {
    expect(isBlockedOpenPath('C:\\tmp\\evil.exe')).toBe(true)
    expect(isBlockedOpenPath('C:\\tmp\\run.BAT')).toBe(true)
    expect(isBlockedOpenPath('C:\\tmp\\script.ps1')).toBe(true)
    expect(isBlockedOpenPath('C:\\tmp\\payload.js')).toBe(true)
    expect(isBlockedOpenPath('/tmp/a.sh')).toBe(true)
  })

  it('敏感路径拒绝（凭据/密钥/版本库段）', () => {
    expect(isBlockedOpenPath('C:\\repo\\.ssh\\known_hosts')).toBe(true)
    expect(isBlockedOpenPath('C:\\repo\\.git\\config')).toBe(true)
    expect(isBlockedOpenPath('/home/me/id_rsa')).toBe(true)
    expect(isBlockedOpenPath('C:\\repo\\server.pem')).toBe(true)
  })

  it('非字符串 / 空值拒绝', () => {
    expect(isBlockedOpenPath('')).toBe(true)
    expect(isBlockedOpenPath(undefined)).toBe(true)
    expect(isBlockedOpenPath(null)).toBe(true)
    expect(isBlockedOpenPath(123)).toBe(true)
    expect(isBlockedOpenPath({ path: 'a.txt' })).toBe(true)
  })
})
