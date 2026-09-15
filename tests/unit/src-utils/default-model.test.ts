import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * src/utils/default-model：场景默认模型读写
 * - settings IPC 读写（key 映射）
 * - localStorage 缓存（key 映射、非法 JSON 兜底）
 * - 异常路径（IPC 抛错/拒绝、localStorage 抛错）
 */

const settingsGet = vi.fn(async (_p: { key: string }): Promise<any> => undefined)
const settingsSet = vi.fn(async (_p: { key: string; value: string }): Promise<void> => {})

const lsData = new Map<string, string>()
let lsGetItemThrows = false
let lsSetItemThrows = false

const ls = {
  getItem: (k: string) => {
    if (lsGetItemThrows) throw new Error('SecurityError')
    return lsData.has(k) ? lsData.get(k)! : null
  },
  setItem: (k: string, v: string) => {
    if (lsSetItemThrows) throw new Error('QuotaExceededError')
    lsData.set(k, v)
  },
  removeItem: (k: string) => { lsData.delete(k) },
  clear: () => { lsData.clear() },
}

vi.stubGlobal('window', { electronAPI: { settings: { get: settingsGet, set: settingsSet } } })
vi.stubGlobal('localStorage', ls)

const { getSceneDefaultModel, setSceneDefaultModel, getAllSceneDefaultModels, getCachedSceneDefaultModel } =
  await import('../../../src/utils/default-model')

const CONF = { provider_id: 'openai', model_id: 'gpt-4o' }

beforeEach(() => {
  settingsGet.mockReset().mockResolvedValue(undefined)
  settingsSet.mockReset().mockResolvedValue(undefined)
  lsData.clear()
  lsGetItemThrows = false
  lsSetItemThrows = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('default-model / getSceneDefaultModel', () => {
  it('按场景读取 settings key 并解析 JSON', async () => {
    settingsGet.mockResolvedValue(JSON.stringify(CONF))
    expect(await getSceneDefaultModel('creation')).toEqual(CONF)
    expect(settingsGet).toHaveBeenCalledWith({ key: 'default_model_creation' })

    await getSceneDefaultModel('memory')
    expect(settingsGet).toHaveBeenLastCalledWith({ key: 'default_model_memory' })
  })

  it('各场景 settings key 映射正确', async () => {
    settingsGet.mockResolvedValue(undefined)
    for (const scene of ['creation', 'workbench', 'knowledge', 'quick', 'embedding', 'memory'] as const) {
      await getSceneDefaultModel(scene)
    }
    expect(settingsGet.mock.calls.map(c => c[0].key)).toEqual([
      'default_model_creation',
      'default_model_workbench',
      'default_model_knowledge',
      'default_model_quick',
      'default_model_embedding',
      'default_model_memory',
    ])
  })

  it('空值（undefined/null/空串）返回 null 且不做 JSON.parse', async () => {
    settingsGet.mockResolvedValue(undefined)
    expect(await getSceneDefaultModel('quick')).toBeNull()
    settingsGet.mockResolvedValue(null)
    expect(await getSceneDefaultModel('quick')).toBeNull()
    settingsGet.mockResolvedValue('')
    expect(await getSceneDefaultModel('quick')).toBeNull()
  })

  it('非法 JSON / 非字符串值返回 null（兜底不抛错）', async () => {
    settingsGet.mockResolvedValue('{not-json')
    expect(await getSceneDefaultModel('quick')).toBeNull()
    settingsGet.mockResolvedValue({ provider_id: 'x' })
    expect(await getSceneDefaultModel('quick')).toBeNull()
  })

  it('IPC 拒绝或同步抛错均返回 null', async () => {
    settingsGet.mockRejectedValue(new Error('ipc down'))
    expect(await getSceneDefaultModel('quick')).toBeNull()
    settingsGet.mockImplementation(() => { throw new Error('sync boom') })
    expect(await getSceneDefaultModel('quick')).toBeNull()
  })

  it('非法 JSON 字符串 "null" 解析为 null', async () => {
    settingsGet.mockResolvedValue('null')
    expect(await getSceneDefaultModel('quick')).toBeNull()
  })
})

describe('default-model / setSceneDefaultModel', () => {
  it('同时写入 settings 与 localStorage（各自 key 映射）', async () => {
    await setSceneDefaultModel('knowledge', CONF)
    expect(settingsSet).toHaveBeenCalledWith({ key: 'default_model_knowledge', value: JSON.stringify(CONF) })
    expect(JSON.parse(lsData.get('defaultModel:knowledge')!)).toEqual(CONF)
  })

  it('各场景 localStorage key 映射正确', async () => {
    await setSceneDefaultModel('embedding', CONF)
    expect(lsData.has('defaultModel:embedding')).toBe(true)
    expect(lsData.has('defaultModel:creation')).toBe(false)
  })

  it('settings 写入失败时异常向上抛出', async () => {
    settingsSet.mockRejectedValue(new Error('ipc down'))
    await expect(setSceneDefaultModel('quick', CONF)).rejects.toThrow('ipc down')
  })

  it('settings 写入失败时不再写 localStorage（缓存与持久化保持一致）', async () => {
    settingsSet.mockRejectedValue(new Error('ipc down'))
    await setSceneDefaultModel('quick', CONF).catch(() => {})
    expect(lsData.has('defaultModel:quick')).toBe(false)
  })

  it('localStorage 写入失败不影响 settings 已落盘的部分', async () => {
    lsSetItemThrows = true
    await expect(setSceneDefaultModel('quick', CONF)).rejects.toThrow('QuotaExceededError')
    expect(settingsSet).toHaveBeenCalledTimes(1)
  })
})

describe('default-model / getCachedSceneDefaultModel', () => {
  it('读取缓存并解析', () => {
    lsData.set('defaultModel:workbench', JSON.stringify(CONF))
    expect(getCachedSceneDefaultModel('workbench')).toEqual(CONF)
  })

  it('无缓存 / 空串返回 null', () => {
    expect(getCachedSceneDefaultModel('workbench')).toBeNull()
    lsData.set('defaultModel:workbench', '')
    expect(getCachedSceneDefaultModel('workbench')).toBeNull()
  })

  it('非法 JSON 返回 null', () => {
    lsData.set('defaultModel:workbench', 'not-json')
    expect(getCachedSceneDefaultModel('workbench')).toBeNull()
  })

  it('localStorage 抛错时返回 null', () => {
    lsGetItemThrows = true
    expect(getCachedSceneDefaultModel('workbench')).toBeNull()
  })

  it('localStorage 与 settings key 互不串用', async () => {
    await setSceneDefaultModel('quick', CONF)
    expect(getCachedSceneDefaultModel('quick')).toEqual(CONF)
    expect(getCachedSceneDefaultModel('creation')).toBeNull()
  })
})

describe('default-model / getAllSceneDefaultModels', () => {
  it('并发读取全部场景并返回完整记录', async () => {
    settingsGet.mockImplementation(async ({ key }) =>
      key === 'default_model_creation' ? JSON.stringify(CONF) : undefined)
    const all = await getAllSceneDefaultModels()
    expect(Object.keys(all).sort()).toEqual(['creation', 'embedding', 'knowledge', 'memory', 'quick', 'workbench'])
    expect(all.creation).toEqual(CONF)
    expect(all.workbench).toBeNull()
    expect(settingsGet).toHaveBeenCalledTimes(6)
  })

  it('全部读取失败时返回全 null 记录', async () => {
    settingsGet.mockRejectedValue(new Error('down'))
    const all = await getAllSceneDefaultModels()
    expect(Object.values(all).every(v => v === null)).toBe(true)
  })
})
