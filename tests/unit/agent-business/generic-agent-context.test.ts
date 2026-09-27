import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as any[],
  impl: (() => Promise.resolve({})) as (params: any) => Promise<any>,
}))

vi.mock('../../../electron/main/services/agent/core/pi-agent-adapter', () => ({
  runPiAgentLoop: (params: any) => {
    h.calls.push(params)
    return h.impl(params)
  },
}))

vi.mock('../../../electron/main/services/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

import { GenericAgent } from '../../../electron/main/services/agent/business/generic-agent'
import { EmployeeAgent } from '../../../electron/main/services/agent/business/employee-agent'
import type { ToolDefinition } from '../../../electron/main/services/agent/tools/types'
import { STABLE_CONTEXT_MSG_PREFIX, TASK_CONTEXT_MSG_PREFIX } from '../../../electron/main/services/agent/business/prompts'

const onDemandTool: ToolDefinition = {
  id: 'calendar_create',
  name: 'calendar_create',
  title: '创建日程',
  description: 'create calendar event',
  parameters: { type: 'object', properties: {} },
  handler: async () => ({ success: true, output: 'ok' }),
  source: 'builtin',
  onDemand: true,
}

const makeAgent = () =>
  new GenericAgent({ model: 'gpt-x', providerType: 'openai', autoDiscoverSkills: false })

beforeEach(() => {
  h.calls = []
  h.impl = () => Promise.resolve({})
})

describe('GenericAgent / 上下文装配顺序与缓存', () => {
  it('消息顺序：system → 稳定锚点 → history → 任务尾部 → query', async () => {
    const agent = makeAgent()
    agent.registerTool(onDemandTool)
    agent.updateWorkspaceContextPrompt('Current task workspace: /ws')
    agent.updateTaskTimePrompt('Task started at: 2026-09-26 09:00')
    agent.updateMemoryPrompt('- 用户偏好简洁回复')

    await agent.runStream(
      { query: '最终问题', history: [{ role: 'user', content: 'h1' }, { role: 'assistant', content: 'a1' }] },
      {},
      new AbortController().signal
    )

    const params = h.calls[0]
    const contents = params.messages.map((m: any) => m.content as string)
    expect(contents[0]).toContain('helpful AI assistant operating inside WorkAvatar')
    expect(contents[1].startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(contents[1]).toContain('calendar_create')
    expect(contents.slice(2, 4)).toEqual(['h1', 'a1'])
    expect(contents[contents.length - 2].startsWith(TASK_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(contents[contents.length - 2]).toContain('<workspace>Current task workspace: /ws</workspace>')
    expect(contents[contents.length - 2]).toContain('<task_time>Task started at: 2026-09-26 09:00</task_time>')
    expect(contents[contents.length - 2]).toContain('<memory>- 用户偏好简洁回复</memory>')
    expect(contents[contents.length - 1]).toBe('最终问题')
  })

  it('稳定锚点首次构建后字节冻结；任务尾部变化与历史增长都不改变锚点', async () => {
    const agent = makeAgent()
    agent.registerTool(onDemandTool)
    agent.updateMemoryPrompt('M1')

    await agent.runStream({ query: 'q1', history: [] }, {}, new AbortController().signal)
    const head1 = h.calls[0].messages[1].content
    expect(head1.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)

    agent.updateMemoryPrompt('M2')
    await agent.runStream(
      { query: 'q2', history: [{ role: 'user', content: 'h1' }, { role: 'assistant', content: 'a1' }] },
      {},
      new AbortController().signal
    )
    expect(h.calls[1].messages[1].content).toBe(head1)
    expect(h.calls[1].messages.at(-2).content).toContain('M2')
    expect(h.calls[1].messages.at(-2).content).not.toContain('M1')
  })

  it('已存在的旧合成上下文消息在装配前被过滤，不重复堆积', async () => {
    const agent = makeAgent()
    agent.updateMemoryPrompt('M')
    const staleHead = { role: 'user' as const, content: `${STABLE_CONTEXT_MSG_PREFIX}\nstale-head` }
    const staleTail = { role: 'user' as const, content: `${TASK_CONTEXT_MSG_PREFIX}\nstale-tail` }
    await agent.runStream(
      { query: 'q', history: [staleHead, { role: 'user', content: 'real' }, staleTail] },
      {},
      new AbortController().signal
    )
    const contents = h.calls[0].messages.map((m: any) => m.content)
    expect(contents.filter((c: string) => c.includes('stale-head'))).toHaveLength(0)
    expect(contents.filter((c: string) => c.includes('stale-tail'))).toHaveLength(0)
    expect(contents).toContain('real')
  })

  it('无稳定/任务内容时不产生合成消息', async () => {
    const agent = makeAgent()
    await agent.runStream({ query: 'q', history: [{ role: 'user', content: 'h1' }] }, {}, new AbortController().signal)
    const roles = h.calls[0].messages.map((m: any) => m.role)
    expect(roles).toEqual(['system', 'user', 'user']) // system + h1 + query
  })
})

describe('GenericAgent / minimal 模式', () => {
  it('不注入任务尾部、不传任何工具、不产生提醒', async () => {
    const agent = makeAgent()
    agent.setMinimalMode(true)
    agent.updateMemoryPrompt('M')
    agent.updateWorkspaceContextPrompt('W')
    await agent.runStream({ query: 'q', history: [] }, {}, new AbortController().signal)
    const params = h.calls[0]
    expect(params.toolDefinitions).toEqual([])
    expect(params.messages).toHaveLength(2) // system + query
    expect((agent as any).buildLoopReminder(10, 100)).toBeUndefined()
  })
})

describe('GenericAgent / todo_write 与循环提醒', () => {
  it('todo_write 为常驻工具（出现在 tools schema 中）', async () => {
    const agent = makeAgent()
    await agent.runStream({ query: 'q' }, {}, new AbortController().signal)
    const names = h.calls[0].toolDefinitions.map((d: any) => d.function.name)
    expect(names).toContain('todo_write')
  })

  it('每次 run 重置 todo 状态；节流提醒经 buildLoopReminder 输出', async () => {
    const agent = makeAgent()
    const store = (agent as any).todoStore
    store.replace([{ content: 'step1', status: 'in_progress', priority: 'high' }])
    expect((agent as any).buildLoopReminder(10, 100)).toContain('<system-reminder>')
    // 已标记第 10 轮，11 轮不重复
    expect((agent as any).buildLoopReminder(11, 100)).toBeUndefined()
    // run 开始后重置
    await agent.runStream({ query: 'q' }, {}, new AbortController().signal)
    expect(store.hasItems()).toBe(false)
  })
})

describe('EmployeeAgent / 稳定能力块', () => {
  it('Delegation 段与按需工具声明进入稳定锚点，system prompt 不含其内容', async () => {
    const agent = new EmployeeAgent(
      {
        name: '主管',
        instructions: '',
        model: 'gpt-x',
        autoDiscoverSkills: false,
        delegationTargets: [{ id: 'e2', name: '研究员', description: '查资料' }],
      },
      undefined
    )
    agent.registerTool(onDemandTool)
    agent.updateMemoryPrompt('M')

    await agent.runStream({ query: 'q', history: [] }, {}, new AbortController().signal)
    const params = h.calls[0]
    const system = params.messages[0].content as string
    const head = params.messages[1].content as string
    expect(system).toContain('digital employee named "主管"')
    expect(system).not.toContain('Delegation (multi-employee collaboration)')
    expect(head.startsWith(STABLE_CONTEXT_MSG_PREFIX)).toBe(true)
    expect(head).toContain('Delegation (multi-employee collaboration)')
    expect(head).toContain('- 研究员 (id=e2): 查资料')
    expect(head).toContain('calendar_create')
    // 任务信息仍在尾部
    expect(params.messages.at(-2).content).toContain('<memory>M</memory>')
  })

  it('无委托目标时锚点不出现 Delegation 段', async () => {
    const agent = new EmployeeAgent(
      { name: '主管', instructions: '', model: 'gpt-x', autoDiscoverSkills: false },
      undefined
    )
    await agent.runStream({ query: 'q' }, {}, new AbortController().signal)
    const params = h.calls[0]
    // 无技能/按需工具/委托 → 无稳定锚点
    expect(params.messages.some((m: any) => m.content.startsWith(STABLE_CONTEXT_MSG_PREFIX))).toBe(false)
  })
})
