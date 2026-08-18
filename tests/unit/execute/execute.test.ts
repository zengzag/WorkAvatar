import { describe, it, expect, vi } from 'vitest'
import { createExecuteService, type ExecuteDeps } from '../../../electron/main/services/plugin/plugin-execute'

function makeDeps(overrides: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    runAgentTask: vi.fn(async () => ({ conversationId: 'c1', text: '结果' })),
    runAgentChat: vi.fn(async () => {}),
    runLlmChat: vi.fn(async () => 'llm 回复'),
    runLlmStream: vi.fn(async () => '流式累积'),
    ...overrides,
  }
}

describe('createExecuteService.execute', () => {
  it('agent-task 需要 employeeId', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-task', prompt: 'x' })).rejects.toThrow('employeeId')
  })

  it('agent-task 需要 prompt', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-task', employeeId: 'e1' })).rejects.toThrow('prompt')
  })

  it('agent-task 分发到 runAgentTask', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    const result = await svc.execute({ kind: 'agent-task', employeeId: 'e1', prompt: '任务' })
    expect(result).toEqual({ conversationId: 'c1', text: '结果' })
    expect(deps.runAgentTask).toHaveBeenCalledWith(
      { employeeId: 'e1', prompt: '任务', conversationId: undefined },
      undefined,
      undefined,
    )
  })

  it('agent-chat 需要 providerId', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-chat', employeeId: 'e1', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow('providerId')
  })

  it('agent-chat 需要 messages', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-chat', employeeId: 'e1', providerId: 'p1' })).rejects.toThrow('messages')
  })

  it('agent-chat 分发到 runAgentChat', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await svc.execute({
      kind: 'agent-chat',
      employeeId: 'e1',
      providerId: 'p1',
      messages: [{ role: 'user', content: 'x' }],
      useSkills: true,
    })
    expect(deps.runAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', providerId: 'p1', useSkills: true }),
      undefined,
      undefined,
    )
  })

  it('llm-chat 需要 prompt', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'llm-chat' })).rejects.toThrow('prompt')
  })

  it('llm-chat 分发到 runLlmChat', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    const result = await svc.execute({ kind: 'llm-chat', prompt: '你好', system: 'sys' })
    expect(result).toBe('llm 回复')
    expect(deps.runLlmChat).toHaveBeenCalledWith({ prompt: '你好', system: 'sys', providerId: undefined, modelId: undefined })
  })

  it('llm-stream 分发到 runLlmStream', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    const result = await svc.execute({ kind: 'llm-stream', prompt: '流式', temperature: 0.5 })
    expect(result).toBe('流式累积')
    expect(deps.runLlmStream).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '流式', temperature: 0.5 }),
      undefined,
      undefined,
    )
  })

  it('未知 kind 拒绝', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'hack' as never })).rejects.toThrow('未知执行类型')
  })
})

describe('execute 边界 case', () => {
  it('agent-task 空字符串 prompt 拒绝', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-task', employeeId: 'e1', prompt: '' })).rejects.toThrow('prompt')
  })

  it('agent-chat 空 messages 数组拒绝', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'agent-chat', employeeId: 'e1', providerId: 'p1', messages: [] }))
      .rejects.toThrow('messages')
  })

  it('llm-chat 空字符串 prompt 拒绝', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'llm-chat', prompt: '' })).rejects.toThrow('prompt')
  })

  it('llm-stream 空字符串 prompt 拒绝', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await expect(svc.execute({ kind: 'llm-stream', prompt: '' })).rejects.toThrow('prompt')
  })

  it('agent-task 透传 callbacks 和 signal', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    const callbacks = { onChunk: vi.fn() }
    const signal = new AbortController().signal
    await svc.execute({ kind: 'agent-task', employeeId: 'e1', prompt: 'p' }, callbacks, signal)
    expect(deps.runAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'e1', prompt: 'p' }),
      callbacks,
      signal,
    )
  })

  it('agent-chat 透传全部可选参数', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await svc.execute({
      kind: 'agent-chat',
      employeeId: 'e1',
      providerId: 'p1',
      modelId: 'm1',
      messages: [{ role: 'user', content: 'x' }],
      conversationId: 'c1',
      useSkills: true,
      enableThinking: true,
      minimalMode: false,
      highPermission: true,
    })
    expect(deps.runAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 'e1', providerId: 'p1', modelId: 'm1', conversationId: 'c1',
        useSkills: true, enableThinking: true, minimalMode: false, highPermission: true,
      }),
      undefined,
      undefined,
    )
  })

  it('llm-stream 透传 history/system/provider/model/temperature/maxTokens', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await svc.execute({
      kind: 'llm-stream',
      prompt: 'p',
      history: ['h1'],
      system: 'sys',
      providerId: 'p1',
      modelId: 'm1',
      temperature: 0.3,
      maxTokens: 100,
    })
    expect(deps.runLlmStream).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'p', history: ['h1'], system: 'sys', providerId: 'p1', modelId: 'm1',
        temperature: 0.3, maxTokens: 100,
      }),
      undefined,
      undefined,
    )
  })

  it('llm-chat 透传 system/provider/model', async () => {
    const deps = makeDeps()
    const svc = createExecuteService(deps)
    await svc.execute({ kind: 'llm-chat', prompt: 'p', system: 'sys', providerId: 'p1', modelId: 'm1' })
    expect(deps.runLlmChat).toHaveBeenCalledWith({ prompt: 'p', system: 'sys', providerId: 'p1', modelId: 'm1' })
  })

  it('agent-task 返回 runAgentTask 结果', async () => {
    const deps = makeDeps()
    deps.runAgentTask = vi.fn(async () => ({ conversationId: 'c9', text: '结果9' }))
    const svc = createExecuteService(deps)
    const result = await svc.execute({ kind: 'agent-task', employeeId: 'e1', prompt: 'p' })
    expect(result).toEqual({ conversationId: 'c9', text: '结果9' })
  })

  it('agent-chat 返回会话 id', async () => {
    const deps = makeDeps()
    deps.runAgentChat = vi.fn(async () => ({ conversationId: 'c10' }))
    const svc = createExecuteService(deps)
    const result = await svc.execute({ kind: 'agent-chat', employeeId: 'e1', providerId: 'p1', messages: [{ role: 'user', content: 'x' }] })
    expect(result).toEqual({ conversationId: 'c10' })
  })
})
