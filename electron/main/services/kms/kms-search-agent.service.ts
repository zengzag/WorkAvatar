import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService, { type SearchOptions } from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
import { createLogger } from '../logger'
import {
  type SearchTraceStep,
  type AgentSearchResult,
  type AgentSearchOptions,
  type AgentLLMConfig,
  type FileInventoryItem,
  type ScopeSummaryItem,
  type SearchPlan,
  type DistilledResult,
  type FileToRead,
  QUERY_TYPE_LABELS,
  READ_CHUNK_SIZE,
} from './kms-search-agent-types'
import {
  identifyQueryType,
  planSearchPath,
  distillResults,
} from './kms-search-agent-llm'
import {
  getDefaultLLMConfig,
  getKmsEmbeddingConfig,
  getModelIdByProvider,
  getFileInventory,
  getScopeSummaries,
  selectFilesToRead,
  readFileChunk,
  getResultKey,
  logSearchHits,
  triggerEvaluateAndPromote,
} from './kms-search-agent-helpers'
import type { SearchResult } from './kms-search-engine.service'

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
 * 接收检索需求后，自主规划检索路径、多轮补充查找、筛选提纯内容，整个处理过程内部闭环。
 * 最终只输出核心结论加精准溯源信息（文件路径、页码、定位锚点），没有冗余原文和无效内容。
 *
 * 工作流程：
 * 1. 查询类型识别：LLM 判断属于 locate/concept/trend/analysis
 * 2. 获取文件清单：从数据库获取索引目录的文件名、路径、轻量摘要
 * 3. 检索路径规划：LLM 结合文件清单和查询类型，生成检索查询 + 可能相关的文件
 * 4. 多轮检索执行：搜索 + 文件分片读取，补充信息不足时读取文件片段
 * 5. 内容筛选提纯：LLM 从所有收集的信息中提取核心结论
 * 6. 输出规整结果：结论 + 精准溯源 + 详细中间过程
 */
class KMSSearchAgentService {
  private db: Database.Database
  private mainDb: DatabaseService
  private static instance: KMSSearchAgentService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
    this.mainDb = DatabaseService.getInstance()
  }

  static getInstance(): KMSSearchAgentService {
    if (!KMSSearchAgentService.instance) {
      KMSSearchAgentService.instance = new KMSSearchAgentService()
    }
    return KMSSearchAgentService.instance
  }

  /**
   * 执行智能检索
   * 整体流程：初始化 → 查询类型识别 → 获取文件清单 → 检索路径规划 → 多轮检索 → 信息补充 → 内容提纯 → 输出
   */
  async search(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    const steps: SearchTraceStep[] = []
    const trace: string[] = []
    const maxRounds = Math.min(Math.max(options?.maxRounds ?? 3, 1), 5)
    const topK = Math.min(Math.max(options?.topK ?? 10, 3), 30)

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

    const llmClient = LLMClientService.getInstance()
    const searchEngine = KMSSearchEngineService.getInstance()

    addStep({ phase: '初始化', action: '获取LLM配置', detail: `provider: ${llmConfig.providerId}`, type: 'info' })

    const baseSearchOpts: SearchOptions = {
      topK,
      fileExtensions: options?.fileExtensions,
      timeRangeStart: options?.timeRangeStart ? Math.floor(options.timeRangeStart / 1000) : undefined,
      timeRangeEnd: options?.timeRangeEnd ? Math.floor(options.timeRangeEnd / 1000) : undefined,
      dirIds: options?.dirIds,
      collectionIds: options?.collectionIds,
    }

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 1：查询类型识别 ===
    addStep({ phase: '查询类型识别', action: '分析查询意图', type: 'llm' })
    const t0 = Date.now()
    const queryType = await identifyQueryType(query, llmClient, llmConfig.providerId, llmConfig.modelId, options?.signal, llmConfig.enableThinking)
    addStep({
      phase: '查询类型识别',
      action: `查询类型: ${QUERY_TYPE_LABELS[queryType]}`,
      detail: queryType,
      type: 'llm',
      durationMs: Date.now() - t0,
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 2：获取文件清单 + 作用域摘要 ===
    addStep({ phase: '获取文件清单', action: '读取索引目录文件列表', type: 'info' })
    const t1 = Date.now()
    const fileInventory: FileInventoryItem[] = getFileInventory(this.db, options?.dirIds, options?.collectionIds, query)
    addStep({
      phase: '获取文件清单',
      action: `获取到 ${fileInventory.length} 个文件的信息`,
      detail: fileInventory.length > 0 ? `代表文件: ${fileInventory.slice(0, 3).map(f => f.fileName).join(', ')}...` : '无文件',
      type: 'info',
      durationMs: Date.now() - t1,
    })

    const dirSummaries: ScopeSummaryItem[] = getScopeSummaries(this.db, options?.dirIds, options?.collectionIds)
    if (dirSummaries.length > 0) {
      addStep({
        phase: '获取文件清单',
        action: `获取到 ${dirSummaries.length} 个${options?.collectionIds ? '合集' : '目录'}摘要`,
        type: 'info',
      })
    }

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 3：检索路径规划 ===
    addStep({ phase: '检索路径规划', action: 'LLM 规划检索策略', type: 'plan' })
    const t2 = Date.now()
    const searchPlan: SearchPlan = await planSearchPath(
      query, queryType, fileInventory, dirSummaries,
      llmClient, llmConfig.providerId, llmConfig.modelId, options?.signal, llmConfig.enableThinking
    )
    addStep({
      phase: '检索路径规划',
      action: `规划 ${searchPlan.queries.length} 个检索查询，${searchPlan.candidateFileIds.length} 个候选文件`,
      detail: `查询: ${searchPlan.queries.join(' | ')}${searchPlan.candidateFileIds.length > 0 ? `；候选文件: ${searchPlan.candidateFileIds.length}个` : ''}`,
      type: 'plan',
      durationMs: Date.now() - t2,
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 4：多轮检索执行 ===
    const { allResults, roundsExecuted } = await this.executeMultiRoundSearch(
      searchPlan, baseSearchOpts, query, maxRounds, topK,
      llmClient, searchEngine, options?.signal, addStep,
    )

    addStep({
      phase: '检索完成',
      action: `共收集 ${allResults.length} 条原始结果`,
      type: 'result',
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 5：信息补充（搜索结果不足或LLM规划了候选文件时） ===
    const supplementaryContent = await this.gatherSupplementaryContent(
      allResults, searchPlan, topK, options?.signal, addStep,
    )

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // === 阶段 6：内容提纯 ===
    addStep({ phase: '内容提纯', action: 'LLM 生成核心结论', type: 'llm' })
    const t5 = Date.now()
    const distilled: DistilledResult = await distillResults(
      query,
      queryType,
      allResults,
      supplementaryContent,
      llmClient,
      llmConfig.providerId,
      llmConfig.modelId,
      options?.signal,
      llmConfig.enableThinking
    )

    addStep({
      phase: '内容提纯',
      action: `生成结论（${distilled.conclusion.length} 字符，${distilled.sources.length} 个来源）`,
      type: 'result',
      durationMs: Date.now() - t5,
    })

    // 记录搜索命中
    logSearchHits(allResults)

    // 搜索后异步触发冷热数据评估（去抖，5分钟内不重复）
    // 高频命中的冷文件会自动晋升为热文件，并触发 file2md 重新解析 + LLM 摘要生成
    triggerEvaluateAndPromote(false)

    return {
      queryType,
      queryTypeLabel: QUERY_TYPE_LABELS[queryType],
      conclusion: distilled.conclusion,
      sources: distilled.sources,
      searchRounds: roundsExecuted,
      searchTrace: trace,
      searchSteps: steps,
    }
  }

  /**
   * 阶段 4：执行多轮检索
   * - 第一轮使用语义搜索（若有 embedding 配置），后续轮次根据规划决定
   * - 去重合并结果
   * - 结果充足时提前结束；首轮无结果时用原始查询降级重试
   */
  private async executeMultiRoundSearch(
    searchPlan: SearchPlan,
    baseSearchOpts: SearchOptions,
    originalQuery: string,
    maxRounds: number,
    topK: number,
    llmClient: LLMClientService,
    searchEngine: KMSSearchEngineService,
    signal: AbortSignal | undefined,
    addStep: (step: SearchTraceStep) => void,
  ): Promise<{ allResults: SearchResult[]; roundsExecuted: number }> {
    const allResults: SearchResult[] = []
    const seenKeys = new Set<string>()
    let roundsExecuted = 0

    for (let i = 0; i < Math.min(searchPlan.queries.length, maxRounds); i++) {
      if (signal?.aborted) throw new Error('Search aborted')

      const subQuery = searchPlan.queries[i]
      const t3 = Date.now()

      // 第一轮使用语义搜索（如果有embedding配置），后续轮次根据规划决定
      const useSemantic = i === 0 || searchPlan.useSemanticForAll
      let queryEmbedding: Float32Array | undefined
      if (useSemantic) {
        try {
          const defaultEmbConfig = getKmsEmbeddingConfig(llmClient, this.mainDb)
          if (defaultEmbConfig) {
            queryEmbedding = await llmClient.createEmbedding(
              defaultEmbConfig.providerId,
              subQuery,
              defaultEmbConfig.modelName
            )
          }
        } catch (err) {
          logger.warn('Failed to generate query embedding:', err)
        }
      }

      const results = searchEngine.search(subQuery, queryEmbedding, baseSearchOpts)

      // 去重
      let newCount = 0
      for (const r of results) {
        const key = getResultKey(r)
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          allResults.push(r)
          newCount++
        }
      }

      addStep({
        phase: `第${i + 1}轮检索`,
        action: `搜索"${subQuery}"`,
        detail: `返回${results.length}条结果，新增${newCount}条${useSemantic ? '（语义）' : '（关键词）'}`,
        type: 'search',
        durationMs: Date.now() - t3,
      })

      roundsExecuted++

      // 如果已经收集到足够结果，提前结束
      if (allResults.length >= topK * 2) {
        addStep({ phase: `第${i + 1}轮检索`, action: `已收集 ${allResults.length} 条结果，提前结束检索`, type: 'info' })
        break
      }

      // 如果首轮无结果，尝试放宽搜索
      if (i === 0 && results.length === 0) {
        addStep({ phase: `第${i + 1}轮检索`, action: '首轮无结果，尝试使用原始查询重试', type: 'search' })
        const fallbackResults = searchEngine.search(originalQuery, queryEmbedding, baseSearchOpts)
        for (const r of fallbackResults) {
          const key = getResultKey(r)
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            allResults.push(r)
          }
        }
      }
    }

    return { allResults, roundsExecuted }
  }

  /**
   * 阶段 5：补充读取文件片段
   * - 当搜索结果不足，或LLM规划了候选文件时，读取相关文件的开头片段补充上下文
   * - 最多读取 5 个文件，每个文件读取 READ_CHUNK_SIZE 字符
   */
  private async gatherSupplementaryContent(
    allResults: SearchResult[],
    searchPlan: SearchPlan,
    topK: number,
    signal: AbortSignal | undefined,
    addStep: (step: SearchTraceStep) => void,
  ): Promise<string> {
    const filesToRead: FileToRead[] = selectFilesToRead(this.db, allResults, searchPlan.candidateFileIds, allResults.length < topK)
    if (filesToRead.length === 0) {
      return ''
    }

    addStep({
      phase: '信息补充',
      action: `读取 ${filesToRead.length} 个文件片段补充信息`,
      detail: filesToRead.map(f => f.fileName).join(', '),
      type: 'read',
    })

    const t4 = Date.now()
    const readChunks: string[] = []
    for (const fileInfo of filesToRead.slice(0, 5)) {
      if (signal?.aborted) throw new Error('Search aborted')
      try {
        const chunk = await readFileChunk(this.db, fileInfo.fileId, 0, READ_CHUNK_SIZE)
        if (chunk) {
          readChunks.push(`【${fileInfo.fileName}】\n${chunk}`)
          addStep({
            phase: '信息补充',
            action: `读取文件片段: ${fileInfo.fileName}`,
            detail: `${chunk.length} 字符`,
            type: 'read',
          })
        }
      } catch (err) {
        logger.warn(`Failed to read chunk from ${fileInfo.fileName}:`, err)
      }
    }
    const supplementaryContent = readChunks.join('\n\n---\n\n')
    if (supplementaryContent) {
      addStep({
        phase: '信息补充',
        action: `补充读取完成，共 ${supplementaryContent.length} 字符`,
        type: 'read',
        durationMs: Date.now() - t4,
      })
    }
    return supplementaryContent
  }

  private getDefaultLLMConfig(): AgentLLMConfig | null {
    return getDefaultLLMConfig(this.mainDb)
  }

  private getModelIdByProvider(providerId: string): string | undefined {
    return getModelIdByProvider(this.mainDb, providerId)
  }
}

export default KMSSearchAgentService
