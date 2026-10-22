import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import SandboxService, {
  buildSeatbeltProfile,
  isSandboxDenial,
  isSandboxRunnerFailure,
  SandboxUnavailableError,
  windowsRunnerPath,
} from '../../../electron/main/services/sandbox.service'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  vi.restoreAllMocks()
})

describe('sandbox / 拒绝与运行器故障识别', () => {
  it('Windows 中英文拒绝文案都能识别（系统语言不同会本地化）', () => {
    expect(isSandboxDenial('Access to the path \'C:\\x\\y.txt\' is denied.', 'win32')).toBe(true)
    expect(isSandboxDenial('PermissionError: [Errno 13] Permission denied', 'win32')).toBe(true)
    // 运行时只打印 errno 码时也要能识别（Node 的 EPERM / EACCES）
    expect(isSandboxDenial('Error: EPERM: operation not permitted', 'win32')).toBe(true)
    expect(isSandboxDenial('OUTSIDE=FAIL EACCES', 'win32')).toBe(true)
    expect(isSandboxDenial('对路径“C:\\x\\y.txt”的访问被拒绝。', 'win32')).toBe(true)
    expect(isSandboxDenial('拒绝访问。', 'win32')).toBe(true)
    expect(isSandboxDenial('command not found: foo', 'win32')).toBe(false)
  })

  it('macOS 用 EPERM/EACCES 语义识别', () => {
    expect(isSandboxDenial('touch: /Users/me/x: Operation not permitted', 'darwin')).toBe(true)
    expect(isSandboxDenial('Read-only file system', 'darwin')).toBe(true)
    expect(isSandboxDenial('zsh: command not found: foo', 'darwin')).toBe(false)
  })

  it('运行器自身故障与命令被拒绝区分开', () => {
    expect(isSandboxRunnerFailure('workavatar-sandbox: workspace is not an existing directory', 'win32')).toBe(true)
    expect(isSandboxRunnerFailure('Access is denied.', 'win32')).toBe(false)
    expect(isSandboxRunnerFailure('sandbox-exec: profile syntax error', 'darwin')).toBe(true)
  })
})

describe('sandbox / Seatbelt profile', () => {
  it('默认允许一切，仅拒绝文件写入并把工作区与临时目录放行', () => {
    const profile = buildSeatbeltProfile('/Users/me/work', '/private/tmp/wa-sbx-1')
    expect(profile).toContain('(allow default)')
    expect(profile).toContain('(deny file-write*)')
    expect(profile).toContain('(subpath "/Users/me/work")')
    expect(profile).toContain('(subpath "/private/tmp/wa-sbx-1")')
    expect(profile).toContain('(literal "/dev/null")')
    // 不允许写入根目录
    expect(profile).not.toContain('(subpath "/")')
  })
})

describe('sandbox / confine', () => {
  it('danger-full-access 原样透传，不调用任何平台后端', () => {
    const launch = SandboxService.getInstance().confine({
      program: 'pwsh',
      args: ['-Command', 'echo hi'],
      cwd: os.tmpdir(),
      workspaceRoot: os.tmpdir(),
      mode: 'danger-full-access',
    })
    expect(launch.program).toBe('pwsh')
    expect(launch.args).toEqual(['-Command', 'echo hi'])
    expect(launch.facts).toMatchObject({ mode: 'danger-full-access', backend: 'none', denied: false })
    launch.cleanup()
  })

  it('缺少平台后端时失败关闭（Linux 无 bwrap），不静默降级为无约束运行', () => {
    setPlatform('linux')
    expect(() => SandboxService.getInstance().confine({
      program: 'bash',
      args: ['-c', 'echo hi'],
      cwd: os.tmpdir(),
      workspaceRoot: os.tmpdir(),
      mode: 'workspace-write',
    })).toThrow(SandboxUnavailableError)
  })

  it('Windows runner 缺失时失败关闭', () => {
    setPlatform('win32')
    const service = SandboxService.getInstance()
    service.setRunnerPathOverride(null)
    try {
      expect(() => service.confine({
        program: 'powershell.exe',
        args: ['-Command', 'echo hi'],
        cwd: os.tmpdir(),
        workspaceRoot: os.tmpdir(),
        mode: 'workspace-write',
      })).toThrow(/沙箱运行器缺失/)
    } finally {
      service.setRunnerPathOverride(undefined)
    }
  })

  it.skipIf(!fs.existsSync(windowsRunnerPath()))('Windows 包装参数包含工作区、临时目录、工作目录与原始命令，并设置 TMP/TEMP', () => {
    setPlatform('win32')
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-ws-'))
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-cwd-'))
    const launch = SandboxService.getInstance().confine({
      program: 'powershell.exe',
      args: ['-Command', 'echo hi'],
      cwd,
      workspaceRoot: ws,
      mode: 'workspace-write',
    })
    expect(launch.program).toBe(windowsRunnerPath())
    const args = launch.args
    expect(args[0]).toBe('--workspace')
    expect(args[1]).toBe(ws)
    expect(args[2]).toBe('--temp')
    // 工作目录必须单独传递：runner 不得把 working_dir 改写成工作区
    expect(args[4]).toBe('--cwd')
    expect(args[5]).toBe(cwd)
    expect(args[6]).toBe('--mode')
    expect(args[7]).toBe('workspace-write')
    expect(args[8]).toBe('--')
    expect(args.slice(-3)).toEqual(['powershell.exe', '-Command', 'echo hi'])
    expect(launch.facts).toMatchObject({ backend: 'windows-acl', mode: 'workspace-write' })
    const tempDir = args[3]
    expect(launch.env.TMP).toBe(tempDir)
    expect(launch.env.TEMP).toBe(tempDir)
    launch.cleanup()
    expect(fs.existsSync(tempDir)).toBe(false)
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  })
})
