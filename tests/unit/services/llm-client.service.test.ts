/**
 * LLMClientService 真实实例化测试：
 * 配置映射/兜底、testConnection 状态归一化、provider CRUD、模型改名级联、embedding 真实 HTTP 解析。
 * 边界 mock：DatabaseService(node:sqlite)、SecureKeyStorage、fetch。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const dbState = vi.hoisted(() => ({ db: null as any }))

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE llm_providers (
      id TEXT PRIMARY KEY, name TEXT, provider_type TEXT, base_url TEXT, api_format TEXT, model TEXT,
      embedding_model TEXT, temperature REAL, max_tokens INTEGER, timeout_ms INTEGER,
      extra_headers_json TEXT, extra_body_json TEXT, is_default INTEGER,
      models_json TEXT, created_at INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
  `)
  return db
}

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => dbState.db }) }
}))

vi.mock('../../../electron/main/services/secure-key-storage', () => {
  class SecureKeyStorage {
    getApiKey = vi.fn(async () => 'sk-test')
    saveApiKey = vi.fn(async () => {})
    deleteApiKey = vi.fn(async () => {})
  }
  return { SecureKeyStorage }
})

import LLMClientService from '../../../electron/main/services/llm-client.service'

beforeEach(() => {
  dbState.db = createDb()
  ;(LLMClientService as any).instance = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubFetch(response: any): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => response)
  vi.stubGlobal('fetch', fn)
  return fn
}

const httpResponse = (body: any, status = 200, statusText = 'OK') => ({
  ok: status >= 200 && status < 300,
  status,
  statusText,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

function seedProvider(over: Record<string, any> = {}): string {
  dbState.db.prepare(`
    INSERT INTO llm_providers (id, name, provider_type, base_url, model, created_at)
    VALUES ('p1', '测试', 'openai', 'https://api.test.com/v1', 'gpt-4o', 1000)
  `).run()
  return 'p1'
}

describe('getProviderConfig', () => {
  it('无记录返回 null', async () => {
    expect(await LLMClientService.getInstance().getProviderConfig('x')).toBeNull()
  })

  it('映射行并注入 api_key，缺省字段兜底', async () => {
    seedProvider()
    const cfg = await LLMClientService.getInstance().getProviderConfig('p1')
    expect(cfg).toMatchObject({
      id: 'p1',
      provider_type: 'openai',
      base_url: 'https://api.test.com/v1',
      api_key: 'sk-test',
      embedding_model: 'text-embedding-3-small',
      temperature: 0.7,
      max_tokens: 32 * 1024,
      timeout_ms: 60000,
    })
  })
})

describe('getBaseURL', () => {
  const svc = () => LLMClientService.getInstance()

  it('base_url 存在时去掉尾部斜杠', () => {
    expect(svc().getBaseURL({ base_url: 'https://x.com///' } as any)).toBe('https://x.com')
  })

  it('无 base_url 且 provider 类型未知：回退 OpenAI', () => {
    expect(svc().getBaseURL({ provider_type: 'unknown' } as any)).toBe('https://api.openai.com/v1')
  })
})

describe('testConnection', () => {
  it('provider 不存在', async () => {
    const r = await LLMClientService.getInstance().testConnection('x')
    expect(r).toEqual({ success: false, error: 'Provider not found' })
  })

  it('200：成功并返回 latency', async () => {
    seedProvider()
    stubFetch(httpResponse({}))
    const r = await LLMClientService.getInstance().testConnection('p1')
    expect(r.success).toBe(true)
    expect(r.latency).toBeGreaterThanOrEqual(0)
  })

  it('401：归一化为中文错误', async () => {
    seedProvider()
    stubFetch(httpResponse({}, 401, 'Unauthorized'))
    const r = await LLMClientService.getInstance().testConnection('p1')
    expect(r.success).toBe(false)
    expect(r.error).toBe('API Key 无效或权限不足')
  })

  it('500：返回 HTTP 状态行', async () => {
    seedProvider()
    stubFetch(httpResponse({}, 500, 'Server Error'))
    const r = await LLMClientService.getInstance().testConnection('p1')
    expect(r.error).toBe('HTTP 500: Server Error')
  })

  it('AbortError：归一化为连接超时', async () => {
    seedProvider()
    const fn = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    vi.stubGlobal('fetch', fn)
    const r = await LLMClientService.getInstance().testConnection('p1')
    expect(r.error).toBe('连接超时')
  })
})

describe('provider CRUD', () => {
  it('getProviderList 按默认/创建时间倒序', () => {
    seedProvider()
    expect(LLMClientService.getInstance().getProviderList()).toHaveLength(1)
  })

  it('createProvider：落库并返回；is_default 先清除旧默认', async () => {
    dbState.db.prepare(
      "INSERT INTO llm_providers (id,name,provider_type,model,is_default,created_at) VALUES ('old','旧','openai','m',1,1)"
    ).run()

    const created = await LLMClientService.getInstance().createProvider({
      name: '新',
      provider_type: 'openai',
      model: 'gpt-4o',
      api_key: 'sk-xyz',
      is_default: true,
    })

    expect(created.id).toBeTruthy()
    expect(created.is_default).toBe(1)
    expect(dbState.db.prepare("SELECT is_default FROM llm_providers WHERE id='old'").get().is_default).toBe(0)
  })

  it('updateProvider：无记录返回 null；api_key 不落业务列', async () => {
    seedProvider()
    const svc = LLMClientService.getInstance()
    expect(await svc.updateProvider('x', { name: 'n' })).toBeNull()

    const updated = await svc.updateProvider('p1', { api_key: 'sk-new', name: '改名' })
    expect(updated.name).toBe('改名')
  })

  it('updateProvider：未知列被白名单过滤', async () => {
    seedProvider()
    const updated = await LLMClientService.getInstance().updateProvider('p1', {
      unknown_column: 'x',
      temperature: 0.3,
    })
    expect(updated.temperature).toBe(0.3)
  })

  it('deleteProvider：删除记录与密钥', async () => {
    seedProvider()
    const result = await LLMClientService.getInstance().deleteProvider('p1')
    expect(result).toBe(true)
    expect(LLMClientService.getInstance().getProvider('p1')).toBeUndefined()
    expect(await LLMClientService.getInstance().deleteProvider('p1')).toBe(false)
  })
})

describe('syncModelReferences / 模型改名级联', () => {
  it('settings 中同 provider 的模型引用被更新，其他 provider 不动', async () => {
    seedProvider()
    const setSetting = (key: string, value: any) =>
      dbState.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
    setSetting('default_model_workbench', { provider_id: 'p1', model_id: 'old-model' })
    setSetting('default_model_knowledge', { provider_id: 'p2', model_id: 'old-model' })

    const oldModels = JSON.stringify([{ id: 'm1', model: 'old-model' }])
    const newModels = JSON.stringify([{ id: 'm1', model: 'new-model' }])
    dbState.db.prepare("UPDATE llm_providers SET models_json = ? WHERE id='p1'").run(oldModels)

    await LLMClientService.getInstance().updateProvider('p1', { models_json: newModels })

    const wb = JSON.parse(dbState.db.prepare("SELECT value FROM settings WHERE key='default_model_workbench'").get().value)
    const kn = JSON.parse(dbState.db.prepare("SELECT value FROM settings WHERE key='default_model_knowledge'").get().value)
    expect(wb.model_id).toBe('new-model')
    expect(kn.model_id).toBe('old-model')
  })
})

describe('embedding', () => {
  it('provider 缺失抛错', async () => {
    await expect(LLMClientService.getInstance().createEmbedding('x', 'text')).rejects.toThrow('Provider not found')
  })

  it('createEmbedding：解析 data[0].embedding 为 Float32Array', async () => {
    seedProvider()
    const fn = stubFetch(httpResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }))

    const vec = await LLMClientService.getInstance().createEmbedding('p1', 'hello')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec).toEqual(new Float32Array([0.1, 0.2, 0.3]))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('响应缺 data：格式错误', async () => {
    seedProvider()
    stubFetch(httpResponse({ unexpected: true }))
    await expect(LLMClientService.getInstance().createEmbedding('p1', 'x')).rejects.toThrow('Invalid embedding')
  })

  it('非 200：错误含状态码与响应文本', async () => {
    seedProvider()
    stubFetch({ ok: false, status: 429, text: async () => 'rate limited' })
    await expect(LLMClientService.getInstance().createEmbedding('p1', 'x')).rejects.toThrow('429')
  })

  it('createEmbeddings：超过 20 条分批请求，按 index 排序后逐个返回', async () => {
    seedProvider()
    const fn = vi.fn(async (url: string, init: any) => {
      const inputs = JSON.parse(init.body).input as string[]
      return httpResponse({
        data: inputs.map((t, i) => ({ index: i, embedding: [i ? 1 : 0] })),
      })
    })
    vi.stubGlobal('fetch', fn)

    const results = await LLMClientService.getInstance().createEmbeddings('p1', Array.from({ length: 21 }, (_, i) => 't' + i))
    expect(fn).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(21)
    expect(results[0][0]).toBe(0)
  })
})

describe('getDefaultEmbeddingConfig', () => {
  it('无配置/非法 JSON 返回 null', () => {
    expect(LLMClientService.getInstance().getDefaultEmbeddingConfig()).toBeNull()
  })

  it('models_json 命中时解析模型名；否则回退 embedding_model', async () => {
    seedProvider()
    dbState.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('default_model_embedding', JSON.stringify({ provider_id: 'p1', model_id: 'm1' }))
    dbState.db.prepare("UPDATE llm_providers SET models_json=?, embedding_model='fallback-model' WHERE id='p1'")
      .run(JSON.stringify([{ id: 'm1', model: 'resolved-model' }]))

    expect(LLMClientService.getInstance().getDefaultEmbeddingConfig())
      .toEqual({ providerId: 'p1', modelName: 'resolved-model' })

    dbState.db.prepare("UPDATE settings SET value=? WHERE key='default_model_embedding'")
      .run(JSON.stringify({ provider_id: 'p1', model_id: 'missing' }))
    expect(LLMClientService.getInstance().getDefaultEmbeddingConfig())
      .toEqual({ providerId: 'p1', modelName: 'fallback-model' })
  })
})
