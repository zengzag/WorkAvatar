import { isMainThread, workerData } from 'worker_threads'
import { getSafeStorage } from './llm-client-types'
import { createLogger } from './logger'

const logger = createLogger('SecureKeyStorage')

/** 明文降级标记前缀：safeStorage 不可用时的存储形态，与密文可区分 */
const PLAIN_PREFIX = 'plain:'

/**
 * 安全密钥存储
 *
 * 使用 electron.safeStorage 加密 API Key 后存入 settings 表。
 * Worker 模式下 safeStorage 不可用，getApiKey 改从 workerData 读取主线程预解密的密钥。
 */
export class SecureKeyStorage {
  private db: any
  private plainFallbackWarned = false

  constructor(db: any) {
    this.db = db
  }

  private encryptKey(plainText: string): string {
    const safeStorage = getSafeStorage()
    if (safeStorage?.isEncryptionAvailable()) {
      const buffer = safeStorage.encryptString(plainText)
      return buffer.toString('base64')
    }
    // 明文降级需可识别（plain: 前缀）并显式告警，避免静默降级无人知晓
    if (!this.plainFallbackWarned) {
      this.plainFallbackWarned = true
      console.warn('[SecureKeyStorage] safeStorage 不可用，API Key 将以明文（plain: 前缀）写入 settings 表')
    }
    return PLAIN_PREFIX + plainText
  }

  private decryptKey(encryptedText: string): string | null {
    if (!encryptedText) return null
    // 明文降级存储：去前缀原样返回
    if (encryptedText.startsWith(PLAIN_PREFIX)) {
      return encryptedText.slice(PLAIN_PREFIX.length)
    }
    try {
      const safeStorage = getSafeStorage()
      if (safeStorage?.isEncryptionAvailable()) {
        try {
          const buffer = Buffer.from(encryptedText, 'base64')
          return safeStorage.decryptString(buffer)
        } catch {
          // 密文解密失败但 safeStorage 可用：可能为修复前遗留的存量裸明文
          //（API key 形态与 base64 密文可区分），回读兼容避免密钥"静默丢失"
          if (this.looksLikeLegacyPlainText(encryptedText)) {
            logger.warn('存量明文 API Key 检测到（plain: 前缀引入前写入），建议重新保存以启用加密')
            return encryptedText
          }
          throw new Error('密文损坏或 DPAPI 凭据变化')
        }
      }
      // 加密不可用：区分存量明文与真密文；后者确实无法解密（DPAPI 凭据绑定）
      if (this.looksLikeLegacyPlainText(encryptedText)) {
        logger.warn('存量明文 API Key 检测到（safeStorage 当前不可用），原样回读')
        return encryptedText
      }
      console.error('[SecureKeyStorage] safeStorage 不可用且存储值为密文，无法解密 API Key（可能为 DPAPI 凭据变化）')
      return null
    } catch (err: any) {
      console.error('[SecureKeyStorage] 解密 API Key 失败:', err?.message || err)
      return null
    }
  }

  /** 判定存储值是否为 plain: 前缀引入前的存量裸明文（非标准 base64 密文形态） */
  private looksLikeLegacyPlainText(value: string): boolean {
    if (value.length < 24) return true
    // base64 密文字符集；常见 API key（sk-…、含 -/_ 等）不匹配
    return !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
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
