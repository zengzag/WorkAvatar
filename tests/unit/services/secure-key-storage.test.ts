/**
 * 安全密钥存储单测：
 * - 明文禁止：safeStorage 不可用时拒绝写入（而不是降级明文落库）
 * - 加解密往返、密文为 base64 且不含明文
 * - 解密失败（密文失效 / safeStorage 不可用 / 非法 base64）一律回落 null 而非抛错
 * - settings key 命名约定、删除行为
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockState = vi.hoisted(() => {
  const rows = new Map<string, string>()
  const calls: Array<{ sql: string; args: any[] }> = []
  const safeStorage = {
    available: true,
    isEncryptionAvailable: () => safeStorage.available,
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
    decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^enc:/, '')),
  }
  return { rows, calls, safeStorage }
})

vi.mock('../../../electron/main/services/llm-client-types', () => ({
  getSafeStorage: () => (mockState.safeStorage.available ? mockState.safeStorage : null),
}))

import { SecureKeyStorage } from '../../../electron/main/services/secure-key-storage'

const fakeDb = {
  prepare(sql: string) {
    return {
      get: (key: string) => {
        mockState.calls.push({ sql, args: [key] })
        return mockState.rows.has(key) ? { value: mockState.rows.get(key)! } : undefined
      },
      run: (...args: any[]) => {
        mockState.calls.push({ sql, args })
        if (sql.startsWith('INSERT')) mockState.rows.set(args[0], args[1])
        if (sql.startsWith('DELETE')) mockState.rows.delete(args[0])
        return { changes: 1 }
      },
    }
  },
}

beforeEach(() => {
  mockState.rows.clear()
  mockState.calls.length = 0
  mockState.safeStorage.available = true
  mockState.safeStorage.encryptString.mockClear()
  mockState.safeStorage.decryptString.mockClear()
})

describe('secure-key-storage / 写入', () => {
  it('加密后以 base64 落库，密文中不含明文', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await storage.saveApiKey('openai', 'sk-secret-value')

    expect(mockState.rows.get('llm_api_key_openai')).toBe(
      Buffer.from('enc:sk-secret-value', 'utf-8').toString('base64')
    )
    expect(mockState.rows.get('llm_api_key_openai')).not.toContain('sk-secret-value')
  })

  it('使用 UPSERT 语句（重复保存不报主键冲突）', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await storage.saveApiKey('openai', 'a')
    await storage.saveApiKey('openai', 'b')
    const insert = mockState.calls.filter(c => c.sql.startsWith('INSERT'))
    expect(insert).toHaveLength(2)
    expect(insert[0].sql).toContain('ON CONFLICT(key) DO UPDATE')
    expect(mockState.rows.get('llm_api_key_openai')).toBe(Buffer.from('enc:b').toString('base64'))
  })

  it('safeStorage 不可用时拒绝写入（禁止明文落库）', async () => {
    mockState.safeStorage.available = false
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.saveApiKey('openai', 'sk-plain')).rejects.toThrow(/禁止明文落库/)
    expect(mockState.rows.size).toBe(0)
    expect(mockState.calls).toHaveLength(0)
  })

  it('加密抛错时不落库', async () => {
    mockState.safeStorage.encryptString.mockImplementationOnce(() => {
      throw new Error('keychain locked')
    })
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.saveApiKey('openai', 'sk')).rejects.toThrow('keychain locked')
    expect(mockState.rows.size).toBe(0)
  })

  it('key 命名含 providerId，不同 provider 互不覆盖', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await storage.saveApiKey('openai', 'a')
    await storage.saveApiKey('deepseek', 'b')
    expect([...mockState.rows.keys()].sort()).toEqual(['llm_api_key_deepseek', 'llm_api_key_openai'])
  })
})

describe('secure-key-storage / 读取', () => {
  it('无记录返回 null', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.getApiKey('openai')).resolves.toBeNull()
  })

  it('密文为空字符串视为未配置', async () => {
    mockState.rows.set('llm_api_key_openai', '')
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.getApiKey('openai')).resolves.toBeNull()
  })

  it('正常解密还原明文', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await storage.saveApiKey('openai', 'sk-abc-123')
    await expect(storage.getApiKey('openai')).resolves.toBe('sk-abc-123')
  })

  it('解密抛错时回落 null 不抛异常（系统凭据变化导致密文失效）', async () => {
    mockState.rows.set('llm_api_key_openai', Buffer.from('corrupted').toString('base64'))
    mockState.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed')
    })
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.getApiKey('openai')).resolves.toBeNull()
  })

  it('safeStorage 不可用时返回 null', async () => {
    mockState.rows.set('llm_api_key_openai', 'x')
    mockState.safeStorage.available = false
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.getApiKey('openai')).resolves.toBeNull()
  })

  it('非法 base64 内容不抛异常（解码失败或解码后交给 safeStorage 判定）', async () => {
    mockState.rows.set('llm_api_key_openai', '!!!not-base64!!!')
    mockState.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('bad ciphertext')
    })
    const storage = new SecureKeyStorage(fakeDb)
    await expect(storage.getApiKey('openai')).resolves.toBeNull()
    expect(mockState.safeStorage.decryptString).toHaveBeenCalled()
  })

  it('Unicode 密钥往返一致', async () => {
    const storage = new SecureKeyStorage(fakeDb)
    await storage.saveApiKey('custom', '密钥-🔑-ключ')
    await expect(storage.getApiKey('custom')).resolves.toBe('密钥-🔑-ключ')
  })
})

describe('secure-key-storage / 删除', () => {
  it('按约定 key 删除', async () => {
    mockState.rows.set('llm_api_key_openai', 'x')
    const storage = new SecureKeyStorage(fakeDb)
    await storage.deleteApiKey('openai')
    expect(mockState.rows.has('llm_api_key_openai')).toBe(false)
    expect(mockState.calls.at(-1)!.sql).toContain('DELETE FROM settings')
    expect(mockState.calls.at(-1)!.args).toEqual(['llm_api_key_openai'])
  })
})
