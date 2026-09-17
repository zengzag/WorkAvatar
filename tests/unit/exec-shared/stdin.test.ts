import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 二次审核回归：runCommandPlatform 的 stdin 关闭语义。
 *
 * 修复点：无 stdin 内容时显式 `child.stdin.end()`。
 * - 若不关闭，读取 stdin 的命令会一直等待直到超时被杀（表现为"命令卡住"）。
 * - 需同时确认：对「立即退出」的命令 end() stdin 不会触发未处理的 EPIPE 错误导致进程崩溃。
 *
 * 说明：脚本写到临时文件再 `node <file>` 执行，规避 PowerShell 5.1
 * 向原生命令传参时对内层引号的错误转义（这正是 shell_exec 工具注释里提到的引号地狱）。
 * vitest 的 node 环境 PATH 可能缺少 Windows PowerShell 目录，需在导入前补齐。
 */
const IS_WINDOWS = process.platform === 'win32'

if (IS_WINDOWS && !process.env.PATH?.includes('WindowsPowerShell')) {
  process.env.PATH = `C:\\Windows\\System32\\WindowsPowerShell\\v1.0;${process.env.PATH || ''}`
}

const powershellAvailable = (): boolean => {
  if (!IS_WINDOWS) return true
  return fs.existsSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
}

const tempCwd = (): string => os.tmpdir()

/** 写一个临时 node 脚本并返回调用命令（路径不含空格，无需引号） */
function writeScript(name: string, code: string): string {
  const file = path.join(tempCwd(), `wa-stdin-${name}-${process.pid}.js`)
  fs.writeFileSync(file, code, 'utf-8')
  return `node ${file}`
}

describe.skipIf(!powershellAvailable())('runCommandPlatform stdin 语义', () => {
  it('无 stdin 内容时命令应立即收到 EOF 而非挂起（修复点）', async () => {
    const { runCommandPlatform } = await import('../../../electron/main/services/agent/tools/exec-shared')
    const command = writeScript('wait', `
let got = false
// resume() 启动流动模式：只挂 end 监听不消费流时 end 事件不会触发
process.stdin.resume()
process.stdin.on('end', () => { got = true; console.log('GOT_EOF') })
setTimeout(() => { if (!got) { console.log('NO_EOF'); process.exit(3) } }, 3000)
`)
    try {
      const res = await runCommandPlatform(command, { cwd: tempCwd(), timeoutMs: 10000 })
      // 若 stdin 未关闭，脚本 3s 后输出 NO_EOF 并以退出码 3 结束
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('GOT_EOF')
      expect(res.stdout).not.toContain('NO_EOF')
    } finally {
      fs.rmSync(command.replace(/^node /, ''), { force: true })
    }
  }, 20000)

  it('提供 stdin 内容时内容仍正常送达（原路径不受影响）', async () => {
    const { runCommandPlatform } = await import('../../../electron/main/services/agent/tools/exec-shared')
    let command: string
    let scriptPath: string | undefined
    if (IS_WINDOWS) {
      command = writeScript('read', `
let d = ''
process.stdin.on('data', c => d += c)
process.stdin.on('end', () => console.log('ECHO:' + d.trim()))
`)
      scriptPath = command.replace(/^node /, '')
    } else {
      command = 'cat'
    }
    try {
      const res = await runCommandPlatform(command, {
        cwd: tempCwd(),
        timeoutMs: 10000,
        stdinContent: 'hello-stdin',
      })
      expect(res.code).toBe(0)
      expect(res.stdout).toContain('ECHO:hello-stdin')
    } finally {
      if (scriptPath) fs.rmSync(scriptPath, { force: true })
    }
  }, 20000)

  it('快速退出的命令上关闭 stdin 不产生未处理错误（EPIPE 安全）', async () => {
    const uncaught: string[] = []
    const onUncaught = (err: Error) => { uncaught.push(String(err?.message || err)) }
    process.on('uncaughtException', onUncaught)
    try {
      const { runCommandPlatform } = await import('../../../electron/main/services/agent/tools/exec-shared')
      for (let i = 0; i < 8; i++) {
        const res = await runCommandPlatform('echo ok', { cwd: tempCwd(), timeoutMs: 8000 })
        expect(res.code).toBe(0)
        expect(res.stdout).toContain('ok')
      }
      // 让可能异步到达的 error 事件有时间触发
      await new Promise(r => setTimeout(r, 300))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  }, 40000)
})

/**
 * 端到端：经 shell_exec 工具的 heredoc 路径验证 stdin 内容可达命令。
 * 该路径此前在 Windows 上被 `$input | & { ... }` 包装吞掉 stdin（LEN=0），属既有缺陷。
 */
describe.skipIf(!powershellAvailable())('shell_exec heredoc 端到端', () => {
  it('heredoc 内容应作为 stdin 送达命令', async () => {
    const { shellExecTool } = await import('../../../electron/main/services/agent/tools/shell-exec.tool')
    const command = writeScript('e2e-read', `
let d = ''
process.stdin.on('data', c => d += c)
process.stdin.on('end', () => console.log('ECHO:' + d.trim()))
`)
    const scriptPath = command.replace(/^node /, '')
    const heredoc = `${command} <<EOF
hello-heredoc
EOF`
    try {
      const res: any = await shellExecTool.handler({ command: heredoc, timeout: 20 })
      expect(res.success).toBe(true)
      expect(String(res.output)).toContain('ECHO:hello-heredoc')
    } finally {
      fs.rmSync(scriptPath, { force: true })
    }
  }, 30000)

  it('stdin_content 参数应作为 stdin 送达命令', async () => {
    const { shellExecTool } = await import('../../../electron/main/services/agent/tools/shell-exec.tool')
    const command = writeScript('e2e-stdin', `
let d = ''
process.stdin.on('data', c => d += c)
process.stdin.on('end', () => console.log('ECHO:' + d.trim()))
`)
    const scriptPath = command.replace(/^node /, '')
    try {
      const res: any = await shellExecTool.handler({
        command,
        stdin_content: 'hello-via-stdin-content',
        timeout: 20,
      })
      expect(res.success).toBe(true)
      expect(String(res.output)).toContain('ECHO:hello-via-stdin-content')
    } finally {
      fs.rmSync(scriptPath, { force: true })
    }
  }, 30000)
})
