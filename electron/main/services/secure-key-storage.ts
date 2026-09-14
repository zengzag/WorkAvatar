import { isMainThread, workerData } from 'worker_threads'
import { getSafeStorage } from './llm-client-types'
import { createLogger } from './logger'

const logger = createLogger('SecureKeyStorage')

/**
 * 安全密钥存储
 *
 * 使用 electron.safeStorage 加密 API Key 后存入 settings 表（禁止明文落库：
 * safeStorage 不可用时拒绝写入，而非降级为明文）。
 * Worker 模式下 safeStorage 不可用，getApiKey 改从 workerData 读取主线程预解密的密钥。
 */
export class SecureKeyStorage {
  private db: any

  constructor(db: any) {
    this.db = db
  }

  /** 加密 API Key；safeStorage 不可用时抛错拒绝写入 */
  private encryptKey(plainText: string): string {
    const safeStorage = getSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法加密保存 API Key（禁止明文落库）')
    }
    const buffer = safeStorage.encryptString(plainText)
    return buffer.toString('base64')
  }

  private decryptKey(encryptedText: string): string | null {
    if (!encryptedText) return null
    const safeStorage = getSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) {
      logger.error('safeStorage 不可用，无法解密 API Key，请重新保存')
      return null
    }
    try {
      return safeStorage.decryptString(Buffer.from(encryptedText, 'base64'))
    } catch (err: any) {
      logger.error('解密 API Key 失败（可能为系统凭据变化导致密文失效）:', err?.message || err)
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
