import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { javascriptExecTool } from '../../../electron/main/services/agent/tools/javascript-exec.tool'
import UnifiedInteractionService, { interactionContext } from '../../../electron/main/services/unified-interaction.service'

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-sandbox-'))
}

async function runCode(code: string, workingDir: string) {
  return javascriptExecTool.handler!({ code, working_dir: workingDir, timeout: 10 }) as Promise<{
    success: boolean
    output?: string
    error?: string
  }>
}

describe('javascript_exec 沙箱 - 文件写删权限闸门', () => {
  let ws: string
  let outsideDir: string

  beforeEach(() => {
    ws = makeTempRoot()
    outsideDir = makeTempRoot()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  it('file.save 相对路径以注入工作目录（非主进程 cwd）为基准写入', async () => {
    const ctx = { sessionId: 'js1', employeeId: 'e1', workspacePath: ws }
    const target = path.join(ws, 'report', 'out.txt')
    const result = await interactionContext.run(ctx as never, () =>
      runCode('await file.createFolder("report")\nawait file.save("report/out.txt", "hello")', ws))
    expect(result.success).toBe(true)
    expect(fs.existsSync(target)).toBe(true)
    expect(fs.readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('file.save 相对路径逃逸工作区且无交互上下文 → 拒绝，文件不落盘', async () => {
    const escapeTarget = path.resolve(ws, '..', `wa-js-escape-${Date.now()}.txt`)
    fs.rmSync(escapeTarget, { force: true })
    // 不传 working_dir 以外的 ctx：getWorkspacePath() 为空，区外无交互上下文直接拒绝
    const result = await runCode('await file.save("../' + path.basename(escapeTarget) + '", "x")', ws)
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(fs.existsSync(escapeTarget)).toBe(false)
  })

  it('沙箱内 fs.writeFileSync 被禁用并引导使用 file 对象', async () => {
    const result = await interactionContext.run(
      { sessionId: 'js2', employeeId: 'e1', workspacePath: ws } as never,
      () => runCode(`require('fs').writeFileSync('blocked.txt', 'x')`, ws),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('file')
    expect(fs.existsSync(path.join(ws, 'blocked.txt'))).toBe(false)
  })

  it('adm-zip writeZip 相对路径落在工作区内 → 正常生成压缩包', async () => {
    const code = [
      "const AdmZip = require('adm-zip')",
      'const zip = new AdmZip()',
      "zip.addFile('hello.txt', Buffer.from('hi'))",
      "zip.writeZip('a.zip')",
    ].join('\n')
    const result = await interactionContext.run(
      { sessionId: 'js3', employeeId: 'e1', workspacePath: ws } as never,
      () => runCode(code, ws),
    )
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(ws, 'a.zip'))).toBe(true)
  })

  it('adm-zip writeZip 区外字面路径 → 预扫描阶段拦截，不执行脚本', async () => {
    const evil = path.join(outsideDir, 'evil.zip')
    const code = [
      "const AdmZip = require('adm-zip')",
      'const zip = new AdmZip()',
      `zip.writeZip(${JSON.stringify(evil)})`,
    ].join('\n')
    const result = await runCode(code, ws)
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(fs.existsSync(evil)).toBe(false)
  })

  it('adm-zip writeZip 区外字面路径 + 用户弹窗确认 → 预扫描授权后落盘', async () => {
    const target = path.join(outsideDir, 'ok.zip')
    const spy = vi.spyOn(UnifiedInteractionService.getInstance(), 'request')
      .mockResolvedValue({ id: '', confirmed: true, cancelled: false } as never)
    const code = [
      "const AdmZip = require('adm-zip')",
      'const zip = new AdmZip()',
      `zip.writeZip(${JSON.stringify(target)})`,
    ].join('\n')
    const result = await interactionContext.run(
      { sessionId: 'js4', employeeId: 'e1', workspacePath: ws } as never,
      () => runCode(code, ws),
    )
    expect(result.success, result.error).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(target)).toBe(true)
    spy.mockRestore()
  })

  it('adm-zip writeZip 动态变量路径（预扫描提取不到）→ 运行时同步校验拒绝', async () => {
    const evil = path.join(outsideDir, 'dyn.zip')
    const code = [
      "const AdmZip = require('adm-zip')",
      `const dir = ${JSON.stringify(outsideDir)}`,
      "const zip = new AdmZip()",
      "zip.writeZip(dir + '/dyn.zip')",
    ].join('\n')
    const result = await runCode(code, ws)
    expect(result.success).toBe(false)
    expect(result.error).toContain('授权')
    expect(fs.existsSync(evil)).toBe(false)
  })
})
