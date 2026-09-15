import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'
import { shellExecTool } from '../../../electron/main/services/agent/tools/shell-exec.tool'
import { javascriptExecTool } from '../../../electron/main/services/agent/tools/javascript-exec.tool'

/**
 * shell_exec / javascript_exec 的非安全分支覆盖
 * （删除禁令见 deletion-policy.test.ts，危险模式见 shell-exec-dangerous.test.ts，沙箱逃逸见 javascript-sandbox-escape.test.ts）。
 */

type ToolResult = { success: boolean; output?: any; error?: string; stdout?: string; stderr?: string }

const shell = (args: any): Promise<ToolResult> => shellExecTool.handler!(args) as Promise<ToolResult>
const jsExec = (args: any): Promise<ToolResult> => javascriptExecTool.handler!(args) as Promise<ToolResult>

function withWorkspace<T>(ws: string, fn: () => Promise<T>, sessionId = 'exec-branch'): Promise<T> {
  return interactionContext.run(
    { sessionId, employeeId: 'e1', workspacePath: ws } as never,
    async () => fn(),
  ) as Promise<T>
}

describe('agent/tools/shell-exec / 参数校验与输出组装', () => {
  let dir: string

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sh-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('command 为空且无 stdin 时报错并给出解释器提示', async () => {
    const res = await shell({ command: '' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('command 不能为空（stdin_content 存在时 command 仍需指定解释器，如 python -）')
  })

  it('危险模式（不可逆破坏类）在参数阶段被拦截', async () => {
    for (const command of ['shutdown /r /t 0', 'format C: /q', 'diskpart', 'dd if=/dev/zero of=/dev/sda']) {
      const res = await shell({ command })
      expect(res.success, command).toBe(false)
      expect(res.error).toContain('命令被安全策略拦截')
    }
  })

  it('成功执行：输出含 exit_code 元信息与 stdout 段', async () => {
    const res = await shell({ command: 'node -e "console.log(\'SHELL-OK\')"', working_dir: dir, timeout: 20 })
    expect(res.success, res.error).toBe(true)
    expect(String(res.output)).toContain('exit_code=0')
    expect(String(res.output)).toContain('### stdout')
    expect(String(res.output)).toContain('SHELL-OK')
    expect(res.stdout).toContain('SHELL-OK')
  }, 30000)

  it('working_dir 生效为命令的工作目录', async () => {
    const res = await shell({ command: 'node -e "console.log(process.cwd())"', working_dir: dir, timeout: 20 })
    expect(res.success, res.error).toBe(true)
    expect(res.stdout?.trim()).toBe(dir)
  }, 30000)

  it('非零退出码：失败结果带结构化上下文与 stderr 全文', async () => {
    const res = await shell({
      command: 'node -e "console.error(\'ERR-LINE\'); process.exit(7)"',
      working_dir: dir,
      timeout: 20,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('命令执行失败（exit_code=7）')
    expect(String(res.output)).toContain('## 命令执行失败上下文')
    expect(String(res.output)).toContain('- **退出码**: 7')
    expect(String(res.output)).toContain('ERR-LINE')
    expect(res.stderr).toContain('ERR-LINE')
  }, 30000)

  it('成功但 stderr 有内容时仍标记为警告段', async () => {
    const res = await shell({
      command: 'node -e "console.log(\'ok\'); console.error(\'warn-only\')"',
      working_dir: dir,
      timeout: 20,
    })
    expect(res.success).toBe(true)
    expect(String(res.output)).toContain('### stderr (警告/提示)')
  }, 30000)

  it('命令无任何输出时给出占位说明', async () => {
    const res = await shell({ command: 'node -e "void 0"', working_dir: dir, timeout: 20 })
    expect(res.success, res.error).toBe(true)
    expect(String(res.output)).toContain('(命令执行完成，stdout 与 stderr 均为空)')
  }, 30000)

  it('工具元信息：常驻、310s 超时、command 必填', () => {
    expect(shellExecTool.id).toBe('shell_exec')
    expect(shellExecTool.onDemand).toBe(false)
    expect(shellExecTool.timeoutMs).toBe(310000)
    expect(shellExecTool.parameters.required).toEqual(['command'])
  })
})

describe('agent/tools/javascript-exec / 参数与错误分支', () => {
  let dir: string

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-js-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('未提供 code / code_file 时报错', async () => {
    const res = await jsExec({ working_dir: dir })
    expect(res.success).toBe(false)
    expect(res.error).toBe('请提供 code 或 code_file 参数')
  })

  it('code 为空白同样视为未提供', async () => {
    const res = await jsExec({ code: '   ', working_dir: dir })
    expect(res.success).toBe(false)
    expect(res.error).toBe('请提供 code 或 code_file 参数')
  })

  it('code_file 不存在 / 是目录 / 内容为空分别报错', async () => {
    const missing = await jsExec({ code_file: path.join(dir, 'nope.js'), working_dir: dir })
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('代码文件不存在')

    const asDir = await jsExec({ code_file: dir, working_dir: dir })
    expect(asDir.success).toBe(false)
    expect(asDir.error).toContain('路径不是文件')

    const emptyFile = path.join(dir, 'empty.js')
    fs.writeFileSync(emptyFile, '   \n  ', 'utf-8')
    const empty = await jsExec({ code_file: emptyFile, working_dir: dir })
    expect(empty.success).toBe(false)
    expect(empty.error).toBe('代码文件内容为空')
  })

  it('code_file 优先于 code', async () => {
    const file = path.join(dir, 'prefer.js')
    fs.writeFileSync(file, 'console.log("FROM-FILE")', 'utf-8')
    const res = await jsExec({ code: 'console.log("FROM-CODE")', code_file: file, working_dir: dir })
    expect(res.success, res.error).toBe(true)
    expect(String(res.output)).toContain('FROM-FILE')
    expect(String(res.output)).not.toContain('FROM-CODE')
  })

  it('语法错误在执行前返回，带行号与修复建议', async () => {
    const res = await jsExec({ code: 'const a = ;', working_dir: dir })
    expect(res.success).toBe(false)
    expect(res.error).toContain('语法错误（未执行）：')
    expect(res.error).toContain('位置: 第 1 行')
    expect(res.error).toContain('代码上下文：')
    expect(res.error).toContain('修复建议:')
  })

  it('成功执行：输出成功标记与 stdout 段', async () => {
    const res = await jsExec({ code: 'console.log("JS-OK", 1 + 1)', working_dir: dir })
    expect(res.success, res.error).toBe(true)
    expect(String(res.output)).toContain('[javascript_exec] 执行成功')
    expect(String(res.output)).toContain('--- stdout ---')
    expect(String(res.output)).toContain('JS-OK 2')
  })

  it('运行时错误：返回失败标记与错误信息', async () => {
    const res = await jsExec({ code: 'console.log("before"); throw new Error("runtime-boom")', working_dir: dir })
    expect(res.success).toBe(false)
    expect(res.error).toContain('runtime-boom')
    expect(String(res.output)).toContain('[javascript_exec] 执行失败')
    expect(String(res.output)).toContain('before')
  })

  it('未注入的模块（os）被拒绝并给出可用模块清单', async () => {
    const res = await jsExec({ code: 'const os = require("os"); console.log(os.hostname())', working_dir: dir })
    expect(res.success).toBe(false)
    expect(res.error).toContain('Module "os" is not available')
    expect(res.error).toContain('Available modules:')
  })

  it('时区/异步超时：未在超时内完成的代码被中断', async () => {
    const res = await jsExec({ code: 'await new Promise(r => setTimeout(r, 5000))', working_dir: dir, timeout: 1 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('执行超时')
  }, 20000)

  it('工作区外敏感环境变量不暴露给沙箱', async () => {
    process.env.WA_FAKE_SECRET = 'TOP-SECRET-VALUE'
    try {
      const res = await jsExec({
        code: 'console.log("SECRET=" + typeof process.env.WA_FAKE_SECRET); console.log("PATH=" + (typeof process.env.PATH))',
        working_dir: dir,
      })
      expect(String(res.output)).toContain('SECRET=undefined')
      expect(String(res.output)).toContain('PATH=string')
    } finally {
      delete process.env.WA_FAKE_SECRET
    }
  })

  it('file.save 在工作区内可直接写入（父目录需先用 createFolder 建）', async () => {
    await withWorkspace(dir, async () => {
      const res = await jsExec({
        code: 'await file.createFolder("out")\nawait file.save("out/ok.txt", "hi")\nconsole.log("SAVED")',
        working_dir: dir,
      })
      expect(res.success, res.error).toBe(true)
      expect(fs.readFileSync(path.join(dir, 'out', 'ok.txt'), 'utf-8')).toBe('hi')
    })
  })

  it('file.exists 可判断工作区内文件是否存在', async () => {
    fs.writeFileSync(path.join(dir, 'there.txt'), 'x', 'utf-8')
    await withWorkspace(dir, async () => {
      const res = await jsExec({
        code: 'console.log("THERE=" + file.exists("there.txt")); console.log("NOWHERE=" + file.exists("nope.txt"))',
        working_dir: dir,
      })
      expect(String(res.output)).toContain('THERE=true')
      expect(String(res.output)).toContain('NOWHERE=false')
    })
  })

  it('工具元信息：按需、无必填参数、310s 超时', () => {
    expect(javascriptExecTool.id).toBe('javascript_exec')
    expect(javascriptExecTool.onDemand).toBe(true)
    expect(javascriptExecTool.timeoutMs).toBe(310000)
    expect(javascriptExecTool.parameters.required).toEqual([])
  })
})
