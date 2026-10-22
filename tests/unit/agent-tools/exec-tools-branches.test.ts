import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// 单测不依赖真实 OS 沙箱：confine 透传，保留纯函数；facts 可由用例改写以覆盖沙箱分支
const sandboxFacts = vi.hoisted(() => ({
  current: { mode: 'workspace-write', backend: 'none', enforcement: 'full', denied: false } as Record<string, unknown>,
}))
vi.mock('../../../electron/main/services/sandbox.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/main/services/sandbox.service')>()
  return {
    ...actual,
    default: {
      getInstance: () => ({
        confine: (input: any) => ({
          program: input.program,
          args: [...input.args],
          env: {},
          facts: { ...sandboxFacts.current, mode: input.mode },
          cleanup: () => {},
        }),
      }),
    },
  }
})
import { shellExecTool } from '../../../electron/main/services/agent/tools/shell-exec.tool'
import UnifiedInteractionService, { interactionContext } from '../../../electron/main/services/unified-interaction.service'

/**
 * shell_exec 的非安全分支覆盖
 * （删除禁令见 deletion-policy.test.ts，危险模式见 shell-exec-dangerous.test.ts）。
 */

type ToolResult = { success: boolean; output?: any; error?: string; stdout?: string; stderr?: string }

const shell = (args: any): Promise<ToolResult> => shellExecTool.handler!(args) as Promise<ToolResult>

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
    expect(Object.keys(shellExecTool.parameters.properties)).toContain('full_access')
  })
})

describe('agent/tools/shell-exec / 沙箱分支', () => {
  let dir: string
  const defaultFacts = { mode: 'workspace-write', backend: 'none', enforcement: 'full', denied: false }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-'))
    sandboxFacts.current = { ...defaultFacts, backend: 'windows-acl', enforcement: 'partial' }
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    sandboxFacts.current = defaultFacts
  })

  it('元信息标注沙箱后端与模式', async () => {
    const res = await shell({ command: 'node -e "console.log(\'META\')"', working_dir: dir, timeout: 20 })
    expect(res.success, res.error).toBe(true)
    expect(String(res.output)).toContain('sandbox=windows-acl/workspace-write')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('越界写入被拒：返回沙箱说明并引导 file_copy', async () => {
    const res = await shell({
      command: 'node -e "console.error(\'ERROR: Access to the path is denied.\'); process.exit(1)"',
      working_dir: dir,
      timeout: 20,
    })
    expect(res.success).toBe(false)
    expect(res.error).toBe('命令尝试写入工作区外，已被文件沙箱拒绝')
    expect(String(res.output)).toContain('file_copy')
  }, 30000)

  it.skipIf(process.platform !== 'win32')('运行器故障优先于拒绝判定：不误报为越界写入', async () => {
    const res = await shell({
      command: 'node -e "console.error(\'workavatar-sandbox: GetNamedSecurityInfoW failed (Win32 5): Access is denied.\'); process.exit(127)"',
      working_dir: dir,
      timeout: 20,
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('沙箱运行器故障')
    expect(String(res.output)).toContain('命令未执行')
  }, 30000)
})

describe('agent/tools/shell-exec / full_access 临时提权', () => {
  let dir: string

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hp-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function spyRequest(response: Record<string, unknown>) {
    return vi.spyOn(UnifiedInteractionService.getInstance(), 'request').mockResolvedValue(response as never)
  }

  it('无交互上下文时拒绝执行', async () => {
    const res = await shell({ command: 'node -e "void 0"', working_dir: dir, full_access: true })
    expect(res.success).toBe(false)
    expect(res.error).toContain('无交互上下文')
  })

  it('用户确认后以完整访问执行，且弹窗只针对本次命令', async () => {
    const spy = spyRequest({ id: '', confirmed: true, cancelled: false })
    try {
      const res = await interactionContext.run(
        { sessionId: 'hp-1', employeeId: 'e1', workspacePath: dir, highPermission: false } as never,
        () => shell({ command: 'node -e "console.log(\'ELEVATED\')"', working_dir: dir, full_access: true }),
      )
      expect(res.success, res.error).toBe(true)
      expect(String(res.output)).toContain('ELEVATED')
      expect(String(res.output)).toContain('sandbox=full-access')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toMatchObject({
        source: 'security:sandbox_elevation',
        forced: true,
        type: 'confirm',
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('用户拒绝时命令不执行', async () => {
    const spy = spyRequest({ id: '', confirmed: false, cancelled: true })
    try {
      const res = await interactionContext.run(
        { sessionId: 'hp-2', employeeId: 'e1', workspacePath: dir, highPermission: false } as never,
        () => shell({ command: 'node -e "console.log(\'SHOULD-NOT-RUN\')"', working_dir: dir, full_access: true }),
      )
      expect(res.success).toBe(false)
      expect(res.error).toContain('未授权')
      expect(String(res.output || '')).not.toContain('SHOULD-NOT-RUN')
    } finally {
      spy.mockRestore()
    }
  })

  it('高权限模式下已是完整访问，不再弹窗', async () => {
    const spy = spyRequest({ id: '', confirmed: false, cancelled: true })
    try {
      const res = await interactionContext.run(
        { sessionId: 'hp-3', employeeId: 'e1', workspacePath: dir, highPermission: true } as never,
        () => shell({ command: 'node -e "console.log(\'FULL\')"', working_dir: dir, full_access: true }),
      )
      expect(res.success, res.error).toBe(true)
      expect(String(res.output)).toContain('FULL')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
