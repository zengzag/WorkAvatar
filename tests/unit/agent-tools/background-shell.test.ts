import { describe, it, expect, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'
import BackgroundShellService, { type BackgroundShellSnapshot } from '../../../electron/main/services/background-shell.service'
import { shellExecTool } from '../../../electron/main/services/agent/tools/shell-exec.tool'
import { shellOutputTool, shellKillTool } from '../../../electron/main/services/agent/tools/background-shell.tools'

/**
 * 后台终端能力（BackgroundShellService + shell_exec(run_in_background) / shell_output / shell_kill）。
 * 用 `node <脚本>` 执行（临时目录路径无空格，避免 shell 引号差异）。
 */

type ToolResult = { success: boolean; output?: any; error?: string }

const svc = BackgroundShellService.getInstance()
const tempFiles: string[] = []
let scriptSeq = 0

function nodeScript(code: string): string {
  const file = path.join(os.tmpdir(), `wa-bg-${process.pid}-${scriptSeq++}.js`)
  fs.writeFileSync(file, code, 'utf-8')
  tempFiles.push(file)
  return `node ${file}`
}

function makeTemp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function withWorkspace<T>(ws: string, sessionId: string, fn: () => Promise<T> | T, conversationId?: string): Promise<T> {
  return interactionContext.run(
    { sessionId, conversationId, employeeId: 'e1', workspacePath: ws, highPermission: false } as never,
    async () => fn(),
  ) as Promise<T>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待任务离开 running（或进入 running） */
async function waitStatus(id: string, target: 'not-running' | 'running', timeoutMs = 8000): Promise<BackgroundShellSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = svc.list().find(s => s.id === id)
    if (snapshot) {
      if (target === 'not-running' && snapshot.status !== 'running') return snapshot
      if (target === 'running' && snapshot.status === 'running') return snapshot
    }
    await sleep(100)
  }
  throw new Error(`等待任务 ${id} 进入 ${target} 超时`)
}

afterEach(() => {
  svc.disposeAll()
})

afterAll(() => {
  for (const file of tempFiles) {
    try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
  }
})

describe('BackgroundShellService / 启动与读取', () => {
  it('短任务：输出可读、状态转为 exited 并带退出码', async () => {
    const started = svc.start({ command: nodeScript('console.log("BG-OK")'), cwd: os.tmpdir(), ownerKey: 'o-1' })
    expect(started.ok, started.ok ? '' : started.error).toBe(true)
    if (!started.ok) return

    const snapshot = await waitStatus(started.snapshot.id, 'not-running')
    expect(snapshot.status).toBe('exited')
    expect(snapshot.exitCode).toBe(0)

    const read = await svc.read(started.snapshot.id, {})
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.text).toContain('BG-OK')
    expect(read.nextOffset).toBe(snapshot.totalChars)
  })

  it('stderr 与 stdout 合并为单条时间线', async () => {
    const started = svc.start({
      command: nodeScript('console.log("OUT-LINE"); console.error("ERR-LINE")'),
      cwd: os.tmpdir(),
      ownerKey: 'o-2',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    await waitStatus(started.snapshot.id, 'not-running')
    const read = await svc.read(started.snapshot.id, {})
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.text).toContain('OUT-LINE')
    expect(read.text).toContain('ERR-LINE')
  })

  it('增量读取：传入上次 nextOffset 只返回新增输出', async () => {
    const started = svc.start({
      command: nodeScript('let i=0; setInterval(() => console.log("LINE-" + (++i)), 100)'),
      cwd: os.tmpdir(),
      ownerKey: 'o-3',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const id = started.snapshot.id

    // 等待首条输出出现（避免机器负载下固定 sleep 不够），再验证增量读取
    const first = await svc.read(id, { waitMs: 8000 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.text).toContain('LINE-1')

    const second = await svc.read(id, { offset: first.nextOffset, waitMs: 4000 })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.text).toContain('LINE-')
    expect(second.text).not.toContain('LINE-1\n')
    expect(second.nextOffset).toBeGreaterThan(first.nextOffset)
  }, 20000)

  it('waitMs：无新输出时等待，直到有新输出返回', async () => {
    const started = svc.start({
      command: nodeScript('setTimeout(() => console.log("DELAYED-OUT"), 600)'),
      cwd: os.tmpdir(),
      ownerKey: 'o-4',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const read = await svc.read(started.snapshot.id, { waitMs: 5000 })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.text).toContain('DELAYED-OUT')
  })

  it('缓冲区只留尾部：超出上限时 droppedChars 提示开头已淘汰', async () => {
    const started = svc.start({
      command: nodeScript('process.stdout.write("x".repeat(300000))'),
      cwd: os.tmpdir(),
      ownerKey: 'o-5',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const id = started.snapshot.id

    await waitStatus(id, 'not-running')
    const read = await svc.read(id, { offset: 0, maxChars: 1000 })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.snapshot.totalChars).toBe(300000)
    expect(read.snapshot.bufferStart).toBeGreaterThan(0)
    expect(read.droppedChars).toBeGreaterThan(0)
  })

  it('读取不存在的任务时报错', async () => {
    const read = await svc.read('bg_missing')
    expect(read.ok).toBe(false)
    if (read.ok) return
    expect(read.error).toContain('后台任务不存在')
  })
})

describe('BackgroundShellService / 终止与回收', () => {
  it('kill 终止长任务并转为 killed 状态；重复 kill 幂等', async () => {
    const started = svc.start({
      command: nodeScript('setInterval(() => console.log("ALIVE"), 100)'),
      cwd: os.tmpdir(),
      ownerKey: 'k-1',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const id = started.snapshot.id

    const kill = svc.kill(id)
    expect(kill.ok).toBe(true)
    const snapshot = await waitStatus(id, 'not-running')
    expect(snapshot.status).toBe('killed')

    const again = svc.kill(id)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.snapshot.status).toBe('killed')
  })

  it('kill 不存在的任务时报错', () => {
    const result = svc.kill('bg_missing')
    expect(result.ok).toBe(false)
  })

  it('killForOwners 只回收指定属主的任务', async () => {
    const a = svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'owner-a' })
    const b = svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'owner-b' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    const killed = svc.killForOwners(['owner-a'])
    expect(killed).toBeGreaterThanOrEqual(1)
    expect(svc.list('owner-a')).toHaveLength(0)
    expect(svc.list().some(s => s.id === b.snapshot.id)).toBe(true)
  })

  it('同一属主并发运行数达到上限时拒绝启动', async () => {
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const started = svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'owner-cap' })
      expect(started.ok).toBe(true)
      if (started.ok) ids.push(started.snapshot.id)
    }
    const overflow = svc.start({ command: nodeScript('console.log(1)'), cwd: os.tmpdir(), ownerKey: 'owner-cap' })
    expect(overflow.ok).toBe(false)
    if (!overflow.ok) expect(overflow.error).toContain('最多同时运行 8 个后台任务')

    for (const id of ids) svc.kill(id)
  }, 30000)

  it('disposeAll 清空全部任务', async () => {
    svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'owner-d' })
    svc.disposeAll()
    expect(svc.list()).toHaveLength(0)
  })
})

describe('BackgroundShellService / 变化通知（界面刷新）', () => {
  it('启动、终止请求与结束都会通知监听者', async () => {
    let count = 0
    svc.setChangeListener(() => { count++ })
    try {
      const started = svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'n-1' })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      expect(count).toBeGreaterThanOrEqual(1)

      const afterStart = count
      svc.kill(started.snapshot.id)
      expect(count).toBeGreaterThan(afterStart)

      const afterKill = count
      await waitStatus(started.snapshot.id, 'not-running')
      expect(count).toBeGreaterThan(afterKill)
    } finally {
      svc.setChangeListener(() => { /* 复原为空监听，避免影响其他用例 */ })
    }
  })

  it('读取输出不触发通知（避免高频 IPC）', async () => {
    let count = 0
    svc.setChangeListener(() => { count++ })
    try {
      const started = svc.start({ command: nodeScript('console.log("NO-NOTIFY")'), cwd: os.tmpdir(), ownerKey: 'n-2' })
      expect(started.ok).toBe(true)
      if (!started.ok) return
      await waitStatus(started.snapshot.id, 'not-running')

      const before = count
      await svc.read(started.snapshot.id, {})
      await svc.read(started.snapshot.id, { offset: 0 })
      expect(count).toBe(before)
    } finally {
      svc.setChangeListener(() => { /* 复原为空监听 */ })
    }
  })

  it('会话回收（killForOwners）也会通知监听者', () => {
    let count = 0
    svc.setChangeListener(() => { count++ })
    try {
      const started = svc.start({ command: nodeScript('setInterval(() => {}, 1000)'), cwd: os.tmpdir(), ownerKey: 'n-3' })
      expect(started.ok).toBe(true)
      const before = count
      svc.killForOwners(['n-3'])
      expect(count).toBeGreaterThan(before)
    } finally {
      svc.setChangeListener(() => { /* 复原为空监听 */ })
    }
  })
})

describe('agent/tools / shell_exec(run_in_background)', () => {
  it('后台启动返回任务 ID，且不返回前台退出码', async () => {
    // 用系统临时目录作为工作区：长任务持有 cwd 时 Windows 无法删除该目录，避免测试收尾失败
    const cwd = os.tmpdir()
    const res = await withWorkspace(cwd, 'bg-tool-1', async () => {
      const r = await shellExecTool.handler!({
        command: nodeScript('setInterval(() => console.log("TOOL-TICK"), 200)'),
        run_in_background: true,
      }) as ToolResult
      expect(r.success, r.error).toBe(true)
      expect(r.output).toContain('已在后台启动')
      expect(r.output).toContain('shell_output')
      expect(r.output).not.toContain('exit_code')
      return r
    })

    const taskId = String(res.output).match(/任务 ID (bg_[A-Za-z0-9_]+)/)?.[1]
    expect(taskId).toBeTruthy()

    const started = svc.list().find(s => s.id === taskId)
    expect(started?.status).toBe('running')
    expect(started?.cwd).toBe(cwd)
  })

  it('run_in_background 不是严格 true 时走前台执行', async () => {
    const ws = makeTemp('wa-bgws-')
    try {
      await withWorkspace(ws, 'bg-tool-2', async () => {
        const r = await shellExecTool.handler!({
          command: nodeScript('console.log("FOREGROUND-OK")'),
          run_in_background: 'true',
        }) as ToolResult
        expect(r.success, r.error).toBe(true)
        expect(r.output).toContain('FOREGROUND-OK')
      })
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })

  it('后台启动同样受删除通道策略约束', async () => {
    const ws = makeTemp('wa-bgws-')
    try {
      await withWorkspace(ws, 'bg-tool-3', async () => {
        const r = await shellExecTool.handler!({ command: 'rm -rf /tmp/x', run_in_background: true }) as ToolResult
        expect(r.success).toBe(false)
        expect(r.error).toContain('file_delete')
      })
      expect(svc.list('bg-tool-3')).toHaveLength(0)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('agent/tools / shell_output & shell_kill', () => {
  it('shell_output 返回任务状态、增量偏移与输出', async () => {
    const started = svc.start({ command: nodeScript('console.log("OUT-TOOL")'), cwd: os.tmpdir(), ownerKey: 'tool-out' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const id = started.snapshot.id

    // 等任务结束再读取，避免读到空输出
    await waitStatus(id, 'not-running')
    const res = await shellOutputTool.handler!({ task_id: id }) as ToolResult
    expect(res.success, res.error).toBe(true)
    expect(res.output).toContain(`任务 ${id} 状态: 已结束`)
    expect(res.output).toContain('next_offset:')
    expect(res.output).toContain('OUT-TOOL')
  })

  it('shell_output / shell_kill 参数校验与不存在的任务', async () => {
    expect((await shellOutputTool.handler!({}) as ToolResult).error).toContain('task_id 不能为空')
    expect(await shellKillTool.handler!({}) as ToolResult).toMatchObject({ success: false, error: 'task_id 不能为空' })
    const unknownRead = await shellOutputTool.handler!({ task_id: 'bg_missing' }) as ToolResult
    expect(unknownRead.success).toBe(false)
    expect(unknownRead.error).toContain('后台任务不存在')
    const unknownKill = shellKillTool.handler!({ task_id: 'bg_missing' }) as ToolResult
    expect(unknownKill.success).toBe(false)
  })

  it('shell_kill 发送终止信号并可通过 shell_output 读到最后输出', async () => {
    const started = svc.start({
      command: nodeScript('console.log("BEFORE-KILL"); setInterval(() => {}, 1000)'),
      cwd: os.tmpdir(),
      ownerKey: 'tool-kill',
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const id = started.snapshot.id
    await sleep(400)

    const kill = shellKillTool.handler!({ task_id: id }) as ToolResult
    expect(kill.success, kill.error).toBe(true)
    expect(kill.output).toContain('已发送终止信号')

    await waitStatus(id, 'not-running')
    const read = await shellOutputTool.handler!({ task_id: id }) as ToolResult
    expect(read.output).toContain('已终止')
    expect(read.output).toContain('BEFORE-KILL')
  })

  it('工具元信息：按需、只读、不重试', () => {
    expect(shellOutputTool.onDemand).toBe(true)
    expect(shellOutputTool.permission).toBe('safe')
    expect(shellOutputTool.noRetry).toBe(true)
    expect(shellOutputTool.parameters.required).toEqual(['task_id'])

    expect(shellKillTool.onDemand).toBe(true)
    expect(shellKillTool.permission).toBe('safe')
    expect(shellKillTool.noRetry).toBe(true)
    expect(shellKillTool.parameters.required).toEqual(['task_id'])

    // shell_exec 新增 run_in_background 参数，仍为常驻工具
    expect(shellExecTool.onDemand).toBe(false)
    expect(Object.keys(shellExecTool.parameters.properties)).toContain('run_in_background')
    expect(shellExecTool.parameters.required).toEqual(['command'])
  })
})
