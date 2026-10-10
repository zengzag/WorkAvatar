import DatabaseService from './database.service'
import EmployeeMemoryService from './employee-memory.service'
import EmployeeMemoryEmbeddingService from './employee-memory-embedding.service'
import EmployeeRegistryService from './employee-registry.service'
import LLMClientService from './llm-client.service'
import { ScheduledTaskBase } from './scheduled-task-base'
import { createLogger } from './logger'
import { EXTRACTION_MAX_ATTEMPTS } from './employee-memory-types'

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
    // 向量回填与员工开关无关（未配置 embedding 时内部直接跳过），先补齐再走提取
    await this.backfillMemoryVectors()

    const enabledEmployeeIds = this.getMemoryEnabledEmployeeIds()
    if (enabledEmployeeIds.length === 0) return

    const now = Math.floor(Date.now() / 1000)
    const idleCutoff = now - IDLE_THRESHOLD_SECONDS
    const recentCutoff = now - RECENT_WINDOW_SECONDS
    const placeholders = enabledEmployeeIds.map(() => '?').join(',')

    const candidates = this.db.getDb().prepare(`
      SELECT c.id, c.employee_id, c.title, c.messages_json, c.message_count,
             c.memory_extracted_message_count, c.memory_extract_attempts,
             e.name as employee_name
      FROM conversations c
      JOIN employees e ON c.employee_id = e.id
      WHERE c.employee_id IN (${placeholders})
        AND c.last_message_at IS NOT NULL
        AND c.last_message_at < ?
        AND c.last_message_at > ?
        AND c.message_count > COALESCE(c.memory_extracted_message_count, 0)
      ORDER BY c.last_message_at DESC
      LIMIT ?
    `).all(...enabledEmployeeIds, idleCutoff, recentCutoff, MAX_BATCH_SIZE) as any[]

    if (candidates.length === 0) return

    logger.info(`Found ${candidates.length} conversation(s) pending memory extraction`)

    for (const conv of candidates) {
      await this.extractMemoriesForConversation(conv)
    }
  }

  /** 回填缺失 / 失效的记忆向量（新增记忆、内容变更、embedding 模型切换后自愈） */
  private async backfillMemoryVectors(): Promise<void> {
    try {
      const processed = await EmployeeMemoryEmbeddingService.getInstance().backfillMissing()
      if (processed > 0) logger.info(`Memory vector backfill processed ${processed} item(s)`)
    } catch (err: any) {
      logger.warn(`Memory vector backfill failed: ${err?.message || err}`)
    }
  }

  private async extractMemoriesForConversation(conv: any): Promise<void> {
    const messages = (() => {
      try { return JSON.parse(conv.messages_json || '[]') } catch { return [] }
    })()

    if (messages.length === 0) {
      this.markExtracted(conv.id, 0)
      return
    }

    const attempts = Number(conv.memory_extract_attempts) || 0

    // 获取员工配置的 LLM provider 和 model（复用与聊天相同的解析逻辑）
    const resolved = await this.resolveEmployeeLLM()
    if (!resolved) {
      logger.warn(`No LLM provider/model available for employee ${conv.employee_id}, skipping memory extraction`)
      this.handleExtractionFailure(conv, attempts, 'no LLM provider')
      return
    }

    const { providerId, modelId } = resolved

    logger.info(`Extracting memories for conversation "${conv.title || conv.id}" (employee: ${conv.employee_name}, model: ${modelId})`)

    try {
      await this.memoryService.extractMemoriesFromConversation(
        conv.employee_id,
        messages,
        providerId,
        modelId,
        conv.id,
        conv.memory_extracted_message_count || 0,
      )
    } catch (err: any) {
      this.handleExtractionFailure(conv, attempts, err?.message || String(err))
      return
    }

    // 清理过期记忆 + 自动合并
    this.memoryService.removeStaleMemories({ scope: 'employee', employeeId: conv.employee_id })
    await this.memoryService.autoConsolidateIfNeeded(conv.employee_id, providerId, modelId)

    this.markExtracted(conv.id, messages.length)
    logger.info(`Memory extraction completed for conversation ${conv.id}`)
  }

  /**
   * 提取失败的统一处理：计数并重试，达到上限后放弃并推进指针。
   *
   * 原先"失败也推进指针"会静默丢弃记忆；改为有限重试后放弃，
   * 既避免同一对话被永久反复重试，也不丢记忆。
   */
  private handleExtractionFailure(conv: any, attempts: number, reason: string): void {
    const nextAttempts = attempts + 1
    if (nextAttempts >= EXTRACTION_MAX_ATTEMPTS) {
      logger.error(`记忆提取连续失败 ${nextAttempts} 次，放弃并推进指针: conversation=${conv.id}, reason=${reason}`)
      this.markExtracted(conv.id, conv.message_count)
      return
    }
    logger.warn(`记忆提取失败（第 ${nextAttempts}/${EXTRACTION_MAX_ATTEMPTS} 次），保留指针待下次重试: conversation=${conv.id}, reason=${reason}`)
    this.db.getDb().prepare(
      'UPDATE conversations SET memory_extract_attempts = ? WHERE id = ?'
    ).run(nextAttempts, conv.id)
  }

  /** 手动触发指定对话的记忆提取（右键菜单调用）
   *  手动提取处理全部消息（extractedMessageCount=0），用于重新提取或补救自动提取的遗漏。
   */
  async extractManually(conversationId: string): Promise<{ success: boolean; error?: string }> {
    const conv = this.db.getDb().prepare(
      'SELECT id, employee_id, title, messages_json, message_count, memory_extracted_message_count FROM conversations WHERE id = ?'
    ).get(conversationId) as any
    if (!conv) return { success: false, error: 'CONVERSATION_NOT_FOUND' }

    if (!this.isEmployeeMemoryEnabled(conv.employee_id)) return { success: false, error: 'MEMORY_NOT_ENABLED' }

    const messages = (() => {
      try { return JSON.parse(conv.messages_json || '[]') } catch { return [] }
    })()
    if (messages.length === 0) return { success: false, error: 'NO_MESSAGES' }

    const resolved = await this.resolveEmployeeLLM()
    if (!resolved) return { success: false, error: 'NO_LLM_PROVIDER' }

    try {
      // 手动提取：全量处理全部消息，不用摘要，给 LLM 完整上下文以充分提取
      await this.memoryService.extractMemoriesFromConversation(
        conv.employee_id, messages, resolved.providerId, resolved.modelId, conv.id, 0, true,
      )
      this.memoryService.removeStaleMemories({ scope: 'employee', employeeId: conv.employee_id })
      await this.memoryService.autoConsolidateIfNeeded(conv.employee_id, resolved.providerId, resolved.modelId)
      this.markExtracted(conv.id, messages.length)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' }
    }
  }

  /** 开启跨任务记忆的员工 id 集合。
   *  user 员工开关存 employees.memory_enabled；注册员工（内置/插件）的开关存注册表 KV，
   *  其 DB 影子记录该列恒为 0，需按注册表补齐。
   */
  private getMemoryEnabledEmployeeIds(): string[] {
    const ids = new Set<string>(
      (this.db.getDb().prepare('SELECT id FROM employees WHERE memory_enabled = 1').all() as Array<{ id: string }>)
        .map(row => row.id)
    )
    for (const emp of EmployeeRegistryService.getInstance().listRegistered()) {
      if (emp.memory_enabled) ids.add(emp.id)
    }
    return Array.from(ids)
  }

  /** 员工是否开启记忆（注册员工以注册表 KV 为准，DB 影子记录不可信） */
  private isEmployeeMemoryEnabled(employeeId: string): boolean {
    const registered = EmployeeRegistryService.getInstance().getRegistered(employeeId)
    if (registered) return registered.memory_enabled
    const row = this.db.getDb().prepare('SELECT memory_enabled FROM employees WHERE id = ?').get(employeeId) as { memory_enabled: number } | undefined
    return row?.memory_enabled === 1
  }

  /** 解析记忆提取使用的 LLM provider + model。
   *
   *  复用与 employee-agent.service.ts 相同的模型解析逻辑：
   *  1. 从 default_model_memory / default_model_workbench 设置读取 provider_id + model_id
   *  2. 用 getProviderConfig 获取完整 provider 配置
   *  3. 用 getModelConfig + resolveModelName 解析出 API 模型名
   *  4. 当 model_id 为空时，取 provider 的第一个 chat 模型
   *
   *  public 供 IPC handler 在前端未传 model_id 时复用同一解析逻辑。
   */
  async resolveEmployeeLLM(): Promise<{ providerId: string; modelId: string } | null> {
    const db = this.db.getDb()
    const llmClient = LLMClientService.getInstance()

    // 按优先级尝试各设置源
    const settingKeys = ['default_model_memory', 'default_model_workbench']
    for (const key of settingKeys) {
      const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      if (!setting?.value) continue
      try {
        const { provider_id, model_id } = JSON.parse(setting.value) as { provider_id: string; model_id: string }
        if (!provider_id) continue

        const config = await llmClient.getProviderConfig(provider_id)
        if (!config) continue

        // 与 employee-agent.service.ts 第 138-140 行相同的解析逻辑
        const modelIdentifier = model_id?.trim() || undefined
        const modelConfig = this.getModelConfig(config, modelIdentifier)
        const resolvedModelName = modelConfig?.model || modelIdentifier || config.model

        if (resolvedModelName?.trim()) {
          return { providerId: provider_id, modelId: resolvedModelName.trim() }
        }
      } catch { /* ignore parse error */ }
    }

    // 最终兜底：任意可用 provider
    const provider = db.prepare(
      'SELECT id FROM llm_providers ORDER BY is_default DESC LIMIT 1'
    ).get() as { id: string } | undefined

    if (!provider?.id) return null

    const config = await llmClient.getProviderConfig(provider.id)
    if (!config) return null

    // modelIdentifier = undefined → getModelConfig 取第一个 chat 模型
    const modelConfig = this.getModelConfig(config, undefined)
    const resolvedModelName = modelConfig?.model || config.model

    if (resolvedModelName?.trim()) {
      return { providerId: provider.id, modelId: resolvedModelName.trim() }
    }

    return null
  }

  /** 从 provider 的 models_json 中查找匹配的模型配置。
   *  与 employee-agent.service.ts.getModelConfig 完全相同逻辑：
   *  - modelId 非空时：先按 id 查找，再按 model 查找
   *  - modelId 为空时：取第一个 chat 模型
   */
  private getModelConfig(config: any, modelId?: string): { model?: string; is_default?: boolean; category?: string } | null {
    if (!config?.models_json) return null
    try {
      const models = JSON.parse(config.models_json) as Array<{ id?: string; model?: string; is_default?: boolean; category?: string }>
      const matched = modelId
        ? models.find(m => m.id === modelId) || models.find(m => m.model === modelId)
        : models.find(m => (m.category || 'chat') === 'chat') ?? models[0]
      return matched ?? null
    } catch {
      return null
    }
  }

  /** 标记对话的记忆提取已完成：推进提取指针并清零失败计数。
   *  推进 memory_extracted_message_count 后，增量查询
   *  `message_count > memory_extracted_message_count` 在新消息到来前不再命中该对话。
   */
  private markExtracted(conversationId: string, messageCount: number): void {
    this.db.getDb().prepare(
      'UPDATE conversations SET memory_extracted_at = unixepoch(), memory_extracted_message_count = ?, memory_extract_attempts = 0 WHERE id = ?'
    ).run(messageCount, conversationId)
  }
}

export default MemoryRefinementService
