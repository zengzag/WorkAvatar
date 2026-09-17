import { describe, it, expect, beforeEach, vi } from 'vitest'
import { interactionContext } from '../../../electron/main/services/unified-interaction.service'

/** 通过 mock SubAgentRuntime + DatabaseService 覆盖委托类工具的校验与编排分支 */
const runtimeState = vi.hoisted(() => ({
  launchQueue: [] as any[],
  launchInputs: [] as any[],
  followupInputs: [] as any[],
  awaitCalls: [] as Array<{ runIds: string[]; timeoutMs?: number }>,
  outcomes: [] as any[],
  sendInputs: [] as any[],
  sendResult: { success: true } as any,
  inbox: [] as any[],
}))

vi.mock('../../../electron/main/services/agent-runtime/runtime', () => ({
  default: {
    getInstance: () => ({
      launchSubAgent: (input: any) => {
        runtimeState.launchInputs.push(input)
        return runtimeState.launchQueue.shift() ?? { success: true, runId: 'run-default', targetEmployeeName: '小王' }
      },
      launchFollowup: (input: any) => {
        runtimeState.followupInputs.push(input)
        return runtimeState.launchQueue.shift() ?? { success: true, runId: 'run-followup', targetEmployeeName: '小王' }
      },
      awaitRuns: async (runIds: string[], timeoutMs?: number) => {
        runtimeState.awaitCalls.push({ runIds, timeoutMs })
        return runtimeState.outcomes
      },
      sendMessage: (runId: string, content: string, fromEmployeeName: string) => {
        runtimeState.sendInputs.push({ runId, content, fromEmployeeName })
        return runtimeState.sendResult
      },
      readMessages: () => runtimeState.inbox,
    }),
  },
}))

const dbState = vi.hoisted(() => ({ name: '主管小张' as string | null, throwErr: false }))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: () => ({
          get: () => {
            if (dbState.throwErr) throw new Error('db down')
            return dbState.name === null ? undefined : { name: dbState.name }
          },
        }),
      }),
    }),
  },
}))

const { delegateTool } = await import('../../../electron/main/services/agent/tools/delegate.tool')
const { followupTool } = await import('../../../electron/main/services/agent/tools/followup.tool')
const { launchAgentsTool, awaitAgentsTool } = await import('../../../electron/main/services/agent/tools/launch-agents.tool')
const { sendMessageTool, readMessagesTool } = await import('../../../electron/main/services/agent/tools/collab-messages.tool')

const run = <T>(store: any, fn: () => Promise<T>): Promise<T> =>
  interactionContext.run(store, fn)

function reset() {
  runtimeState.launchQueue = []
  runtimeState.launchInputs = []
  runtimeState.followupInputs = []
  runtimeState.awaitCalls = []
  runtimeState.outcomes = []
  runtimeState.sendInputs = []
  runtimeState.sendResult = { success: true }
  runtimeState.inbox = []
  dbState.name = '主管小张'
  dbState.throwErr = false
}

const PARENT = {
  sessionId: 's1',
  employeeId: 'boss',
  conversationId: 'conv-1',
  delegationDepth: 1,
  delegationChain: ['boss'],
  enableThinking: 'medium' as const,
  highPermission: true,
  abortSignal: undefined,
}

describe('agent/tools/delegate_to_employee', () => {
  beforeEach(reset)

  it('缺少会话上下文时拒绝', async () => {
    expect(await delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' })).toMatchObject({
      success: false, error: '委托失败：缺少会话上下文',
    })
    expect(runtimeState.launchInputs).toHaveLength(0)
  })

  it('派发失败时透传错误与目标员工名', async () => {
    runtimeState.launchQueue = [{ success: false, error: '深度超限', targetEmployeeName: '小王' }]
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res).toMatchObject({ success: false, error: '深度超限', targetEmployeeName: '小王' })
  })

  it('派发失败且无错误信息时给出兜底文案', async () => {
    runtimeState.launchQueue = [{ success: false }]
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res.error).toBe('委托失败')
    expect(res.success).toBe(false)
  })

  it('成功派发但聚合结果为空时报执行异常并保留 delegationId', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = []
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res).toMatchObject({ success: false, error: '委托执行异常', delegationId: 'r1', targetEmployeeName: '小王' })
  })

  it('成功：返回子员工输出与 token 用量', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: true, output: '完成报告', tokenUsage: { input: 10, output: 20 } }]
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res).toMatchObject({
      success: true, output: '完成报告', delegationId: 'r1', targetEmployeeName: '小王',
      tokenUsage: { input: 10, output: 20 },
    })
  })

  it('成功但无输出时给出默认完成文案', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: true }]
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res.output).toBe('已委托 小王 完成任务。')
  })

  it('子任务失败：返回错误、delegationId 与 token 用量', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: false, error: '发票无法读取', tokenUsage: { input: 1, output: 2 } }]
    const res = await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(res).toMatchObject({ success: false, error: '发票无法读取', delegationId: 'r1', tokenUsage: { input: 1, output: 2 } })
  })

  it('子任务失败且无错误信息时给出兜底文案', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: false }]
    expect((await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)).error)
      .toBe('委托执行失败')
  })

  it('上下文参数（深度/链/权限/思考/文件）完整下传给 runtime', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: true, output: 'ok' }]
    await run(PARENT, () => delegateTool.handler!({
      target_employee_id: 'e1',
      instruction: '做',
      context_files: ['D:\\a.docx'],
    }) as Promise<any>)
    expect(runtimeState.launchInputs[0]).toMatchObject({
      parentSessionId: 's1',
      parentEmployeeId: 'boss',
      parentConversationId: 'conv-1',
      targetEmployeeId: 'e1',
      instruction: '做',
      contextFiles: ['D:\\a.docx'],
      delegationDepth: 1,
      delegationChain: ['boss'],
      enableThinking: 'medium',
      highPermission: true,
    })
  })

  it('context_files 非数组/缺失时按空数组下传；缺省会话字段取默认值', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: true, output: 'ok' }]
    await run({ sessionId: 's2', employeeId: 'boss' }, () => delegateTool.handler!({
      target_employee_id: 'e1',
      instruction: '做',
      context_files: 'not-array',
    }) as Promise<any>)
    expect(runtimeState.launchInputs[0]).toMatchObject({
      contextFiles: [],
      parentConversationId: '',
      delegationDepth: 0,
      delegationChain: [],
      highPermission: false,
    })
  })

  it('同步等待使用默认超时（不显式传超时参数）', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r1', success: true, output: 'ok' }]
    await run(PARENT, () => delegateTool.handler!({ target_employee_id: 'e1', instruction: '做' }) as Promise<any>)
    expect(runtimeState.awaitCalls).toEqual([{ runIds: ['r1'], timeoutMs: undefined }])
  })

  it('并发两次委托互不干扰（各自 runId 与结果）', async () => {
    runtimeState.launchQueue = [
      { success: true, runId: 'r1', targetEmployeeName: '甲' },
      { success: true, runId: 'r2', targetEmployeeName: '乙' },
    ]
    const [a, b] = await Promise.all([
      run(PARENT, () => {
        runtimeState.outcomes = [{ runId: 'r1', success: true, output: '甲结果' }]
        return delegateTool.handler!({ target_employee_id: 'e1', instruction: 'A' }) as Promise<any>
      }),
      run(PARENT, () => {
        runtimeState.outcomes = [{ runId: 'r2', success: true, output: '乙结果' }]
        return delegateTool.handler!({ target_employee_id: 'e2', instruction: 'B' }) as Promise<any>
      }),
    ])
    expect(a.delegationId).not.toBe(b.delegationId)
    expect(a.targetEmployeeName).not.toBe(b.targetEmployeeName)
    expect(runtimeState.launchInputs.map(i => i.targetEmployeeId).sort()).toEqual(['e1', 'e2'])
  })

  it('工具元信息：常驻、不重试、5 分钟超时', () => {
    expect(delegateTool.id).toBe('delegate_to_employee')
    expect(delegateTool.onDemand).toBe(false)
    expect(delegateTool.noRetry).toBe(true)
    expect(delegateTool.timeoutMs).toBe(5 * 60 * 1000)
    expect(delegateTool.parameters.required).toEqual(['target_employee_id', 'instruction'])
  })
})

describe('agent/tools/followup_delegation', () => {
  beforeEach(reset)

  it('缺少会话上下文时拒绝', async () => {
    expect(await followupTool.handler!({ delegation_id: 'd1', instruction: '再改' })).toMatchObject({
      success: false, error: '追问失败：缺少会话上下文',
    })
  })

  it('派发失败时透传错误', async () => {
    runtimeState.launchQueue = [{ success: false, error: '委托未结束' }]
    const res = await run(PARENT, () => followupTool.handler!({ delegation_id: 'd1', instruction: '再改' }) as Promise<any>)
    expect(res).toMatchObject({ success: false, error: '委托未结束' })
  })

  it('成功：回显 followupOfDelegationId 与新 delegationId', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r2', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r2', success: true, output: '已修正', tokenUsage: { input: 3, output: 4 } }]
    const res = await run(PARENT, () => followupTool.handler!({ delegation_id: 'd1', instruction: '再改' }) as Promise<any>)
    expect(res).toMatchObject({
      success: true, output: '已修正', delegationId: 'r2', followupOfDelegationId: 'd1',
      targetEmployeeName: '小王', tokenUsage: { input: 3, output: 4 },
    })
    expect(runtimeState.followupInputs[0]).toMatchObject({ followupOfRunId: 'd1', instruction: '再改' })
  })

  it('成功但无输出时给出默认追问文案', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r2', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r2', success: true }]
    expect((await run(PARENT, () => followupTool.handler!({ delegation_id: 'd1', instruction: '再改' }) as Promise<any>)).output)
      .toBe('已追问 小王 并获得补充结果。')
  })

  it('聚合结果为空 / 子任务失败时给出对应错误', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r2', targetEmployeeName: '小王' }]
    runtimeState.outcomes = []
    expect((await run(PARENT, () => followupTool.handler!({ delegation_id: 'd1', instruction: '再改' }) as Promise<any>)).error)
      .toBe('追问执行异常')

    runtimeState.launchQueue = [{ success: true, runId: 'r3', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r3', success: false, error: '轮数超限' }]
    expect((await run(PARENT, () => followupTool.handler!({ delegation_id: 'd1', instruction: '再改' }) as Promise<any>)).error)
      .toBe('轮数超限')
  })

  it('非字符串参数被 String() 归一（undefined → 空串）', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r2', targetEmployeeName: '小王' }]
    runtimeState.outcomes = [{ runId: 'r2', success: true, output: 'ok' }]
    await run(PARENT, () => followupTool.handler!({ delegation_id: 123, instruction: null }) as Promise<any>)
    expect(runtimeState.followupInputs[0]).toMatchObject({ followupOfRunId: '123', instruction: '' })
  })

  it('工具元信息：常驻、不重试、5 分钟超时、必填参数', () => {
    expect(followupTool.onDemand).toBe(false)
    expect(followupTool.noRetry).toBe(true)
    expect(followupTool.timeoutMs).toBe(300000)
    expect(followupTool.parameters.required).toEqual(['delegation_id', 'instruction'])
  })
})

describe('agent/tools/launch_agents', () => {
  beforeEach(reset)

  const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ target_employee_id: `e${i}`, instruction: `task-${i}` }))

  it('tasks 非数组或为空时报错，且不派发', async () => {
    for (const value of [undefined, null, [], 'x', {}]) {
      const res = await run(PARENT, () => launchAgentsTool.handler!({ tasks: value }) as Promise<any>)
      expect(res).toMatchObject({ success: false, error: 'tasks 不能为空' })
    }
    expect(runtimeState.launchInputs).toHaveLength(0)
  })

  it('超过 5 个子任务被拒绝（上限边界）', async () => {
    const res = await run(PARENT, () => launchAgentsTool.handler!({ tasks: tasks(6) }) as Promise<any>)
    expect(res.success).toBe(false)
    expect(res.error).toBe('tasks 数量超限（最多 5 个，传入 6 个）')
    expect(runtimeState.launchInputs).toHaveLength(0)

    // 恰好 5 个可通过
    runtimeState.launchQueue = tasks(5).map((_, i) => ({ success: true, runId: `r${i}`, targetEmployeeName: `n${i}` }))
    const ok = await run(PARENT, () => launchAgentsTool.handler!({ tasks: tasks(5) }) as Promise<any>)
    expect(ok.success).toBe(true)
    expect(ok.runIds).toHaveLength(5)
  })

  it('缺少会话上下文时拒绝', async () => {
    expect(await launchAgentsTool.handler!({ tasks: tasks(1) })).toMatchObject({
      success: false, error: '并行派发失败：缺少会话上下文',
    })
  })

  it('逐项校验：缺少 target_employee_id / instruction 记为失败并保留索引', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '甲' }]
    const res = await run(PARENT, () => launchAgentsTool.handler!({
      tasks: [
        { target_employee_id: 'e1', instruction: 'ok' },
        { target_employee_id: 123, instruction: 'bad-id' },
        { target_employee_id: 'e2', instruction: '   ' },
        { target_employee_id: 'e3' },
        {},
      ],
    }) as Promise<any>)
    expect(res.success).toBe(true)
    expect(res.runIds).toEqual(['r1'])
    expect(res.failed).toEqual([
      { index: 1, error: '缺少 target_employee_id' },
      { index: 2, error: '缺少 instruction' },
      { index: 3, error: '缺少 instruction' },
      { index: 4, error: '缺少 target_employee_id' },
    ])
    expect(res.output).toContain('已并行派发 1 个子任务')
    expect(res.output).toContain('请随后调用 await_agents(run_ids) 等待结果')
    expect(res.output).toContain('2. 缺少 target_employee_id')
  })

  it('全部失败时列出失败明细（不输出「全部子任务派发失败」兜底分支）', async () => {
    runtimeState.launchQueue = [{ success: false, error: '员工不存在' }]
    const res = await run(PARENT, () => launchAgentsTool.handler!({ tasks: tasks(1) }) as Promise<any>)
    expect(res.success).toBe(false)
    expect(res.runIds).toEqual([])
    expect(res.output).toContain('以下子任务派发失败：')
    expect(res.output).not.toContain('全部子任务派发失败')
  })

  it('context_files 非数组时下传空数组', async () => {
    runtimeState.launchQueue = [{ success: true, runId: 'r1', targetEmployeeName: '甲' }]
    await run(PARENT, () => launchAgentsTool.handler!({
      tasks: [{ target_employee_id: 'e1', instruction: 'ok', context_files: 'bad' }],
    }) as Promise<any>)
    expect(runtimeState.launchInputs[0].contextFiles).toEqual([])
  })

  it('工具元信息：常驻、不重试、无自定义超时', () => {
    expect(launchAgentsTool.onDemand).toBe(false)
    expect(launchAgentsTool.noRetry).toBe(true)
    expect(launchAgentsTool.timeoutMs).toBeUndefined()
    expect(launchAgentsTool.parameters.required).toEqual(['tasks'])
  })
})

describe('agent/tools/await_agents', () => {
  beforeEach(reset)

  it('run_ids 非数组/为空/全为假值时报错，且不等待', async () => {
    for (const value of [undefined, [], '', ['', null, undefined], 'r1']) {
      const res = await awaitAgentsTool.handler!({ run_ids: value }) as Promise<any>
      expect(res).toMatchObject({ success: false, error: 'run_ids 不能为空' })
    }
    expect(runtimeState.awaitCalls).toHaveLength(0)
  })

  it('timeout_seconds 夹取到 (0, 300] 秒，缺省 280s', async () => {
    runtimeState.outcomes = []
    await awaitAgentsTool.handler!({ run_ids: ['r1'] })
    await awaitAgentsTool.handler!({ run_ids: ['r1'], timeout_seconds: 1000 })
    await awaitAgentsTool.handler!({ run_ids: ['r1'], timeout_seconds: 0 })
    await awaitAgentsTool.handler!({ run_ids: ['r1'], timeout_seconds: -5 })
    await awaitAgentsTool.handler!({ run_ids: ['r1'], timeout_seconds: '30' })
    expect(runtimeState.awaitCalls.map(c => c.timeoutMs)).toEqual([280000, 300000, 280000, 280000, 280000])
  })

  it('聚合成功/失败结果，部分成功时 success 为 true', async () => {
    runtimeState.outcomes = [
      { runId: 'r1', success: true, output: '第一行\n第二行' },
      { runId: 'r2', success: false, error: '失败原因' },
    ]
    const res = await awaitAgentsTool.handler!({ run_ids: ['r1', 'r2'] }) as Promise<any>
    expect(res.success).toBe(true)
    expect(res.output).toBe('[✓ r1] 第一行\n[✗ r2] 失败原因')
    expect(res.results).toHaveLength(2)
  })

  it('全部失败时 success 为 false', async () => {
    runtimeState.outcomes = [{ runId: 'r1', success: false, error: 'boom' }]
    const res = await awaitAgentsTool.handler!({ run_ids: ['r1'] }) as Promise<any>
    expect(res.success).toBe(false)
    expect(res.output).toBe('[✗ r1] boom')
  })

  it('成功但无输出的子任务显示「已完成」，超长首行被截断为 120 字符', async () => {
    runtimeState.outcomes = [
      { runId: 'r1', success: true },
      { runId: 'r2', success: true, output: 'X'.repeat(200) },
    ]
    const res = await awaitAgentsTool.handler!({ run_ids: ['r1', 'r2'] }) as Promise<any>
    expect(res.output).toContain('[✓ r1] 已完成')
    expect(res.output).toContain(`[✓ r2] ${'X'.repeat(120)}…`)
    expect(res.output).not.toContain('X'.repeat(121))
  })

  it('空结果集时 success 为 false 且输出为空串', async () => {
    runtimeState.outcomes = []
    const res = await awaitAgentsTool.handler!({ run_ids: ['r1'] }) as Promise<any>
    expect(res).toMatchObject({ success: false, output: '', results: [] })
  })

  it('工具元信息：常驻、不重试、5 分钟超时（覆盖默认等待 280s）', () => {
    expect(awaitAgentsTool.onDemand).toBe(false)
    expect(awaitAgentsTool.noRetry).toBe(true)
    expect(awaitAgentsTool.timeoutMs).toBe(300000)
    expect(awaitAgentsTool.parameters.required).toEqual(['run_ids'])
  })
})

describe('agent/tools/collab-messages', () => {
  beforeEach(reset)

  it('send_message：缺少 run_id 或非字符串时拒绝', async () => {
    expect(await sendMessageTool.handler!({ message: 'hi' })).toMatchObject({ success: false, error: '缺少 run_id' })
    expect(await sendMessageTool.handler!({ run_id: 123, message: 'hi' })).toMatchObject({ success: false, error: '缺少 run_id' })
    expect(runtimeState.sendInputs).toHaveLength(0)
  })

  it('send_message：空消息（含纯空白）被拒绝', async () => {
    expect(await sendMessageTool.handler!({ run_id: 'r1', message: '' })).toMatchObject({ success: false, error: '消息内容不能为空' })
    expect(await sendMessageTool.handler!({ run_id: 'r1', message: '   ' })).toMatchObject({ success: false, error: '消息内容不能为空' })
  })

  it('send_message：runtime 拒绝时透传错误', async () => {
    runtimeState.sendResult = { success: false, error: 'run 已结束' }
    expect(await run(PARENT, () => sendMessageTool.handler!({ run_id: 'r1', message: 'hi' }) as Promise<any>))
      .toMatchObject({ success: false, error: 'run 已结束' })
  })

  it('send_message：成功时带发送方名称（来自员工表）', async () => {
    const res = await run(PARENT, () => sendMessageTool.handler!({ run_id: 'r1', message: '补充要求' }) as Promise<any>)
    expect(res).toMatchObject({ success: true, output: '已向子任务 r1 发送消息。' })
    expect(runtimeState.sendInputs[0]).toEqual({ runId: 'r1', content: '补充要求', fromEmployeeName: '主管小张' })
  })

  it('send_message：员工名查询失败/无记录时回退「主管」', async () => {
    dbState.name = null
    await run(PARENT, () => sendMessageTool.handler!({ run_id: 'r1', message: 'hi' }) as Promise<any>)
    expect(runtimeState.sendInputs[0].fromEmployeeName).toBe('主管')

    dbState.throwErr = true
    await run(PARENT, () => sendMessageTool.handler!({ run_id: 'r1', message: 'hi' }) as Promise<any>)
    expect(runtimeState.sendInputs[1].fromEmployeeName).toBe('主管')
  })

  it('send_message：无会话上下文时也可发送（查不到员工名则回退「主管」）', async () => {
    dbState.name = null
    const res = await sendMessageTool.handler!({ run_id: 'r1', message: 'hi' }) as Promise<any>
    expect(res.success).toBe(true)
    expect(runtimeState.sendInputs[0].fromEmployeeName).toBe('主管')
  })

  it('read_messages：无子任务上下文时拒绝', async () => {
    expect(await readMessagesTool.handler!({})).toMatchObject({ success: false, error: '当前上下文未关联子任务运行' })
    expect(await run({ sessionId: 's', employeeId: 'e' }, () => readMessagesTool.handler!({}) as Promise<any>))
      .toMatchObject({ success: false, error: '当前上下文未关联子任务运行' })
  })

  it('read_messages：无新消息时给出提示', async () => {
    runtimeState.inbox = []
    expect(await run({ sessionId: 's', employeeId: 'e', delegationId: 'r1' }, () => readMessagesTool.handler!({}) as Promise<any>))
      .toMatchObject({ success: true, output: '暂无新消息' })
  })

  it('read_messages：格式化多条消息并回传原始数组', async () => {
    runtimeState.inbox = [
      { fromEmployeeName: '主管', content: '补充一' },
      { fromEmployeeName: '同事', content: '补充二' },
    ]
    const res = await run({ sessionId: 's', employeeId: 'e', delegationId: 'r1' }, () => readMessagesTool.handler!({}) as Promise<any>)
    expect(res.success).toBe(true)
    expect(res.output).toBe('收到 2 条消息：\n[来自 主管] 补充一\n[来自 同事] 补充二')
    expect(res.messages).toHaveLength(2)
  })

  it('两个工具均为常驻且无参数校验（read_messages 无参数）', () => {
    expect(sendMessageTool.onDemand).toBe(false)
    expect(sendMessageTool.parameters.required).toEqual(['run_id', 'message'])
    expect(readMessagesTool.onDemand).toBe(false)
    expect(readMessagesTool.parameters.properties).toEqual({})
  })
})
