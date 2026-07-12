import DatabaseService from './database.service'
import EmployeeMemoryService from './employee-memory.service'
import { ScheduledTaskBase } from './scheduled-task-base'
import { createLogger } from './logger'

const logger = createLogger('MemoryRefinement')

/** 检查间隔：5分钟 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000
/** 对话空闲阈值：30分钟无新消息 */
const IDLE_THRESHOLD_SECONDS = 1800
/** 仅处理最近3天内的对话 */
const RECENT_WINDOW_SECONDS = 3 * 24 * 3600
/** 每次检查最多处理的对话数 */
const MAX_BATCH_SIZE = 3

class MemoryRefinementService extends ScheduledTaskBase {
  private db: DatabaseService
  private memoryService: EmployeeMemoryService
  private static instance: MemoryRefinementService

  private constructor() {
    super('MemoryRefinement', CHECK_INTERVAL_MS)
    this.db = DatabaseService.getInstance()
    this.memoryService = EmployeeMemoryService.getInstance()
  }

  static getInstance(): MemoryRefinementService {
    if (!MemoryRefinementService.instance) {
      MemoryRefinementService.instance = new MemoryRefinementService()
    }
    return MemoryRefinementService.instance
  }

  protected async runCheck(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = Math.floor(Date.now() / 1000)
      const idleCutoff = now - IDLE_THRESHOLD_SECONDS
      const recentCutoff = now - RECENT_WINDOW_SECONDS

      const candidates = this.db.getDb().prepare(`
        SELECT c.id, c.employee_id, c.title, c.messages_json, c.message_count,
               e.name as employee_name
        FROM conversations c
        JOIN employees e ON c.employee_id = e.id
        WHERE e.memory_enabled = 1
          AND c.last_message_at IS NOT NULL
          AND c.last_message_at < ?
          AND c.last_message_at > ?
          AND c.memory_extracted_at IS NULL
          AND c.message_count > 0
        ORDER BY c.last_message_at DESC
        LIMIT ?
      `).all(idleCutoff, recentCutoff, MAX_BATCH_SIZE) as any[]

      if (candidates.length === 0) return

      logger.info(`Found ${candidates.length} conversation(s) pending memory extraction`)

      for (const conv of candidates) {
        try {
          await this.extractMemoriesForConversation(conv)
        } catch (err: any) {
          logger.error(`Memory extraction failed for conversation ${conv.id}:`, err?.message || err)
          // 标记为已处理，避免反复失败
          this.markExtracted(conv.id)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async extractMemoriesForConversation(conv: any): Promise<void> {
    const messages = (() => {
      try { return JSON.parse(conv.messages_json || '[]') } catch { return [] }
    })()

    if (messages.length === 0) {
      this.markExtracted(conv.id)
      return
    }

    // 获取员工配置的 LLM provider 和 model
    const { providerId, modelId } = await this.resolveEmployeeLLM()
    if (!providerId) {
      logger.warn(`No LLM provider for employee ${conv.employee_id}, skipping memory extraction`)
      this.markExtracted(conv.id)
      return
    }

    logger.info(`Extracting memories for conversation "${conv.title || conv.id}" (employee: ${conv.employee_name})`)

    await this.memoryService.extractMemoriesFromConversation(
      conv.employee_id,
      messages,
      providerId,
      modelId,
      conv.id,
    )

    // 清理过期记忆 + 自动合并
    this.memoryService.removeStaleMemories(conv.employee_id)
    await this.memoryService.autoConsolidateIfNeeded(conv.employee_id, providerId, modelId)

    this.markExtracted(conv.id)
    logger.info(`Memory extraction completed for conversation ${conv.id}`)
  }

  /** 手动触发指定对话的记忆提取（右键菜单调用） */
  async extractManually(conversationId: string): Promise<{ success: boolean; error?: string }> {
    const conv = this.db.getDb().prepare(
      'SELECT id, employee_id, title, messages_json, message_count FROM conversations WHERE id = ?'
    ).get(conversationId) as any
    if (!conv) return { success: false, error: 'CONVERSATION_NOT_FOUND' }

    const emp = this.db.getDb().prepare('SELECT memory_enabled FROM employees WHERE id = ?').get(conv.employee_id) as any
    if (!emp?.memory_enabled) return { success: false, error: 'MEMORY_NOT_ENABLED' }

    const messages = (() => {
      try { return JSON.parse(conv.messages_json || '[]') } catch { return [] }
    })()
    if (messages.length === 0) return { success: false, error: 'NO_MESSAGES' }

    const { providerId, modelId } = await this.resolveEmployeeLLM()
    if (!providerId) return { success: false, error: 'NO_LLM_PROVIDER' }

    try {
      await this.memoryService.extractMemoriesFromConversation(
        conv.employee_id, messages, providerId, modelId, conv.id,
      )
      this.memoryService.removeStaleMemories(conv.employee_id)
      await this.memoryService.autoConsolidateIfNeeded(conv.employee_id, providerId, modelId)
      this.markExtracted(conv.id)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' }
    }
  }

  private async resolveEmployeeLLM(): Promise<{ providerId: string; modelId?: string }> {
    // 员工未存储默认 provider，使用默认 provider（回退到任意 provider）
    const provider = this.db.getDb().prepare(
      'SELECT id, model, models_json FROM llm_providers ORDER BY is_default DESC LIMIT 1'
    ).get() as { id: string; model: string; models_json: string } | undefined

    if (!provider?.id) return { providerId: '', modelId: undefined }

    // 从 models_json 解析默认模型，回退到 provider.model
    let modelId: string | undefined
    try {
      const models = JSON.parse(provider.models_json || '[]') as Array<{ id?: string; model?: string; is_default?: boolean }>
      const defaultModel = models.find(m => m.is_default)
      modelId = defaultModel?.id || defaultModel?.model || provider.model
    } catch {
      modelId = provider.model
    }

    return { providerId: provider.id, modelId }
  }

  private markExtracted(conversationId: string): void {
    this.db.getDb().prepare(
      'UPDATE conversations SET memory_extracted_at = unixepoch() WHERE id = ?'
    ).run(conversationId)
  }
}

export default MemoryRefinementService
