import DatabaseService from '../database.service'
import { createLogger } from '../logger'
import {
  type SearchTraceStep,
  type AgentSearchResult,
  type AgentSearchOptions,
  type AgentSearchSource,
  type AgentLLMConfig,
  QUERY_TYPE_LABELS,
} from './kms-search-agent-types'
import {
  getDefaultLLMConfig,
  getModelIdByProvider,
  fallbackClassify,
  triggerEvaluateAndPromote,
} from './kms-search-agent-helpers'
import { runUnifiedAgentLoop } from './kms-knowledge-card-agent'

const logger = createLogger('KMS-SearchAgent')

// 向后兼容：重新导出类型供外部使用
export type {
  QueryType,
  SearchTraceStep,
  AgentSearchResult,
  AgentSearchOptions,
  AgentSearchSource,
} from './kms-search-agent-types'

/**
 * KMS 检索子智能体
 *
 * 使用增量式 Agent Loop 进行检索：LLM 自主调用 kms_search / kms_get_content 工具，
 * 消息在多轮迭代中累积追加（前缀不变、尾部追加），最大化 prompt cache 命中率。
 * 与知识卡片生成共用同一核心链路（runUnifiedAgentLoop），仅在输出格式上不同。
 */
class KMSSearchAgentService {
  private mainDb: DatabaseService
  private static instance: KMSSearchAgentService

  private constructor() {
    this.mainDb = DatabaseService.getInstance()
  }

  static getInstance(): KMSSearchAgentService {
    if (!KMSSearchAgentService.instance) {
      KMSSearchAgentService.instance = new KMSSearchAgentService()
    }
    return KMSSearchAgentService.instance
  }

  /**
   * 执行智能检索（增量式 Agent Loop）
   *
   * LLM 自主决定搜索策略、读取哪些文件正文、何时停止，最终输出核心结论和精准溯源信息。
   * system prompt 稳定不变，messages 在多轮迭代中累积追加 → 高 cache 命中率。
   */
  async search(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    const steps: SearchTraceStep[] = []
    const trace: string[] = []
    const addStep = (step: SearchTraceStep) => {
      steps.push(step)
      trace.push(step.action + (step.detail ? `：${step.detail}` : ''))
      options?.onProgress?.(step)
    }

    const llmConfig: AgentLLMConfig | null = options?.providerId
      ? { providerId: options.providerId, modelId: this.getModelIdByProvider(options.providerId), enableThinking: false }
      : this.getDefaultLLMConfig()
    if (!llmConfig || !llmConfig.providerId) {
      throw new Error('No LLM provider configured. Please configure an LLM provider first.')
    }

    addStep({ phase: '初始化', action: '获取LLM配置', detail: `provider: ${llmConfig.providerId}`, type: 'info' })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 增量式 Agent Loop 检索 ===
    addStep({ phase: '智能检索', action: '启动增量式检索', type: 'plan' })
    const t0 = Date.now()

    const result = await runUnifiedAgentLoop(query, llmConfig, {
      mode: 'search',
      signal: options?.signal,
      onProgress: addStep,
      maxIterations: options?.maxRounds ? Math.min(options.maxRounds * 5, 30) : undefined,
      collectionIds: options?.collectionIds,
      dirIds: options?.dirIds,
      fileExtensions: options?.fileExtensions,
    })

    if (!result.success || !result.result) {
      return {
        queryType: 'locate',
        queryTypeLabel: QUERY_TYPE_LABELS.locate,
        conclusion: `搜索失败：${result.error || '未知错误'}`,
        sources: [],
        searchRounds: 0,
        searchTrace: trace,
        searchSteps: steps,
      }
    }

    // 从 agent loop 跟踪的访问文件构建溯源信息
    const sources: AgentSearchSource[] = result.result.accessedFiles.map(f => ({
      fileId: f.fileId,
      fileName: f.fileName,
      filePath: f.filePath,
      paragraphId: f.paragraphId,
      paragraphTitle: f.paragraphTitle,
      snippet: f.snippet,
      startLine: f.startLine,
      endLine: f.endLine,
    }))

    // 查询类型推断（基于关键词正则，无需 LLM 调用）
    const queryType = fallbackClassify(query)

    // 记录搜索命中（用于冷热数据评估）
    const hitFileIds = [...new Set(result.result.accessedFiles.map(f => f.fileId))]
    if (hitFileIds.length > 0) {
      try {
        const crawler = require('./kms-crawler.service').default.getInstance()
        crawler.logFileAccessBatch(hitFileIds, 'search_hit')
      } catch (error) {
        logger.debug('Failed to log search hits batch', error)
      }
    }

    // 搜索后异步触发冷热数据评估（去抖，5分钟内不重复）
    triggerEvaluateAndPromote(false)

    addStep({
      phase: '检索完成',
      action: `生成结论（${result.result.content.length} 字符，${sources.length} 个来源）`,
      type: 'result',
      durationMs: Date.now() - t0,
    })

    return {
      queryType,
      queryTypeLabel: QUERY_TYPE_LABELS[queryType],
      conclusion: result.result.content,
      sources,
      searchRounds: result.result.iterations,
      searchTrace: trace,
      searchSteps: steps,
    }
  }

  private getDefaultLLMConfig(): AgentLLMConfig | null {
    return getDefaultLLMConfig(this.mainDb)
  }

  private getModelIdByProvider(providerId: string): string | undefined {
    return getModelIdByProvider(this.mainDb, providerId)
  }
}

export default KMSSearchAgentService
