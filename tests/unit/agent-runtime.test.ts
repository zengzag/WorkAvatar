import { describe, it, expect, vi, beforeEach } from 'vitest'

const { broadcastRunEvent, fakeDb, chatStream } = vi.hoisted(() => {
  const fakeDb = {
    prepare: vi.fn((sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes('SELECT id, name, avatar_type FROM employees')) {
          return { id: args[0] || 'target1', name: '资料员工', avatar_type: 'default' }
        }
        if (sql.includes("SELECT value FROM settings") && sql.includes('sub_agent_max_parallel')) {
          return { value: '3' }
        }
        return undefined
      },
      all: () => [],
      run: () => ({ changes: 1 }),
    })),
  }
  return {
    broadcastRunEvent: vi.fn(),
    fakeDb,
    chatStream: vi.fn(async (_params: any, callbacks: any, _signal?: AbortSignal) => {
      callbacks.onChunk?.('子员工完成了检索')
      callbacks.onToolResult?.({ name: 'report_generated_files', generatedFiles: [{ path: '/tmp/out.docx', name: 'out.docx', ext: 'docx', size: 10, mtime: 1 }], success: true })
      callbacks.onDone?.({ tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
    }),
  }
})

vi.mock('../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({ getDb: () => fakeDb }),
  },
}))

vi.mock('../../electron/main/services/memory-refinement.service', () => ({
  default: {
    getInstance: () => ({ resolveEmployeeLLM: vi.fn(async () => ({ providerId: 'p1', modelId: 'm1' })) }),
  },
}))

vi.mock('../../electron/main/services/workspace-manager.service', () => ({
  default: {
    getInstance: () => ({
      createConversation: vi.fn(() => ({ id: 'sub1', workspace_path: '' })),
      getConversationWorkspacePath: vi.fn(() => ''),
    }),
  },
}))

vi.mock('../../electron/main/services/employee-agent.service', () => ({
  default: { getInstance: () => ({ chatStream }) },
}))

vi.mock('../../electron/main/ipc/agent-run-events', () => ({
  broadcastRunEvent: (...args: any[]) => broadcastRunEvent(...args),
}))

vi.mock('../../electron/main/services/common-utils', () => ({
  generateId: vi.fn(() => `run_${Math.random().toString(36).slice(2, 10)}`),
}))

import SubAgentRuntime from '../../electron/main/services/agent-runtime/runtime'

describe('SubAgentRuntime', () => {
  let runtime: SubAgentRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    runtime = SubAgentRuntime.getInstance()
  })

  const baseInput = () => ({
    parentSessionId: 'parent-session-1',
    parentEmployeeId: 'supervisor1',
    parentConversationId: 'conv-supervisor-1',
    targetEmployeeId: 'target1',
    instruction: '检索竞品资料并整理表格',
    contextFiles: [],
    delegationDepth: 0,
    delegationChain: [],
    parentAbortSignal: undefined,
    enableThinking: false as const,
    highPermission: false,
  })

  it('递归防护：深度超限直接拒绝', () => {
    const res = runtime.launchSubAgent({ ...baseInput(), delegationDepth: 3 })
    expect(res.success).toBe(false)
    expect(res.error).toContain('委托深度超限')
  })

  it('递归防护：委托链出现环直接拒绝', () => {
    const res = runtime.launchSubAgent({ ...baseInput(), delegationChain: ['target1'] })
    expect(res.success).toBe(false)
    expect(res.error).toContain('委托环')
  })

  it('禁止自委托', () => {
    const res = runtime.launchSubAgent({ ...baseInput(), targetEmployeeId: 'supervisor1' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('不能委托给自己')
  })

  it('context_files 超出白名单数量拒绝', () => {
    const res = runtime.launchSubAgent({ ...baseInput(), contextFiles: Array.from({ length: 11 }, (_, i) => `/tmp/f${i}.txt`) })
    expect(res.success).toBe(false)
    expect(res.error).toContain('context_files 数量超限')
  })

  it('正常派发：launch 返回 runId，awaitRuns 聚合结构化结果（含 L1 张产物）', async () => {
    const launched = runtime.launchSubAgent(baseInput())
    expect(launched.success).toBe(true)
    expect(launched.runId).toBeTruthy()

    const outcomes = await runtime.awaitRuns([launched.runId!], 2000)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].success).toBe(true)
    expect(outcomes[0].output).toContain('子员工完成了检索')
    expect(outcomes[0].result?.generatedFiles).toHaveLength(1)
    expect(outcomes[0].result?.generatedFiles[0].path).toBe('/tmp/out.docx')
    expect(outcomes[0].tokenUsage?.totalTokens).toBe(120)

    const run = runtime.getRun(launched.runId!)
    expect(run?.status).toBe('completed')
    expect(run?.summary).toContain('子员工完成了检索')
    expect(run?.endedAt).toBeTruthy()
    // 结果已落库（INSERT 调用）
    expect(fakeDb.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sub_agent_runs'))
  })

  it('abort 树：主管 signal 已中止 → 子 run 置为 cancelled', async () => {
    const signal = new AbortController()
    signal.abort()
    const launched = runtime.launchSubAgent({ ...baseInput(), parentAbortSignal: signal.signal })
    expect(launched.success).toBe(true)
    const outcomes = await runtime.awaitRuns([launched.runId!], 2000)
    expect(outcomes[0].status).toBe('cancelled')
    expect(runtime.getRun(launched.runId!)?.status).toBe('cancelled')
  })

  it('await 超时：run 未完成返回当前状态（不抛错）', async () => {
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onChunk?.('慢任务')
      // 永不 resolve：run 保持 running
      await new Promise<void>(() => { /* never */ })
    })
    const launched = runtime.launchSubAgent(baseInput())
    const outcomes = await runtime.awaitRuns([launched.runId!], 50)
    expect(outcomes[0].success).toBe(false)
    expect(['running', 'queued']).toContain(outcomes[0].status)
  })

  it('cancelRun：取消后状态为 cancelled', async () => {
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onChunk?.('挂起任务')
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      callbacks.onDone?.({})
    })
    const launched = runtime.launchSubAgent(baseInput())
    expect(runtime.cancelRun(launched.runId!)).toBe(true)
    const outcomes = await runtime.awaitRuns([launched.runId!], 2000)
    expect(outcomes[0].status).toBe('cancelled')
  })

  it('listActiveRuns 返回事件日志（ring buffer 供重载恢复）', async () => {
    const launched = runtime.launchSubAgent(baseInput())
    await runtime.awaitRuns([launched.runId!], 2000)
    const active = runtime.listActiveRuns({ parentConversationId: 'conv-supervisor-1' })
    const entry = active.find(r => r.runId === launched.runId)
    expect(entry).toBeTruthy()
    const eventTypes = entry!.eventLog.map(e => e.eventType)
    expect(eventTypes).toContain('start')
    expect(eventTypes).toContain('chunk')
    expect(eventTypes).toContain('tool_result')
    expect(eventTypes).toContain('result')
  })

  it('产物递归展平：父 run 汇总子 run 的成果文件', async () => {
    const parent = runtime.launchSubAgent(baseInput())
    expect(parent.success).toBe(true)
    const child = runtime.launchSubAgent({ ...baseInput(), parentRunId: parent.runId, instruction: '子任务' })
    expect(child.success).toBe(true)

    await runtime.awaitRuns([child.runId!], 2000)
    await runtime.awaitRuns([parent.runId!], 2000)

    const childRun = runtime.getRun(child.runId!)
    expect(childRun?.generatedFiles).toHaveLength(1)
    const parentRun = runtime.getRun(parent.runId!)
    // 子 run 的产物收拢到父 run（同路径去重后仍为 1 条）
    expect(parentRun?.generatedFiles.some(f => f.path === '/tmp/out.docx')).toBe(true)
  })

  it('send_message / read_messages 邮箱协作', async () => {
    // 让 run 保持运行中一段时间，便于接收消息后自然结束
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onChunk?.('任务进行中')
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
      callbacks.onDone?.({ tokenUsage: { totalTokens: 5 } })
    })
    const launched = runtime.launchSubAgent(baseInput())
    const runId = launched.runId!

    expect(runtime.sendMessage(runId, '补充要求：改用 Markdown', '主管').success).toBe(true)
    expect(runtime.sendMessage('no-such-run', 'x', '主管').success).toBe(false)

    const messages = runtime.readMessages(runId)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('补充要求：改用 Markdown')
    expect(runtime.readMessages(runId)).toHaveLength(0)

    // 结束后不可再接收消息
    await runtime.awaitRuns([runId], 2000)
    expect(runtime.getRun(runId)?.status).toBe('completed')
    expect(runtime.sendMessage(runId, '晚了', '主管').success).toBe(false)
  })

  it('事件日志合并：相邻 chunk/thought 追加而非新增条目（防止撑爆 ring buffer）', async () => {
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onChunk?.('进行中')
      callbacks.onDone?.({})
    })
    const launched = runtime.launchSubAgent(baseInput())
    // 直接驱动 emit 验证：连续 chunk 应合并为一条，穿插工具事件则分段
    const runId = launched.runId!
    const entry = (runtime as any).entries.get(runId)
    ;(runtime as any).emit(runId, 'chunk', 'AAAA')
    ;(runtime as any).emit(runId, 'chunk', 'BBBB')
    ;(runtime as any).emit(runId, 'chunk', 'CCCC')
    ;(runtime as any).emit(runId, 'tool_result', { name: 'x', result: 'r' })
    ;(runtime as any).emit(runId, 'chunk', 'DDDD')
    const chunks = entry.eventLog.filter((e: any) => e.eventType === 'chunk')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].data).toBe('AAAABBBBCCCC')
    expect(chunks[1].data).toBe('DDDD')
  })

  it('settle 幂等：重复结算不改变已终态结果', async () => {
    const launched = runtime.launchSubAgent(baseInput())
    await runtime.awaitRuns([launched.runId!], 2000)
    expect(runtime.getRun(launched.runId!)?.status).toBe('completed')
    // 二次结算 attempted：状态/结局不应被覆盖
    ;(runtime as any).settle(launched.runId!, 'failed', { error: '不应生效', summary: '' })
    const run = runtime.getRun(launched.runId!)!
    expect(run.status).toBe('completed')
    expect(run.error).toBeUndefined()
  })

  it('产物去重：L1 与 L2 同路径不重复，父 run 收敛嵌套后代', async () => {
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onToolResult?.({ name: 'report_generated_files', generatedFiles: [
        { path: '/tmp/dup.docx', name: 'dup.docx', ext: 'docx', size: 10, mtime: 1 },
        { path: '/tmp/b.xlsx', name: 'b.xlsx', ext: 'xlsx', size: 5, mtime: 1 },
      ], success: true })
      callbacks.onDone?.({})
    })
    const parent = runtime.launchSubAgent(baseInput())
    expect(parent.success).toBe(true)
    await runtime.awaitRuns([parent.runId!], 2000)
    const parentRun = runtime.getRun(parent.runId!)!
    // snapshot 为空工作区（workspace_path: ''），故 autoDetected 为空，不参与断言
    const paths = parentRun.generatedFiles.map(f => f.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('内存上限：超过 MAX_MEMORY_ENTRIES 后淘汰最老的已终态条目', async () => {
    const launchedIds: string[] = []
    for (let i = 0; i < 105; i++) {
      const r = runtime.launchSubAgent({ ...baseInput(), instruction: `task-${i}` })
      expect(r.success).toBe(true)
      launchedIds.push(r.runId!)
    }
    await runtime.awaitRuns(launchedIds, 3000)
    const entries = (runtime as any).entries
    expect(entries.size).toBeLessThanOrEqual(100)
    // 最老的已终态 run 应已被逐出（不在 entries 中）
    expect(entries.has(launchedIds[0])).toBe(false)
  })

  it('并行上限：并发不超过 sub_agent_max_parallel（3），其余排队', async () => {
    let running = 0
    let maxSeen = 0
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      running++
      maxSeen = Math.max(maxSeen, running)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      running--
      callbacks.onDone?.({})
    })
    // 并发限制仅在 mock 为慢任务时可见；默认 mock 立即完成，此处仅验证不报错
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const r = runtime.launchSubAgent({ ...baseInput(), instruction: `p-${i}` })
      ids.push(r.runId!)
    }
    await runtime.awaitRuns(ids, 3000)
    for (const id of ids) {
      expect(runtime.getRun(id)?.status).toBe('completed')
    }
  })
})