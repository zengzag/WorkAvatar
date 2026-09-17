import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { shellExecTool, DELETION_FORBIDDEN_HINT } from '../../../electron/main/services/agent/tools/shell-exec.tool'
import { fileDeleteTool, residentFileTools } from '../../../electron/main/services/agent/tools/fs-tools'
import { allBuiltinTools } from '../../../electron/main/services/agent/tools/index'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'

/**
 * 删除通道策略：删除一律走 file_delete 工具，
 * shell_exec / javascript_exec 中的删除命令与删除脚本被硬拒绝（不受高权限模式影响）。
 */

function makeTempRoot(prefix = 'wa-del-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

type ToolResult = { success: boolean; output?: string; error?: string }

async function runShell(command: string, workingDir?: string): Promise<ToolResult> {
  return shellExecTool.handler!({ command, working_dir: workingDir, timeout: 10 } as never) as Promise<ToolResult>
}

async function runDelete(args: Record<string, unknown>): Promise<ToolResult> {
  return fileDeleteTool.handler!(args) as Promise<ToolResult>
}

function withEmployeeWorkspace<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  return interactionContext.run(
    { sessionId: 'del-1', employeeId: 'e1', workspacePath: ws } as never,
    fn,
  )
}

describe('shell_exec - 删除命令硬拒绝', () => {
  const deletionCommands = [
    'Remove-Item "page-*.png" -ErrorAction SilentlyContinue; cmd /c dir /b',
    'rm -rf build',
    'del /q /f *.tmp',
    'rd /s /q build',
    'python -c "import os; os.remove(\'a.txt\')"',
    'node -e "require(\'fs\').unlinkSync(\'a.txt\')"',
  ]

  for (const command of deletionCommands) {
    it(`拒绝: ${command}`, async () => {
      const result = await runShell(command)
      expect(result.success).toBe(false)
      expect(result.error).toContain('file_delete')
    })
  }

  it('stdin_content 正文中的删除同样被拒绝', async () => {
    const result = await shellExecTool.handler!({
      command: 'python -',
      stdin_content: 'import shutil\nshutil.rmtree("build")\n',
      timeout: 10,
    } as never) as ToolResult
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
  })

  it('高权限模式不能绕过删除禁令', async () => {
    const result = await interactionContext.run(
      { sessionId: 'del-hp', employeeId: 'e1', workspacePath: makeTempRoot(), highPermission: true } as never,
      () => runShell('rm -rf build'),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
  })

  it('写命令不受删除禁令影响（区外无交互上下文时按原逻辑拒绝）', async () => {
    const result = await runShell('Set-Content a.txt -Value x')
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(result.error).not.toContain('file_delete')
  })
})

describe('shell_exec - 被执行脚本文件的删除检测', () => {
  let dir: string

  beforeEach(() => { dir = makeTempRoot('wa-script-') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('脚本内含删除原语 → 拒绝执行并指出脚本路径', async () => {
    fs.writeFileSync(path.join(dir, 'cleanup.py'), 'import shutil\nshutil.rmtree("build")\n', 'utf-8')
    const result = await runShell('python cleanup.py', dir)
    expect(result.success).toBe(false)
    expect(result.error).toContain('cleanup.py')
    expect(result.error).toContain('file_delete')
  })

  it('检测依据脚本内容而非文件名：无删除逻辑的脚本不会被删除禁令拦截', async () => {
    // 不存在的脚本：扫描跳过 → 进入正常执行流程（python 报文件不存在），错误中不含删除禁令
    const result = await runShell('python no_such_script.py', dir)
    expect(result.error || '').not.toContain('file_delete')
  })

  it('未被执行的文件（非解释器段）不会被扫描', async () => {
    fs.writeFileSync(path.join(dir, 'victim.py'), 'import shutil\nshutil.rmtree("x")\n', 'utf-8')
    // 只是提交/查看该文件，并未执行它
    const result = await runShell('git add victim.py', dir)
    expect(result.error || '').not.toContain('file_delete')
  })
})

describe('file_delete 工具', () => {
  let ws: string
  let outside: string

  beforeEach(() => {
    ws = makeTempRoot('wa-fd-ws-')
    outside = makeTempRoot('wa-fd-out-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('删除工作区内文件（相对路径按工作区解析）', async () => {
    fs.mkdirSync(path.join(ws, 'sub'))
    fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'x')
    const result = await withEmployeeWorkspace(ws, () => runDelete({ path: 'sub/a.txt' }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(ws, 'sub', 'a.txt'))).toBe(false)
    expect(result.output).toContain('已删除')
  })

  it('目录需显式 recursive=true，非空目录未传时报错且不删除', async () => {
    fs.mkdirSync(path.join(ws, 'build'))
    fs.writeFileSync(path.join(ws, 'build', 'out.txt'), 'x')

    const refused = await withEmployeeWorkspace(ws, () => runDelete({ path: path.join(ws, 'build') }))
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('recursive=true')
    expect(fs.existsSync(path.join(ws, 'build', 'out.txt'))).toBe(true)

    const removed = await withEmployeeWorkspace(ws, () => runDelete({ path: path.join(ws, 'build'), recursive: true }))
    expect(removed.success, removed.error).toBe(true)
    expect(fs.existsSync(path.join(ws, 'build'))).toBe(false)
  })

  it('禁止删除盘根与工作区根目录', async () => {
    const fsRoot = path.parse(ws).root
    const rootRefused = await withEmployeeWorkspace(ws, () => runDelete({ path: fsRoot }))
    expect(rootRefused.success).toBe(false)
    expect(rootRefused.error).toContain('盘根')

    const wsRefused = await withEmployeeWorkspace(ws, () => runDelete({ path: ws }))
    expect(wsRefused.success).toBe(false)
    expect(wsRefused.error).toContain('工作区根目录')
    expect(fs.existsSync(ws)).toBe(true)
  })

  it('路径不存在时报错', async () => {
    const result = await withEmployeeWorkspace(ws, () => runDelete({ path: path.join(ws, 'nope.txt') }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('工作区外删除在无交互上下文时拒绝且文件保留', async () => {
    const target = path.join(outside, 'keep.txt')
    fs.writeFileSync(target, 'x')
    const result = await runDelete({ path: target })
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('空路径报错', async () => {
    const result = await runDelete({ path: '   ' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('不能为空')
  })

  it('paths 列表批量删除多个文件', async () => {
    const a = path.join(ws, 'a.txt')
    const b = path.join(ws, 'sub', 'b.txt')
    const keep = path.join(ws, 'keep.txt')
    fs.mkdirSync(path.join(ws, 'sub'))
    fs.writeFileSync(a, 'x')
    fs.writeFileSync(b, 'x')
    fs.writeFileSync(keep, 'x')
    const result = await withEmployeeWorkspace(ws, () => runDelete({ paths: [a, 'sub/b.txt'] }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(a)).toBe(false)
    expect(fs.existsSync(b)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('通配路径 * 按匹配到的真实路径批量删除', async () => {
    const t1 = path.join(ws, 'tmp1.log')
    const t2 = path.join(ws, 'tmp2.log')
    const keep = path.join(ws, 'keep.log')
    fs.writeFileSync(t1, 'x')
    fs.writeFileSync(t2, 'x')
    fs.writeFileSync(keep, 'x')
    const result = await withEmployeeWorkspace(ws, () => runDelete({ path: path.join(ws, 'tmp*.log') }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(t1)).toBe(false)
    expect(fs.existsSync(t2)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('通配 ** 与 ? 混用可跨目录匹配', async () => {
    fs.mkdirSync(path.join(ws, 'd1'))
    fs.mkdirSync(path.join(ws, 'd1', 'd2'))
    const f1 = path.join(ws, 'd1', 'c1.txt')
    const f2 = path.join(ws, 'd1', 'd2', 'c2.txt')
    const keep = path.join(ws, 'd1', 'deep.txt')
    fs.writeFileSync(f1, 'x')
    fs.writeFileSync(f2, 'x')
    fs.writeFileSync(keep, 'x')
    const result = await withEmployeeWorkspace(ws, () => runDelete({ paths: ['d1/**/c?.txt'] }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(f1)).toBe(false)
    expect(fs.existsSync(f2)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('通配路径展开为区外真实路径时按真实路径做权限判定（无交互上下文拒绝且文件保留）', async () => {
    const t1 = path.join(outside, 'tmp1.dat')
    const t2 = path.join(outside, 'tmp2.dat')
    fs.writeFileSync(t1, 'x')
    fs.writeFileSync(t2, 'x')
    const result = await runDelete({ path: path.join(outside, 'tmp*.dat') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(fs.existsSync(t1)).toBe(true)
    expect(fs.existsSync(t2)).toBe(true)
  })

  it('通配未匹配到任何文件时报错', async () => {
    const result = await withEmployeeWorkspace(ws, () => runDelete({ path: path.join(ws, 'none-*.xyz') }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('未匹配到任何文件')
  })

  it('批量混合时被拒目标跳过、其余正常删除并在输出中说明', async () => {
    const ok = path.join(ws, 'ok.txt')
    const missing = path.join(ws, 'missing.txt')
    const nope = path.join(ws, 'none-*.xyz')
    fs.writeFileSync(ok, 'x')
    const result = await withEmployeeWorkspace(ws, () => runDelete({ paths: [ok, missing, nope] }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(ok)).toBe(false)
    expect(result.output).toContain('路径不存在')
    expect(result.output).toContain('未匹配到文件的通配路径')
  })

  it('工具以常驻工具注册，描述中声明删除通道唯一', () => {
    expect(fileDeleteTool.id).toBe('file_delete')
    expect(fileDeleteTool.onDemand).toBeFalsy()
    expect(fileDeleteTool.description).toContain('file_delete')
    expect(DELETION_FORBIDDEN_HINT).toContain('file_delete')
  })

  it('已挂入常驻文件工具与内置工具注册表（员工默认 on，非按需）', () => {
    expect(residentFileTools.map(t => t.id)).toContain('file_delete')
    const registered = allBuiltinTools.find(t => t.id === 'file_delete')
    expect(registered, 'file_delete 未注册进 allBuiltinTools').toBeDefined()
    expect(registered!.onDemand).toBeFalsy()
  })
})

describe('javascript_exec - 脚本内删除硬拒绝', () => {
  let ws: string

  beforeEach(() => { ws = makeTempRoot('wa-js-del-') })
  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(ws, { recursive: true, force: true })
  })

  async function runJs(code: string): Promise<ToolResult> {
    const mod = await import('../../../electron/main/services/agent/tools/javascript-exec.tool')
    return mod.javascriptExecTool.handler!({ code, working_dir: ws, timeout: 10 } as never) as Promise<ToolResult>
  }

  it('file.delete 被拒绝并引导使用 file_delete', async () => {
    const target = path.join(ws, 'a.txt')
    fs.writeFileSync(target, 'x')
    const result = await withEmployeeWorkspace(ws, () => runJs(`await file.delete(${JSON.stringify(target)})`))
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('fs 删除原语在预检查阶段被拒绝（不进入沙箱执行）', async () => {
    const target = path.join(ws, 'b.txt')
    fs.writeFileSync(target, 'x')
    const result = await withEmployeeWorkspace(ws, () => runJs(`require('fs').unlinkSync(${JSON.stringify(target)})`))
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('file["delete"] 计算属性写法同样被拒绝', async () => {
    const target = path.join(ws, 'd.txt')
    fs.writeFileSync(target, 'x')
    const result = await withEmployeeWorkspace(ws, () => runJs(`await file["delete"](${JSON.stringify(target)})`))
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('code_file 内容含删除时同样被拒绝', async () => {
    const scriptFile = path.join(ws, 'gen.js')
    const target = path.join(ws, 'c.txt')
    fs.writeFileSync(target, 'x')
    fs.writeFileSync(scriptFile, `await file.delete(${JSON.stringify(target)})\n`, 'utf-8')
    const result = await withEmployeeWorkspace(ws, async () => {
      const mod = await import('../../../electron/main/services/agent/tools/javascript-exec.tool')
      return mod.javascriptExecTool.handler!({ code_file: scriptFile, working_dir: ws, timeout: 10 } as never) as Promise<ToolResult>
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('file_delete')
    expect(fs.existsSync(target)).toBe(true)
  })

  it('纯写入脚本不受影响', async () => {
    const result = await withEmployeeWorkspace(ws, () => runJs('await file.createFolder("out")\nawait file.save("out/ok.txt", "hi")'))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(ws, 'out', 'ok.txt'))).toBe(true)
  })
})
