/**
 * 记忆精炼调度服务单测（DB/记忆服务/LLM 客户端打桩）：
 * - resolveEmployeeLLM 的模型解析优先级（settings → 兜底 provider）与各类解析失败回落
 * - extractManually 的错误码分支与成功路径参数（manually 全量提取）
 * - runCheck 的候选筛选、失败推进提取指针、空消息处理
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const settings = new Map<string, string>()
  const conversations = new Map<string, any>()
  const employees = new Map<string, any>()
  const providers: any[] = []
  const updates: Array<{ sql: string; args: any[] }> = []
  const candidateRows: any[] = []
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

  const db = {
    prepare(sql: string) {
      const s = norm(sql)
      if (s.startsWith('SELECT c.id, c.employee_id') && s.includes('FROM conversations c')) {
        return { all: (..._args: any[]) => candidateRows }
      }
      if (s === 'SELECT id, employee_id, title, messages_json, message_count, memory_extracted_message_count FROM conversations WHERE id = ?') {
        return { get: (id: string) => conversations.get(id) }
      }
      if (s === 'SELECT memory_enabled FROM employees WHERE id = ?') {
        return { get: (id: string) => employees.get(id) }
      }
      if (s === 'SELECT value FROM settings WHERE key = ?') {
        return { get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined) }
      }
      if (s === 'SELECT id FROM llm_providers ORDER BY is_default DESC LIMIT 1') {
        return { get: () => providers[0] }
      }
      if (s.startsWith('UPDATE conversations SET memory_extracted_at = unixepoch(), memory_extracted_message_count = ?')) {
        return {
          run: (...args: any[]) => {
            updates.push({ sql: 'advance', args })
            return { changes: 1 }
          },
        }
      }
      if (s === 'UPDATE conversations SET memory_extracted_at = unixepoch() WHERE id = ?') {
        return {
          run: (...args: any[]) => {
            updates.push({ sql: 'touch', args })
            return { changes: 1 }
          },
        }
      }
      throw new Error(`unexpected sql: ${s}`)
    },
  }

  const memoryService = {
    extractMemoriesFromConversation: vi.fn(async () => undefined),
    removeStaleMemories: vi.fn(),
    autoConsolidateIfNeeded: vi.fn(async () => undefined),
  }
  const providerConfigs = new Map<string, any>()
  const llm = { getProviderConfig: vi.fn(async (id: string) => providerConfigs.get(id) ?? null) }

  return {
    settings, conversations, employees, providers, updates, candidateRows,
    db, memoryService, providerConfigs, llm,
  }
})

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => mockState.db }) },
}))

vi.mock('../../../electron/main/services/employee-memory.service', () => ({
  default: { getInstance: () => mockState.memoryService },
}))

vi.mock('../../../electron/main/services/llm-client.service', () => ({
  default: { getInstance: () => mockState.llm },
}))

import MemoryRefinementService from '../../../electron/main/services/memory-refinement.service'

const service = MemoryRefinementService.getInstance()
const priv = service as any

function provider(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'p1',
    model: 'provider-default-model',
    models_json: JSON.stringify([
      { id: 'alias', model: 'gpt-real', category: 'chat' },
      { id: 'embed', model: 'embed-model', category: 'embedding' },
    ]),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockState.settings.clear()
  mockState.conversations.clear()
  mockState.employees.clear()
  mockState.providers.length = 0
  mockState.updates.length = 0
  mockState.candidateRows.length = 0
  mockState.providerConfigs.clear()
  mockState.memoryService.extractMemoriesFromConversation.mockResolvedValue(undefined)
})

describe('memory-refinement / resolveEmployeeLLM', () => {
  it('优先使用 default_model_memory 且按 id 解析真实模型名', async () => {
    mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'p1', model_id: 'alias' }))
    mockState.providerConfigs.set('p1', provider())
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'p1', modelId: 'gpt-real' })
  })

  it('model_id 为空（或纯空白）时取第一个 chat 模型', async () => {
    mockState.providerConfigs.set('p1', provider())
    for (const model_id of ['', '   ', undefined]) {
      mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'p1', model_id }))
      await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'p1', modelId: 'gpt-real' })
    }
  })

  it('model_id 未命中 models_json 时原样使用（回落到标识符）', async () => {
    mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'p1', model_id: 'unknown-id' }))
    mockState.providerConfigs.set('p1', provider())
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'p1', modelId: 'unknown-id' })
  })

  it('优先取 default_model_memory，失败后回落 default_model_workbench', async () => {
    mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'missing' }))
    mockState.settings.set('default_model_workbench', JSON.stringify({ provider_id: 'p2', model_id: 'alias' }))
    mockState.providerConfigs.set('p2', provider({ id: 'p2' }))
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'p2', modelId: 'gpt-real' })
  })

  it('setting 非法 JSON / 缺 provider_id 时被跳过', async () => {
    mockState.settings.set('default_model_memory', '{bad json')
    mockState.settings.set('default_model_workbench', JSON.stringify({ model_id: 'alias' }))
    mockState.providers.push({ id: 'fallback' })
    mockState.providerConfigs.set('fallback', provider({ id: 'fallback' }))
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'fallback', modelId: 'gpt-real' })
  })

  it('无任何 setting 时兜底取 llm_providers 首行', async () => {
    mockState.providers.push({ id: 'fallback' })
    mockState.providerConfigs.set('fallback', provider({ id: 'fallback' }))
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'fallback', modelId: 'gpt-real' })
  })

  it('无 provider 可用时返回 null', async () => {
    await expect(service.resolveEmployeeLLM()).resolves.toBeNull()
  })

  it('provider 配置缺失（getProviderConfig 返回 null）时回落/返回 null', async () => {
    mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'ghost', model_id: 'x' }))
    await expect(service.resolveEmployeeLLM()).resolves.toBeNull()
  })

  it('models_json 非法或缺失时使用 provider.model', async () => {
    mockState.providers.push({ id: 'fallback' })
    mockState.providerConfigs.set('fallback', provider({ id: 'fallback', models_json: '{oops' }))
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'fallback', modelId: 'provider-default-model' })

    mockState.providerConfigs.set('fallback', provider({ id: 'fallback', models_json: undefined }))
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'fallback', modelId: 'provider-default-model' })
  })

  it('解析结果为空字符串时返回 null', async () => {
    mockState.providers.push({ id: 'fallback' })
    mockState.providerConfigs.set('fallback', { id: 'fallback', model: '   ', models_json: '[]' })
    await expect(service.resolveEmployeeLLM()).resolves.toBeNull()
  })

  it('仅 embedding 模型时不选为 chat 模型（无匹配时回落 models[0]）', async () => {
    mockState.settings.set('default_model_memory', JSON.stringify({ provider_id: 'p3' }))
    mockState.providerConfigs.set('p3', {
      id: 'p3',
      model: 'p3-default',
      models_json: JSON.stringify([{ id: 'only-embed', model: 'embed-x', category: 'embedding' }]),
    })
    await expect(service.resolveEmployeeLLM()).resolves.toEqual({ providerId: 'p3', modelId: 'embed-x' })
  })
})

describe('memory-refinement / extractManually', () => {
  it('对话不存在', async () => {
    await expect(service.extractManually('nope')).resolves.toEqual({
      success: false,
      error: 'CONVERSATION_NOT_FOUND',
    })
  })

  it('员工未开启记忆', async () => {
    mockState.conversations.set('c1', { id: 'c1', employee_id: 'e1', messages_json: '[{"role":"user","content":"x"}]', message_count: 1 })
    mockState.employees.set('e1', { memory_enabled: 0 })
    await expect(service.extractManually('c1')).resolves.toEqual({
      success: false,
      error: 'MEMORY_NOT_ENABLED',
    })
  })

  it('无消息 / 消息 JSON 损坏', async () => {
    mockState.employees.set('e1', { memory_enabled: 1 })
    mockState.conversations.set('c1', { id: 'c1', employee_id: 'e1', messages_json: '[]', message_count: 0 })
    await expect(service.extractManually('c1')).resolves.toEqual({ success: false, error: 'NO_MESSAGES' })

    mockState.conversations.set('c2', { id: 'c2', employee_id: 'e1', messages_json: '{broken', message_count: 3 })
    await expect(service.extractManually('c2')).resolves.toEqual({ success: false, error: 'NO_MESSAGES' })
  })

  it('无可用 LLM 时返回 NO_LLM_PROVIDER', async () => {
    mockState.employees.set('e1', { memory_enabled: 1 })
    mockState.conversations.set('c1', { id: 'c1', employee_id: 'e1', messages_json: '[{"role":"user","content":"x"}]', message_count: 1 })
    await expect(service.extractManually('c1')).resolves.toEqual({ success: false, error: 'NO_LLM_PROVIDER' })
  })

  it('成功路径：全量提取（extractedMessageCount=0, manual=true）并推进指针', async () => {
    mockState.employees.set('e1', { memory_enabled: 1 })
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]
    mockState.conversations.set('c1', { id: 'c1', employee_id: 'e1', title: 'T', messages_json: JSON.stringify(messages), message_count: 2 })
    mockState.providers.push({ id: 'p1' })
    mockState.providerConfigs.set('p1', provider())

    await expect(service.extractManually('c1')).resolves.toEqual({ success: true })
    expect(mockState.memoryService.extractMemoriesFromConversation).toHaveBeenCalledWith(
      'e1', messages, 'p1', 'gpt-real', 'c1', 0, true,
    )
    expect(mockState.memoryService.removeStaleMemories).toHaveBeenCalledWith('e1')
    expect(mockState.memoryService.autoConsolidateIfNeeded).toHaveBeenCalledWith('e1', 'p1', 'gpt-real')
    expect(mockState.updates).toEqual([{ sql: 'advance', args: [2, 'c1'] }])
  })

  it('提取过程抛错时返回错误信息，不推进指针', async () => {
    mockState.employees.set('e1', { memory_enabled: 1 })
    mockState.conversations.set('c1', { id: 'c1', employee_id: 'e1', messages_json: '[{"role":"user","content":"a"}]', message_count: 1 })
    mockState.providers.push({ id: 'p1' })
    mockState.providerConfigs.set('p1', provider())
    mockState.memoryService.extractMemoriesFromConversation.mockRejectedValue(new Error('llm timeout'))

    await expect(service.extractManually('c1')).resolves.toEqual({ success: false, error: 'llm timeout' })
    expect(mockState.updates).toEqual([])
  })
})

describe('memory-refinement / runCheck', () => {
  it('无候选对话时不调用记忆服务', async () => {
    await priv.runCheck()
    expect(mockState.memoryService.extractMemoriesFromConversation).not.toHaveBeenCalled()
    expect(mockState.updates).toEqual([])
  })

  it('候选对话：增量提取（带 memory_extracted_message_count）并推进指针', async () => {
    mockState.providers.push({ id: 'p1' })
    mockState.providerConfigs.set('p1', provider())
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
    mockState.candidateRows.push({
      id: 'c1', employee_id: 'e1', title: 'T', messages_json: JSON.stringify(messages),
      message_count: 3, memory_extracted_message_count: 1, employee_name: '员工',
    })

    await priv.runCheck()

    expect(mockState.memoryService.extractMemoriesFromConversation).toHaveBeenCalledWith(
      'e1', messages, 'p1', 'gpt-real', 'c1', 1,
    )
    expect(mockState.updates).toEqual([{ sql: 'advance', args: [3, 'c1'] }])
  })

  it('memory_extracted_message_count 为 null 时按 0 传入', async () => {
    mockState.providers.push({ id: 'p1' })
    mockState.providerConfigs.set('p1', provider())
    mockState.candidateRows.push({
      id: 'c1', employee_id: 'e1', title: '', messages_json: '[{"role":"user","content":"a"}]',
      message_count: 1, memory_extracted_message_count: null, employee_name: '员工',
    })
    await priv.runCheck()
    expect(mockState.memoryService.extractMemoriesFromConversation.mock.calls[0][5]).toBe(0)
  })

  it('消息为空时直接把指针置 0（不调用 LLM）', async () => {
    mockState.candidateRows.push({
      id: 'c1', employee_id: 'e1', title: '', messages_json: '[]',
      message_count: 0, memory_extracted_message_count: 0, employee_name: '员工',
    })
    await priv.runCheck()
    expect(mockState.memoryService.extractMemoriesFromConversation).not.toHaveBeenCalled()
    expect(mockState.updates).toEqual([{ sql: 'advance', args: [0, 'c1'] }])
  })

  it('无可用 LLM 时跳过并推进指针避免反复重试', async () => {
    mockState.candidateRows.push({
      id: 'c1', employee_id: 'e1', title: '', messages_json: '[{"role":"user","content":"a"}]',
      message_count: 1, memory_extracted_message_count: 0, employee_name: '员工',
    })
    await priv.runCheck()
    expect(mockState.memoryService.extractMemoriesFromConversation).not.toHaveBeenCalled()
    expect(mockState.updates).toEqual([{ sql: 'advance', args: [1, 'c1'] }])
  })

  it('单个对话提取抛错时推进指针，并继续处理后续候选', async () => {
    mockState.providers.push({ id: 'p1' })
    mockState.providerConfigs.set('p1', provider())
    mockState.candidateRows.push(
      { id: 'c-bad', employee_id: 'e1', title: 'B', messages_json: '[{"role":"user","content":"a"}]', message_count: 1, memory_extracted_message_count: 0, employee_name: 'E' },
      { id: 'c-good', employee_id: 'e2', title: 'G', messages_json: '[{"role":"user","content":"b"}]', message_count: 1, memory_extracted_message_count: 0, employee_name: 'E' },
    )
    mockState.memoryService.extractMemoriesFromConversation
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)

    await priv.runCheck()

    expect(mockState.memoryService.extractMemoriesFromConversation).toHaveBeenCalledTimes(2)
    expect(mockState.updates).toEqual([
      { sql: 'advance', args: [1, 'c-bad'] },
      { sql: 'advance', args: [1, 'c-good'] },
    ])
  })

  it('runCheck 未被 start 时不会自动执行', async () => {
    expect(service.isRunning()).toBe(false)
    await service.triggerNow()
    expect(mockState.memoryService.extractMemoriesFromConversation).not.toHaveBeenCalled()
  })
})
