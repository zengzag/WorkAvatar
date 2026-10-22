import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// 单测不依赖真实 OS 沙箱：confine 透传，删除通道策略在沙箱之前生效
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
          facts: { mode: input.mode, backend: 'none', enforcement: 'full', denied: false },
          cleanup: () => {},
        }),
      }),
    },
  }
})
import { shellExecTool, DELETION_FORBIDDEN_HINT } from '../../../electron/main/services/agent/tools/shell-exec.tool'
import { fileDeleteTool, residentFileTools } from '../../../electron/main/services/agent/tools/fs-tools'
import { allBuiltinTools } from '../../../electron/main/services/agent/tools/index'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'

/**
 * 删除通道策略：删除一律走 file_delete 工具，
 * shell_exec 中的删除命令与删除脚本被硬拒绝（不受高权限模式影响）。
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

  it('写命令不再由文本分析决定：工作区内写入直接执行', async () => {
    const ws = makeTempRoot('wa-write-')
    try {
      const result = await interactionContext.run(
        { sessionId: 'write-1', employeeId: 'e1', workspacePath: ws } as never,
        () => runShell('Set-Content a.txt -Value x', ws),
      )
      expect(result.error || '').not.toContain('file_delete')
      expect(result.success, result.error).toBe(true)
      expect(fs.existsSync(path.join(ws, 'a.txt'))).toBe(true)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
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

  it('工具以常驻工具注册，描述覆盖回收站与递归删除边界', () => {
    expect(fileDeleteTool.id).toBe('file_delete')
    expect(fileDeleteTool.onDemand).toBeFalsy()
    expect(fileDeleteTool.description).toContain('trash')
    expect(fileDeleteTool.description).toContain('recursive')
    expect(DELETION_FORBIDDEN_HINT).toContain('file_delete')
  })

  it('已挂入常驻文件工具与内置工具注册表（file_edit 已并入常驻 files_edit）', () => {
    expect(residentFileTools.map(t => t.id)).toContain('file_delete')
    expect(residentFileTools.map(t => t.id)).toContain('files_edit')
    const registered = allBuiltinTools.find(t => t.id === 'file_delete')
    expect(registered, 'file_delete 未注册进 allBuiltinTools').toBeDefined()
    expect(registered!.onDemand).toBeFalsy()
    expect(allBuiltinTools.some(t => t.id === 'file_edit')).toBe(false)
    expect(allBuiltinTools.find(t => t.id === 'files_edit')!.onDemand).toBeFalsy()
  })
})

describe('file_copy - 复制文件/目录授权', () => {
  let ws: string
  let outside: string

  beforeEach(() => {
    ws = makeTempRoot('wa-cp-ws-')
    outside = makeTempRoot('wa-cp-out-')
  })
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  async function runCopy(args: Record<string, unknown>): Promise<ToolResult> {
    const mod = await import('../../../electron/main/services/agent/tools/fs-tools')
    return mod.fileCopyTool.handler!(args) as Promise<ToolResult>
  }

  it('工作区内复制文件成功（相对路径按工作区解析）', async () => {
    const src = path.join(ws, 'a.txt')
    fs.writeFileSync(src, 'hello')
    const result = await withEmployeeWorkspace(ws, () => runCopy({ source: 'a.txt', destination: 'out/b.txt' }))
    expect(result.success, result.error).toBe(true)
    expect(fs.readFileSync(path.join(ws, 'out', 'b.txt'), 'utf-8')).toBe('hello')
  })

  it('目标为已存在目录时按源文件名复制进去', async () => {
    const src = path.join(ws, 'report.md')
    fs.writeFileSync(src, 'x')
    fs.mkdirSync(path.join(ws, 'dist'))
    const result = await withEmployeeWorkspace(ws, () => runCopy({ source: 'report.md', destination: 'dist' }))
    expect(result.success, result.error).toBe(true)
    expect(fs.existsSync(path.join(ws, 'dist', 'report.md'))).toBe(true)
  })

  it('目标已存在且未传 overwrite 时拒绝，传 overwrite 才覆盖', async () => {
    const src = path.join(ws, 'src.txt')
    const dst = path.join(ws, 'dst.txt')
    fs.writeFileSync(src, 'new')
    fs.writeFileSync(dst, 'old')

    const refused = await withEmployeeWorkspace(ws, () => runCopy({ source: 'src.txt', destination: 'dst.txt' }))
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('目标已存在')
    expect(fs.readFileSync(dst, 'utf-8')).toBe('old')

    const overwritten = await withEmployeeWorkspace(ws, () => runCopy({ source: 'src.txt', destination: 'dst.txt', overwrite: true }))
    expect(overwritten.success, overwritten.error).toBe(true)
    expect(fs.readFileSync(dst, 'utf-8')).toBe('new')
  })

  it('复制目录（递归）到新路径，并保留子目录结构', async () => {
    fs.mkdirSync(path.join(ws, 'pkg', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'pkg', 'a.txt'), 'A')
    fs.writeFileSync(path.join(ws, 'pkg', 'sub', 'b.txt'), 'B')
    const result = await withEmployeeWorkspace(ws, () => runCopy({ source: 'pkg', destination: 'dist/pkg-copy' }))
    expect(result.success, result.error).toBe(true)
    expect(result.output).toContain('已复制目录')
    expect(fs.readFileSync(path.join(ws, 'dist', 'pkg-copy', 'a.txt'), 'utf-8')).toBe('A')
    expect(fs.readFileSync(path.join(ws, 'dist', 'pkg-copy', 'sub', 'b.txt'), 'utf-8')).toBe('B')
  })

  it('目标为已存在目录时按源目录名复制进去', async () => {
    fs.mkdirSync(path.join(ws, 'pkg'))
    fs.writeFileSync(path.join(ws, 'pkg', 'a.txt'), 'A')
    fs.mkdirSync(path.join(ws, 'out'))
    const result = await withEmployeeWorkspace(ws, () => runCopy({ source: 'pkg', destination: 'out' }))
    expect(result.success, result.error).toBe(true)
    expect(fs.readFileSync(path.join(ws, 'out', 'pkg', 'a.txt'), 'utf-8')).toBe('A')
  })

  it('overwrite=true 整体替换已存在的目标目录', async () => {
    fs.mkdirSync(path.join(ws, 'pkg'))
    fs.writeFileSync(path.join(ws, 'pkg', 'new.txt'), 'new')
    fs.mkdirSync(path.join(ws, 'out', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(ws, 'out', 'pkg', 'old.txt'), 'old')

    const refused = await withEmployeeWorkspace(ws, () => runCopy({ source: 'pkg', destination: 'out' }))
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('目标已存在')
    expect(fs.existsSync(path.join(ws, 'out', 'pkg', 'old.txt'))).toBe(true)

    const replaced = await withEmployeeWorkspace(ws, () => runCopy({ source: 'pkg', destination: 'out', overwrite: true }))
    expect(replaced.success, replaced.error).toBe(true)
    expect(fs.readFileSync(path.join(ws, 'out', 'pkg', 'new.txt'), 'utf-8')).toBe('new')
    expect(fs.existsSync(path.join(ws, 'out', 'pkg', 'old.txt'))).toBe(false)
  })

  it('源不存在、目录复制到自身/子目录、文件源与目标相同分别报错', async () => {
    const missing = await withEmployeeWorkspace(ws, () => runCopy({ source: 'nope.txt', destination: 'x.txt' }))
    expect(missing.success).toBe(false)
    expect(missing.error).toContain('源路径不存在')

    fs.mkdirSync(path.join(ws, 'pkg'))
    const inner = await withEmployeeWorkspace(ws, () => runCopy({ source: 'pkg', destination: 'pkg/inner' }))
    expect(inner.success).toBe(false)
    expect(inner.error).toContain('子目录')

    fs.writeFileSync(path.join(ws, 'same.txt'), 'x')
    const same = await withEmployeeWorkspace(ws, () => runCopy({ source: 'same.txt', destination: 'same.txt' }))
    expect(same.success).toBe(false)
    expect(same.error).toContain('相同')
  })

  it('复制到工作区外在无交互上下文时拒绝且不产生文件', async () => {
    const src = path.join(ws, 'a.txt')
    fs.writeFileSync(src, 'x')
    const result = await runCopy({ source: src, destination: path.join(outside, 'a.txt') })
    expect(result.success).toBe(false)
    expect(result.error).toContain('无交互上下文')
    expect(fs.existsSync(path.join(outside, 'a.txt'))).toBe(false)
  })
})

