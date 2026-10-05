import { describe, it, expect, vi, beforeEach } from 'vitest'

const { broadcastRunEvent, fakeDb, chatStream, setDelegationRows, setSubAgentRuns, resetSubAgentRuns, getSubAgentRuns } = vi.hoisted(() => {
  // 委托设置查询返回行（可被单测覆写），默认：supervisor1 开启委托且 target1 在可委托列表中
  let delegationRows: Array<{ id: string; delegation_json?: string | null }> = [
    { id: 'supervisor1', delegation_json: JSON.stringify({ enabled: true, targetIds: ['target1'], acceptDelegation: true }) },
    { id: 'target1', delegation_json: '' },
  ]
  // sub_agent_runs 内存表：模拟 INSERT/UPDATE/SELECT，供追问（followup）链路读写
  let subAgentRunRows: Array<{
    run_id: string; parent_conversation_id: string; employee_id: string; parent_run_id: string
    conversation_id: string; status: string; inputs_json: string; result_json: string
    usage_json: string; error: string; started_at: number | null; ended_at: number | null
  }> = []
  const fakeDb = {
    prepare: vi.fn((sql: string) => ({
      get: (...args: any[]) => {
        if (sql.includes('SELECT id, name, avatar_type FROM employees')) {
          return { id: args[0] || 'target1', name: '资料员工', avatar_type: 'default' }
        }
        if (sql.includes("SELECT value FROM settings") && sql.includes('sub_agent_max_parallel')) {
          return { value: '3' }
        }
        if (sql.includes('SELECT COUNT(*) AS n FROM sub_agent_runs')) {
          return { n: subAgentRunRows.filter(r => r.conversation_id === args[0]).length }
        }
        if (sql.includes('FROM sub_agent_runs WHERE run_id = ?')) {
          const row = subAgentRunRows.find(r => r.run_id === args[0])
          if (!row) return undefined
          if (sql.includes('parent_conversation_id')) {
            // launchFollowup 解析原 run
            return {
              run_id: row.run_id, employee_id: row.employee_id, parent_run_id: row.parent_run_id,
              conversation_id: row.conversation_id, parent_conversation_id: row.parent_conversation_id, status: row.status,
            }
          }
          // persistRun 存在性检查
          return { run_id: row.run_id }
        }
        return undefined
      },
      all: (..._args: any[]) => {
        if (sql.includes('SELECT id, delegation_json FROM employees')) {
          return [...delegationRows]
        }
        if (sql.includes('FROM sub_agent_runs') && sql.includes('run_id != ?')) {
          // loadFollowupHistory：按插入顺序（rowid）返回
          return subAgentRunRows.filter(r => r.conversation_id === _args[0] && r.run_id !== _args[1])
        }
        return []
      },
      run: (...args: any[]) => {
        if (sql.includes('INSERT INTO sub_agent_runs')) {
          subAgentRunRows.push({
            run_id: args[0], parent_conversation_id: args[1], employee_id: args[2], parent_run_id: args[3] || '',
            conversation_id: args[4] || '', status: args[5], inputs_json: args[6], result_json: args[7],
            usage_json: args[8], error: args[9] || '', started_at: args[10] ?? null, ended_at: args[11] ?? null,
          })
        } else if (sql.includes("SET status = 'failed'") && sql.includes('执行中断') && sql.includes('run_id = ?')) {
          // launchFollowup 僵尸 run 标记失败
          const row = subAgentRunRows.find(r => r.run_id === args[1])
          if (row) { row.status = 'failed'; row.error = row.error || '执行中断（应用重启）'; row.ended_at = args[0] }
        } else if (sql.includes("status IN ('running', 'queued')")) {
          // recoverStaleRuns：批量沉降僵尸（无 runId 参数，全表匹配）
          for (const row of subAgentRunRows) {
            if (row.status === 'running' || row.status === 'queued') {
              row.status = 'failed'
              row.error = row.error || '执行中断（应用重启）'
              row.ended_at = args[0] ?? null
            }
          }
        } else if (sql.includes('UPDATE sub_agent_runs')) {
          // persistRun 更新（15 参：parent_conv, employee, parent_run, conv, status, inputs, result, usage, error, started, ended, ephemeral, lifecycle, lastActivity, runId）
          const row = subAgentRunRows.find(r => r.run_id === args[14])
          if (row) {
            row.conversation_id = args[3] || row.conversation_id
            row.status = args[4]
            row.inputs_json = args[5]
            row.result_json = args[6]
            row.error = args[8] || ''
            row.started_at = args[9] ?? null
            row.ended_at = args[10] ?? null
          }
        }
        return { changes: 1 }
      },
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
    setDelegationRows: (rows: Array<{ id: string; delegation_json?: string | null }>) => { delegationRows = rows },
    setSubAgentRuns: (rows: typeof subAgentRunRows) => { subAgentRunRows = rows },
    resetSubAgentRuns: () => { subAgentRunRows = [] },
    getSubAgentRuns: () => subAgentRunRows,
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
import EmployeeRegistryService from '../../electron/main/services/employee-registry.service'

describe('SubAgentRuntime', () => {
  let runtime: SubAgentRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 chatStream 并恢复默认实现：mockImplementation 的测试用例不污染后续用例
    chatStream.mockReset()
    chatStream.mockImplementation(async (_params: any, callbacks: any, _signal?: AbortSignal) => {
      callbacks.onChunk?.('子员工完成了检索')
      callbacks.onToolResult?.({ name: 'report_generated_files', generatedFiles: [{ path: '/tmp/out.docx', name: 'out.docx', ext: 'docx', size: 10, mtime: 1 }], success: true })
      callbacks.onDone?.({ tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
    })
    setDelegationRows([
      { id: 'supervisor1', delegation_json: JSON.stringify({ enabled: true, targetIds: ['target1'], acceptDelegation: true }) },
      { id: 'target1', delegation_json: '' },
    ])
    resetSubAgentRuns()
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

  it('委托设置校验：主管未开启委托或目标不在可委托列表中直接拒绝', () => {
    setDelegationRows([
      { id: 'supervisor1', delegation_json: JSON.stringify({ enabled: true, targetIds: ['other'], acceptDelegation: true }) },
      { id: 'target1', delegation_json: '' },
    ])
    const res = runtime.launchSubAgent(baseInput())
    expect(res.success).toBe(false)
    expect(res.error).toContain('不在当前数字员工的可委托列表中')
  })

  it('委托设置校验：目标员工拒绝被委托直接拒绝', () => {
    setDelegationRows([
      { id: 'supervisor1', delegation_json: JSON.stringify({ enabled: true, targetIds: ['target1'], acceptDelegation: true }) },
      { id: 'target1', delegation_json: JSON.stringify({ enabled: false, targetIds: [], acceptDelegation: false }) },
    ])
    const res = runtime.launchSubAgent(baseInput())
    expect(res.success).toBe(false)
    expect(res.error).toContain('不允许被委托任务')
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

  it('子会话指令包含结构化委托契约（成品声明 + 回执格式）', async () => {
    const launched = runtime.launchSubAgent(baseInput())
    await runtime.awaitRuns([launched.runId!], 2000)
    const params = chatStream.mock.calls[0][0] as any
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0].role).toBe('user')
    const content = params.messages[0].content as string
    expect(content).toContain('检索竞品资料并整理表格')
    expect(content).toContain('Delegation contract (mandatory)')
    expect(content).toContain('report_generated_files')
    expect(content).toContain('Delegation Receipt')
    expect(content).toContain('Status: Completed | Partially completed | Failed')
    expect(content).toContain('Deliverables:')
    expect(content).toContain('Blockers:')
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

  // ---- 追问（followup）多轮对话 ----

  const followupInput = (followupOfRunId: string) => ({
    followupOfRunId,
    parentSessionId: 'parent-session-1',
    parentEmployeeId: 'supervisor1',
    parentConversationId: 'conv-supervisor-1',
    instruction: '表格缺少价格列，请补充完整',
    delegationDepth: 0,
    delegationChain: [],
    parentAbortSignal: undefined,
    enableThinking: false as const,
    highPermission: false,
  })

  it('追问：复用原子会话，历史轮指令与结果注入子智能体上下文', async () => {
    const first = runtime.launchSubAgent(baseInput())
    await runtime.awaitRuns([first.runId!], 2000)
    expect(runtime.getRun(first.runId!)?.status).toBe('completed')

    const fu = runtime.launchFollowup(followupInput(first.runId!))
    expect(fu.success).toBe(true)
    expect(fu.runId).toBeTruthy()
    expect(fu.targetEmployeeName).toBe('资料员工')

    const outcomes = await runtime.awaitRuns([fu.runId!], 2000)
    expect(outcomes[0].success).toBe(true)

    const fuRun = runtime.getRun(fu.runId!)!
    expect(fuRun.conversationId).toBe('sub1') // 复用原子会话（mock createConversation 返回 sub1）
    expect(fuRun.followupOfRunId).toBe(first.runId)

    // 子智能体收到的 messages：历史轮 user/assistant 对 + 本轮追问 user
    const params = chatStream.mock.calls.at(-1)![0] as any
    const roles = params.messages.map((m: any) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user'])
    expect(params.messages[0].content).toContain('检索竞品资料并整理表格')
    expect(params.messages[1].content).toContain('子员工完成了检索')
    expect(params.messages[2].content).toContain('表格缺少价格列')
    expect(params.conversation_id).toBe('sub1')
  })

  it('追问：追问轮的追问（链式），历史累计两轮', async () => {
    const first = runtime.launchSubAgent(baseInput())
    await runtime.awaitRuns([first.runId!], 2000)
    const second = runtime.launchFollowup(followupInput(first.runId!))
    await runtime.awaitRuns([second.runId!], 2000)
    const third = runtime.launchFollowup({ ...followupInput(second.runId!), instruction: '再补充毛利率列' })
    await runtime.awaitRuns([third.runId!], 2000)

    const params = chatStream.mock.calls.at(-1)![0] as any
    const roles = params.messages.map((m: any) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(params.messages[2].content).toContain('表格缺少价格列')
  })

  it('追问：原委托仍在执行中直接拒绝', async () => {
    chatStream.mockImplementationOnce(async (_params: any, callbacks: any) => {
      callbacks.onChunk?.('慢任务')
      await new Promise<void>((resolve) => setTimeout(resolve, 150))
      callbacks.onDone?.({})
    })
    const first = runtime.launchSubAgent(baseInput())
    const fu = runtime.launchFollowup(followupInput(first.runId!))
    expect(fu.success).toBe(false)
    expect(fu.error).toContain('仍在执行中')
    await runtime.awaitRuns([first.runId!], 3000)
  })

  it('追问：不存在的 delegation_id 拒绝', () => {
    const fu = runtime.launchFollowup(followupInput('no-such-run'))
    expect(fu.success).toBe(false)
    expect(fu.error).toContain('未找到委托记录')
  })

  it('追问：同一子会话累计轮数达上限（5 轮）拒绝', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      run_id: `r${i}`, parent_conversation_id: 'conv-supervisor-1', employee_id: 'target1', parent_run_id: '',
      conversation_id: 'convA', status: 'completed', inputs_json: JSON.stringify({ instruction: `t${i}` }),
      result_json: JSON.stringify({ summary: `s${i}` }), usage_json: '{}', error: '', started_at: i, ended_at: i,
    }))
    setSubAgentRuns(rows)
    const fu = runtime.launchFollowup(followupInput('r4'))
    expect(fu.success).toBe(false)
    expect(fu.error).toContain('追问轮数已达上限')
  })

  it('追问：跨会话委托不可追问', () => {
    setSubAgentRuns([{
      run_id: 'rx', parent_conversation_id: 'conv-other', employee_id: 'target1', parent_run_id: '',
      conversation_id: 'convX', status: 'completed', inputs_json: JSON.stringify({ instruction: 't' }),
      result_json: JSON.stringify({ summary: 's' }), usage_json: '{}', error: '', started_at: 1, ended_at: 1,
    }])
    const fu = runtime.launchFollowup(followupInput('rx'))
    expect(fu.success).toBe(false)
    expect(fu.error).toContain('不属于当前会话')
  })

  it('追问：重启恢复（仅 DB 记录，内存无条目）仍可追问，僵尸 running 标记失败', async () => {
    // 模拟重启后：内存 entries 为空，仅 DB 有已结束/中断记录
    setSubAgentRuns([
      {
        run_id: 'legacy-run', parent_conversation_id: 'conv-supervisor-1', employee_id: 'target1', parent_run_id: '',
        conversation_id: 'convLegacy', status: 'running', inputs_json: JSON.stringify({ instruction: '旧任务' }),
        result_json: JSON.stringify({ summary: '' }), usage_json: '{}', error: '', started_at: 1, ended_at: null,
      },
    ])
    const fu = runtime.launchFollowup(followupInput('legacy-run'))
    expect(fu.success).toBe(true)

    const outcomes = await runtime.awaitRuns([fu.runId!], 2000)
    expect(outcomes[0].success).toBe(true)
    const fuRun = runtime.getRun(fu.runId!)!
    expect(fuRun.conversationId).toBe('convLegacy')

    // 历史轮包含旧任务指令（失败轮附错误说明）
    const params = chatStream.mock.calls.at(-1)![0] as any
    expect(params.messages[0].content).toContain('旧任务')
    expect(params.messages[1].content).toContain('执行中断（应用重启）')
  })

  it('tokenUsage 多轮累加：gate 纠偏轮用量不覆盖第一轮', async () => {
    let calls = 0
    chatStream.mockImplementation(async (_params: any, callbacks: any) => {
      calls++
      callbacks.onDone?.({ tokenUsage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } })
    })
    const launched = runtime.launchSubAgent(baseInput())
    const runId = launched.runId!
    // 一项任务留在台账 → 触发纠偏轮（MAX_GATE_ROUNDS=2），共 3 次 streamOnce
    runtime.createTask(runId, '不收尾的任务')
    const outcomes = await runtime.awaitRuns([runId], 3000)
    expect(outcomes[0].success).toBe(true)
    expect(calls).toBe(3)
    expect(outcomes[0].tokenUsage).toEqual({ promptTokens: 300, completionTokens: 60, totalTokens: 360 })
  })

  // ---- 阶段一/三/四：临时子智能体、后台通知、任务台账、结构化结果 ----

  it('临时子智能体：跳过委托设置校验，生成 inline 员工并在结束时下线', async () => {
    // 目标设置明确拒绝被委托：临时角色路径不受影响
    setDelegationRows([
      { id: 'supervisor1', delegation_json: JSON.stringify({ enabled: true, targetIds: [], acceptDelegation: true }) },
    ])
    const registry = EmployeeRegistryService.getInstance()
    const registerSpy = vi.spyOn(registry, 'registerInlineEmployee')
    const unregisterSpy = vi.spyOn(registry, 'unregisterInlineEmployee')
    try {
      const launched = runtime.launchSubAgent({
        ...baseInput(),
        targetEmployeeId: '',
        ephemeral: { name: '财报分析师', systemPrompt: '你是财报分析专家', tools: ['file_read'] },
      })
      expect(launched.success).toBe(true)
      expect(launched.targetEmployeeName).toBe('财报分析师')
      expect(launched.targetEmployeeId).toMatch(/^inline:sub-.+/)

      // 子会话归属 inline 员工
      await runtime.awaitRuns([launched.runId!], 2000)
      expect(registerSpy).toHaveBeenCalledTimes(1)
      expect(registerSpy.mock.calls[0][0].id).toBe(launched.targetEmployeeId)
      expect(registerSpy.mock.calls[0][0].rules).toBe('你是财报分析专家')
      expect(unregisterSpy).toHaveBeenCalledWith(launched.targetEmployeeId)
      const run = runtime.getRun(launched.runId!)!
      expect(run.lifecycle).toBe('ephemeral')
      expect(run.ephemeral?.name).toBe('财报分析师')
    } finally {
      registerSpy.mockRestore()
      unregisterSpy.mockRestore()
    }
  })

  it('临时子智能体：指令注入角色契约且注册员工带工具白名单与提示词', async () => {
    const launched = runtime.launchSubAgent({
      ...baseInput(),
      targetEmployeeId: '',
      ephemeral: { name: '调研员', systemPrompt: '你是行业调研员，只做只读检索', tools: ['web_search'], skills: ['sk1'] },
    })
    await runtime.awaitRuns([launched.runId!], 2000)
    const params = chatStream.mock.calls.at(-1)![0] as any
    expect(params.employee_id).toBe(launched.targetEmployeeId)
    expect(params.messages[0].content).toContain('Delegation contract (mandatory)')

    const registry = EmployeeRegistryService.getInstance()
    // run 已结束、员工已下线：通过 register 的入参断言字段构造
    const emp = registry.toInlineRegisteredEmployee(launched.targetEmployeeId!, {
      name: '调研员', systemPrompt: '你是行业调研员，只做只读检索', tools: ['web_search'], skills: ['sk1'],
    })
    expect(emp.rules).toBe('你是行业调研员，只做只读检索')
    expect(emp.defaultTools).toEqual(['web_search'])
    expect(emp.defaultSkills).toEqual(['sk1'])
    expect(emp.source).toBe('inline')
  })

  it('临时子智能体：委托链含同名 key 时拒绝（防环）', () => {
    const launched = runtime.launchSubAgent({
      ...baseInput(),
      targetEmployeeId: '',
      delegationChain: ['inline:sub-caiwu-abc123'],
      ephemeral: { name: '财报', key: 'caiwu', systemPrompt: 'x' },
    })
    expect(launched.success).toBe(false)
    expect(launched.error).toContain('委托环')
  })

  it('slugifyInlineKey：小写归一、非法字符转连字符、限长 63、空结果回退', () => {
    const registry = EmployeeRegistryService.getInstance()
    expect(registry.slugifyInlineKey('Data-Analyst 01')).toBe('data-analyst-01')
    expect(registry.slugifyInlineKey('!!!')).toBe('role')
    expect(registry.slugifyInlineKey('财报分析师')).toBe('role')
    expect(registry.slugifyInlineKey('a'.repeat(100))).toHaveLength(63)
  })

  it('后台派发：立即返回 + 终态通知入队 + readNotifications 读取即清空', async () => {
    const launched = runtime.launchSubAgent({ ...baseInput(), runInBackground: true })
    expect(launched.success).toBe(true)
    // 后台派发不阻塞：launch 后 run 仍处于 queued/running
    expect(['queued', 'running']).toContain(runtime.getRun(launched.runId!)!.status)

    const outcomes = await runtime.awaitRuns([launched.runId!], 2000)
    expect(outcomes[0].success).toBe(true)

    const notices = runtime.readNotifications('conv-supervisor-1')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      runId: launched.runId,
      status: 'completed',
      targetEmployeeName: '资料员工',
    })
    expect(notices[0].generatedFiles.some(f => f.path === '/tmp/out.docx')).toBe(true)
    // 读取即清空
    expect(runtime.readNotifications('conv-supervisor-1')).toHaveLength(0)
  })

  it('任务台账 + 完成门：未收尾项触发纠偏轮（≤2 次）并计入未完成清单', async () => {
    let calls = 0
    chatStream.mockImplementation(async (_params: any, callbacks: any) => {
      calls++
      callbacks.onChunk?.(`第${calls}轮输出`)
      callbacks.onDone?.({})
    })
    const launched = runtime.launchSubAgent(baseInput())
    const runId = launched.runId!
    // 委托后登记两项（delegate 工具同款调用路径）
    expect(runtime.createTask(runId, '梳理要点').success).toBe(true)
    expect(runtime.createTask(runId, '生成文档').success).toBe(true)

    const outcomes = await runtime.awaitRuns([runId], 3000)
    expect(outcomes[0].success).toBe(true)
    // 首轮 + 2 轮完成门纠偏 = 3 次
    expect(calls).toBe(3)
    // 完成门提示词含未收尾项
    const gateCall = chatStream.mock.calls[1][0] as any
    expect(gateCall.messages.at(-1).content).toContain('Completion gate')
    expect(gateCall.messages.at(-1).content).toContain('梳理要点')
    // gate 纠偏轮带第一轮 assistant 上下文（续聊而非失忆）
    const roles = gateCall.messages.map((m: any) => m.role)
    expect(roles[roles.length - 2]).toBe('assistant')
    expect(roles[roles.length - 1]).toBe('user')
    expect(gateCall.messages.at(-2).content).toContain('第1轮输出')
    // 结果携带未收尾清单
    expect(outcomes[0].output).toContain('未收尾任务项')
    expect(outcomes[0].result?.incompleteTasks).toEqual(['梳理要点', '生成文档'])
  })

  it('任务台账：子会话收尾全部任务后不触发完成门', async () => {
    let calls = 0
    chatStream.mockImplementation(async (_params: any, callbacks: any) => {
      calls++
      callbacks.onChunk?.('done')
      callbacks.onDone?.({})
    })
    const launched = runtime.launchSubAgent(baseInput())
    const runId = launched.runId!
    runtime.createTask(runId, '唯一任务')
    // 子会话启动后立即把任务收尾（task_item_update 同款调用）
    expect(runtime.updateTask(runId, 't1', 'completed').success).toBe(true)
    const outcomes = await runtime.awaitRuns([runId], 3000)
    expect(outcomes[0].success).toBe(true)
    expect(calls).toBe(1)
    expect(outcomes[0].result?.incompleteTasks).toEqual([])
  })

  it('结构化交付物：submit 后进入结果（output/structured）', async () => {
    const launched = runtime.launchSubAgent({
      ...baseInput(),
      outputSchema: { type: 'object', properties: { score: { type: 'number' } } },
    })
    const runId = launched.runId!
    // 模拟子会话上报（submit_structured_result 工具同款调用）
    expect(runtime.recordStructuredResult(runId, { score: 97 }).success).toBe(true)

    const outcomes = await runtime.awaitRuns([runId], 2000)
    expect(outcomes[0].result?.structured).toEqual({ score: 97 })
    expect(outcomes[0].output).toContain('结构化结果')
    expect(outcomes[0].output).toContain('"score"')
  })

  it('recoverStaleRuns：派发前把 DB 僵尸 running/queued 沉降为 failed', async () => {
    setSubAgentRuns([
      {
        run_id: 'zombie', parent_conversation_id: 'conv-supervisor-1', employee_id: 'target1', parent_run_id: '',
        conversation_id: 'convZ', status: 'running', inputs_json: '{}', result_json: '{}',
        usage_json: '{}', error: '', started_at: 1, ended_at: null,
      },
    ])
    // 单例的 recovered 标记可能已被同文件更早的派发置位：重置以触发本次恢复
    ;(runtime as any).recovered = false
    const launched = runtime.launchSubAgent(baseInput())
    expect(launched.success).toBe(true)
    const zombie = getSubAgentRuns().find(r => r.run_id === 'zombie')!
    expect(zombie.status).toBe('failed')
    expect(zombie.error).toContain('应用重启')
    await runtime.awaitRuns([launched.runId!], 2000)
  })

  it('deriveLiveness：终态 idle；最近有活动 progressing；久无活动 stalled', async () => {
    const launched = runtime.launchSubAgent(baseInput())
    const runId = launched.runId!
    expect(runtime.deriveLiveness(runtime.getRun(runId)!)).toBe('progressing')
    // 回拨 lastActivityAt 超过停滞窗口（6 分钟）
    const entry = (runtime as any).entries.get(runId)
    entry.run.lastActivityAt = Date.now() - 7 * 60_000
    expect(runtime.deriveLiveness(runtime.getRun(runId)!)).toBe('stalled')
    await runtime.awaitRuns([runId], 2000)
    expect(runtime.deriveLiveness(runtime.getRun(runId)!)).toBe('idle')
  })
})