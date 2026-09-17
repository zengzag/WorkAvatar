import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  supportsReasoningEffort,
  supportsThinking,
  getProviderModels,
  computeModelRenames,
  syncModelRenamesInStorage,
} from '../../../src/utils/llm'
import type { LLMModelConfig } from '../../../src/types'

describe('src/utils/llm / provider 能力集', () => {
  it('supportsReasoningEffort', () => {
    expect(supportsReasoningEffort('openai')).toBe(true)
    expect(supportsReasoningEffort('deepseek')).toBe(true)
    expect(supportsReasoningEffort('qwen')).toBe(false)
    expect(supportsReasoningEffort(undefined)).toBe(false)
    expect(supportsReasoningEffort('')).toBe(false)
  })

  it('supportsThinking', () => {
    expect(supportsThinking('deepseek')).toBe(true)
    expect(supportsThinking('openai')).toBe(false)
    expect(supportsThinking(undefined)).toBe(false)
  })
})

describe('src/utils/llm / getProviderModels', () => {
  it('解析 models_json 并补默认 category=chat', () => {
    const models = getProviderModels({
      models_json: JSON.stringify([{ id: 'm1', model: 'gpt' }, { id: 'm2', model: 'x', category: 'embedding' }]),
    })
    expect(models).toHaveLength(2)
    expect(models[0].category).toBe('chat')
    expect(models[1].category).toBe('embedding')
  })

  it('空/缺失 models_json 返回 []', () => {
    expect(getProviderModels({})).toEqual([])
    expect(getProviderModels({ models_json: '' })).toEqual([])
    expect(getProviderModels(undefined as any)).toEqual([])
  })

  it('非法 JSON 返回 []', () => {
    expect(getProviderModels({ models_json: '{invalid' })).toEqual([])
  })

  it('JSON 非数组时返回 []（map 抛错被捕获）', () => {
    expect(getProviderModels({ models_json: '{"a":1}' })).toEqual([])
  })
})

describe('src/utils/llm / computeModelRenames', () => {
  const m = (id: string, model: string) => ({ id, model }) as LLMModelConfig

  it('同 id 不同 model 产生重命名映射', () => {
    const renames = computeModelRenames([m('a', 'old-a'), m('b', 'same')], [m('a', 'new-a'), m('b', 'same')])
    expect(renames.get('old-a')).toBe('new-a')
    expect(renames.size).toBe(1)
  })

  it('新增/删除的模型不产生映射', () => {
    const renames = computeModelRenames([m('a', 'old')], [m('b', 'new')])
    expect(renames.size).toBe(0)
  })

  it('两个旧模型同名映射到新名时后者覆盖前者', () => {
    const renames = computeModelRenames(
      [m('a', 'same-alias'), m('b', 'same-alias')],
      [m('a', 'new-a'), m('b', 'new-b')]
    )
    // Map 同 key 覆盖：遍历顺序决定最终值
    expect(renames.size).toBe(1)
  })

  it('空数组安全', () => {
    expect(computeModelRenames([], []).size).toBe(0)
  })
})

describe('src/utils/llm / syncModelRenamesInStorage', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    const ls = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    }
    vi.stubGlobal('localStorage', ls)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('更新场景默认模型缓存中的 model_id', () => {
    store.set('defaultModel:workbench', JSON.stringify({ provider_id: 'p1', model_id: 'old' }))
    const renames = new Map([['old', 'new']])
    syncModelRenamesInStorage('p1', renames)
    expect(JSON.parse(store.get('defaultModel:workbench')!)).toEqual({ provider_id: 'p1', model_id: 'new' })
  })

  it('不匹配 provider 的缓存不受影响', () => {
    store.set('defaultModel:workbench', JSON.stringify({ provider_id: 'p2', model_id: 'old' }))
    syncModelRenamesInStorage('p1', new Map([['old', 'new']]))
    expect(JSON.parse(store.get('defaultModel:workbench')!).model_id).toBe('old')
  })

  it('更新 selectedModelId 键（员工工作台/创建向导）', () => {
    store.set('employeeWorkbench:selectedModelId:emp1', 'old')
    store.set('employeeWorkbench:selectedProviderId:emp1', 'p1')
    store.set('creationWizard:selectedModelId:emp2', 'old')
    store.set('creationWizard:selectedProviderId:emp2', 'p1')
    syncModelRenamesInStorage('p1', new Map([['old', 'new']]))
    expect(store.get('employeeWorkbench:selectedModelId:emp1')).toBe('new')
    expect(store.get('creationWizard:selectedModelId:emp2')).toBe('new')
  })

  it('provider 不匹配的 selectedModelId 不更新', () => {
    store.set('employeeWorkbench:selectedModelId:emp1', 'old')
    store.set('employeeWorkbench:selectedProviderId:emp1', 'p2')
    syncModelRenamesInStorage('p1', new Map([['old', 'new']]))
    expect(store.get('employeeWorkbench:selectedModelId:emp1')).toBe('old')
  })

  it('空 providerId 或空 renames 直接返回', () => {
    store.set('defaultModel:workbench', JSON.stringify({ provider_id: 'p1', model_id: 'old' }))
    syncModelRenamesInStorage('', new Map([['old', 'new']]))
    syncModelRenamesInStorage('p1', new Map())
    expect(JSON.parse(store.get('defaultModel:workbench')!).model_id).toBe('old')
  })

  it('非法 JSON 缓存被跳过不抛错', () => {
    store.set('defaultModel:workbench', '{bad json')
    expect(() => syncModelRenamesInStorage('p1', new Map([['old', 'new']]))).not.toThrow()
  })
})
