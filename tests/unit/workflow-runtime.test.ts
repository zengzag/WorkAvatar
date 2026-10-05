import { describe, it, expect, vi, beforeEach } from 'vitest'

const { launchSubAgent, awaitRuns, cancelRun, registerInlineEmployee, broadcastWorkflowRunEvent, resolveEmployeeLLM } = vi.hoisted(() => ({
  launchSubAgent: vi.fn(),
  awaitRuns: vi.fn(),
  cancelRun: vi.fn(() => true),
  registerInlineEmployee: vi.fn(),
  broadcastWorkflowRunEvent: vi.fn(),
  resolveEmployeeLLM: vi.fn(async () => ({ providerId: 'p1', modelId: 'm1' })),
}))

vi.mock('../../electron/main/services/database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: vi.fn(() => ({
          get: () => undefined,
          all: () => [],
          run: () => ({ changes: 1 }),
        })),
      }),
    }),
  },
}))

vi.mock('../../electron/main/services/workspace-manager.service', () => ({
  default: {
    getInstance: () => ({
      createConversation: vi.fn(() => ({ id: 'wconv1', workspace_path: '' })),
      getConversationWorkspacePath: vi.fn(() => ''),
      deleteConversation: vi.fn(() => ({ taskDir: '', taskDirNonEmpty: false })),
      getEmployee: vi.fn(),
    }),
  },
}))

vi.mock('../../electron/main/services/employee-registry.service', () => ({
  default: {
    getInstance: () => ({
      registerInlineEmployee,
      unregisterInlineEmployee: vi.fn(),
      toInlineRegisteredEmployee: vi.fn((id: string, spec: any) => ({ id, name: spec?.name || 'role', source: 'inline', ...spec })),
      getRegistered: vi.fn(() => undefined),
    }),
  },
}))

vi.mock('../../electron/main/services/memory-refinement.service', () => ({
  default: {
    getInstance: () => ({ resolveEmployeeLLM }),
  },
}))

vi.mock('../../electron/main/services/common-utils', () => ({
  generateId: vi.fn(() => `wrun_${Math.random().toString(36).slice(2, 10)}`),
}))

vi.mock('../../electron/main/services/workflow-events', () => ({
  broadcastWorkflowRunEvent: (...args: any[]) => broadcastWorkflowRunEvent(...args),
}))

vi.mock('../../electron/main/services/agent-runtime/runtime', () => ({
  default: { getInstance: () => ({ launchSubAgent, awaitRuns, cancelRun }) },
}))

import WorkflowRuntimeService from '../../electron/main/services/workflow-runtime.service'

const runParams = () => ({
  templateName: '测试模板',
  graph: { nodes: [{ id: 'n1', label: '研究节点', type: 'agent', instruction: '完成研究' }], edges: [] } as any,
  variables: {},
})

/** 轮询等待 run:end 广播（后台执行） */
const waitForRunEnd = async (maxMs = 3000) => {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (broadcastWorkflowRunEvent.mock.calls.some(c => c[0]?.eventType === 'run:end')) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return false
}

describe('WorkflowRuntimeService 节点取消', () => {
  let service: WorkflowRuntimeService

  beforeEach(() => {
    vi.clearAllMocks()
    resolveEmployeeLLM.mockResolvedValue({ providerId: 'p1', modelId: 'm1' })
    launchSubAgent.mockImplementation(() => ({
      success: true, runId: 'sub-run-1', targetEmployeeId: 'inline:workflow-runner', targetEmployeeName: '宿主员工',
    }))
    cancelRun.mockClear().mockReturnValue(true)
    service = WorkflowRuntimeService.getInstance()
  })

  it('节点等待失败（success:false）后取消子 run 防孤儿', async () => {
    awaitRuns.mockResolvedValue([{ runId: 'sub-run-1', status: 'running', success: false }])

    const run = await service.startRun(runParams())
    expect(await waitForRunEnd()).toBe(true)

    expect(awaitRuns).toHaveBeenCalledWith(['sub-run-1'], expect.any(Number))
    // 超时/失败分支必须对子 run 执行取消（防孤儿继续烧 token）
    expect(cancelRun).toHaveBeenCalledWith('sub-run-1')
    // 无产出 → 节点与运行整体置为失败
    expect(run.status).toBe('failed') // startRun 返回的是同对象引用，executeRun 就地更新
  })

  it('节点成功（success:true）不触发 cancelRun', async () => {
    awaitRuns.mockResolvedValue([{ runId: 'sub-run-1', status: 'completed', success: true, output: '研究完成' }])

    const run = await service.startRun(runParams())
    expect(await waitForRunEnd()).toBe(true)
    expect(cancelRun).not.toHaveBeenCalled()
    expect(run.status).toBe('completed')
  })
})
