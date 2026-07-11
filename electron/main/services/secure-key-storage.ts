import { isMainThread, workerData } from 'worker_threads'
import { getSafeStorage } from './llm-client-types'

/**
 * 安全密钥存储
 *
 * 使用 electron.safeStorage 加密 API Key 后存入 settings 表。
 * Worker 模式下 safeStorage 不可用，getApiKey 改从 workerData 读取主线程预解密的密钥。
 */
export class SecureKeyStorage {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  private encryptKey(plainText: string): string {
    const safeStorage = getSafeStorage()
    if (safeStorage?.isEncryptionAvailable()) {
      const buffer = safeStorage.encryptString(plainText)
      return buffer.toString('base64')
    }
    return plainText
  }

  private decryptKey(encryptedText: string): string | null {
    if (!encryptedText) return null
    try {
      const safeStorage = getSafeStorage()
      if (safeStorage?.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedText, 'base64')
        return safeStorage.decryptString(buffer)
      }
      return encryptedText
    } catch {
      return null
    }
  }

  async saveApiKey(providerId: string, apiKey: string): Promise<void> {
    const encrypted = this.encryptKey(apiKey)
    this.db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(`llm_api_key_${providerId}`, encrypted)
  }

  async getApiKey(providerId: string): Promise<string | null> {
    // Worker 模式：从 workerData 读取主线程预解密的 API Key
    // 避免依赖 safeStorage（worker_threads 中不可用）
    if (!isMainThread && workerData?.apiKeys) {
      return (workerData.apiKeys as Record<string, string>)[providerId] ?? null
    }

    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`llm_api_key_${providerId}`) as any
    if (!row?.value) return null
    return this.decryptKey(row.value)
  }

  async deleteApiKey(providerId: string): Promise<void> {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(`llm_api_key_${providerId}`)
  }
}
