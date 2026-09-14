import { describe, it, expect } from 'vitest'
import { matchesDangerousPattern } from '../../../electron/main/services/agent/tools/shell-exec.tool'

describe('agent/tools/shell-exec / 编码混淆执行拦截', () => {
  it('PowerShell -EncodedCommand 各形态（含别名 -enc/-en 与 pwsh）均拦截', () => {
    expect(matchesDangerousPattern('powershell -EncodedCommand SQBFAFgA')).toBe(true)
    expect(matchesDangerousPattern('powershell -enc SQBFAFgA')).toBe(true)
    expect(matchesDangerousPattern('powershell -en SQBFAFgA')).toBe(true)
    expect(matchesDangerousPattern('pwsh -EncodedCommand SQBFAFgA')).toBe(true)
    // -ExecutionPolicy 是常用合法参数，不得误拦
    expect(matchesDangerousPattern('powershell -ExecutionPolicy Bypass -File a.ps1')).toBe(false)
  })

  it('base64 管道解码执行拦截', () => {
    expect(matchesDangerousPattern('echo Y2QgL3Q7IHJtIC1yZg== | base64 -d | bash')).toBe(true)
    expect(matchesDangerousPattern('echo Y2QgL3Q= | base64 --decode | sh')).toBe(true)
    expect(matchesDangerousPattern('base64 -d payload.b64 | bash')).toBe(true)
  })

  it('正常命令不误拦', () => {
    expect(matchesDangerousPattern('powershell Get-Process')).toBe(false)
    expect(matchesDangerousPattern('cmd /c echo secret | clip')).toBe(true) // 原 clip 规则保留
    expect(matchesDangerousPattern('echo hello | clip')).toBe(false)
    expect(matchesDangerousPattern('echo hello')).toBe(false)
    expect(matchesDangerousPattern('base64 -d a.b64 > out.txt')).toBe(false) // 解码写文件不执行
    expect(matchesDangerousPattern('git status && npm test')).toBe(false)
    expect(matchesDangerousPattern('python -e "print(1)"')).toBe(false)
  })

  it('既有破坏类命令仍拦截', () => {
    expect(matchesDangerousPattern('shutdown /r /t 0')).toBe(true)
    expect(matchesDangerousPattern('format C: /q')).toBe(true)
    expect(matchesDangerousPattern('dd if=/dev/zero of=/dev/sda')).toBe(true)
  })
})
