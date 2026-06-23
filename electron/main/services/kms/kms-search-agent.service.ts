import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import { getDefaultProviderId } from '../common-utils'
import { createLogger } from '../logger'

const logger = createLogger('KMS-SearchAgent')

/**
 * 查询类型枚举
 * - locate: 定位查找（找某个具体信息在哪）
 * - concept: 概念解释（解释某个概念/术语）
 * - trend: 趋势梳理（梳理时间线/变化趋势）
 * - analysis: 综合分析（汇总多源信息得出结论）
 */
export type QueryType = 'locate' | 'concept' | 'trend' | 'analysis'

/**
 * 检索子智能体输出结果
 */
export interface AgentSearchResult {
  /** 查询类型 */
  queryType: QueryType
  /** 查询类型说明 */
  queryTypeLabel: string
  /** 核心结论（已整理的干净内容，无冗余原文） */
  conclusion: string
  /** 精准溯源信息列表 */
  sources: AgentSearchSource[]
  /** 实际执行的检索轮次 */
  searchRounds: number
  /** 检索过程摘要（用于调试和透明度） */
  searchTrace: string[]
}

export interface AgentSearchSource {
  /** 文件ID */
  fileId: string
  /** 文件名 */
  fileName: string
  /** 文件路径 */
  filePath: string
  /** 段落ID（如有） */
  paragraphId?: string
  /** 段落标题（如有） */
  paragraphTitle?: string
  /** 命中片段（精简） */
  snippet: string
  /** 行号定位 */
  startLine?: number
  endLine?: number
  /** 字符偏移定位 */
  startOffset?: number
  endOffset?: number
  /** 相关度评分 */
  score?: number
}

export interface AgentSearchOptions {
  /** 限定目录ID列表 */
  dirIds?: string[]
  /** 限定文件扩展名 */
  fileExtensions?: string[]
  /** 时间范围起始（毫秒时间戳） */
  timeRangeStart?: number
  /** 时间范围结束（毫秒时间戳） */
  timeRangeEnd?: number
  /** 最大检索轮次（默认3） */
  maxRounds?: number
  /** 每轮检索的topK（默认10） */
  topK?: number
  /** 中止信号 */
  signal?: AbortSignal
  /** 指定LLM提供商ID */
  providerId?: string
}

const QUERY_TYPE_LABELS: Record<QueryType, string> = {
  locate: '定位查找',
  concept: '概念解释',
  trend: '趋势梳理',
  analysis: '综合分析',
}

/**
 * KMS 检索子智能体
 *
 * 接收检索需求后，自主规划检索路径、多轮补充查找、筛选提纯内容，整个处理过程内部闭环。
 * 最终只输出核心结论加精准溯源信息（文件路径、页码、定位锚点），没有冗余原文和无效内容。
 *
 * 工作流程：
 * 1. 查询类型识别：LLM 判断属于 locate/concept/trend/analysis
 * 2. 检索路径规划：根据查询类型生成多组关键词和检索策略
 * 3. 多轮检索执行：按规划执行检索，必要时根据前一轮结果补充检索
 * 4. 内容筛选提纯：LLM 从检索结果中提取核心结论，去除冗余
 * 5. 输出规整结果：结论 + 精准溯源
 */
class KMSSearchAgentService {
  private db: Database.Database
  private static instance: KMSSearchAgentService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSSearchAgentService {
    if (!KMSSearchAgentService.instance) {
      KMSSearchAgentService.instance = new KMSSearchAgentService()
    }
    return KMSSearchAgentService.instance
  }

  /**
   * 执行智能检索
   */
  async search(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    const trace: string[] = []
    const maxRounds = Math.min(Math.max(options?.maxRounds ?? 3, 1), 5)
    const topK = Math.min(Math.max(options?.topK ?? 10, 3), 30)

    // 获取 LLM 提供商
    const providerId = options?.providerId || this.getDefaultProviderId()
    if (!providerId) {
      throw new Error('No LLM provider configured. Please configure an LLM provider first.')
    }

    const llmClient = LLMClientService.getInstance()
    const searchEngine = KMSSearchEngineService.getInstance()

    // 构建基础检索选项
    const baseSearchOpts: SearchOptions = {
      topK,
      fileExtensions: options?.fileExtensions,
      timeRangeStart: options?.timeRangeStart ? Math.floor(options.timeRangeStart / 1000) : undefined,
      timeRangeEnd: options?.timeRangeEnd ? Math.floor(options.timeRangeEnd / 1000) : undefined,
    }

    // 如果指定了目录，转换为文件ID列表
    if (options?.dirIds && options.dirIds.length > 0) {
      const fileIds = this.getFileIdsByDirIds(options.dirIds)
      if (fileIds.length > 0) {
        baseSearchOpts.fileIds = fileIds
      }
    }

    // 阶段1：查询类型识别
    trace.push('识别查询类型')
    const queryType = await this.identifyQueryType(query, llmClient, providerId, options?.signal)
    trace.push(`查询类型: ${QUERY_TYPE_LABELS[queryType]}`)

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // 阶段2：检索路径规划
    trace.push('规划检索路径')
    const searchPlan = await this.planSearchPath(query, queryType, llmClient, providerId, options?.signal)
    trace.push(`规划 ${searchPlan.queries.length} 个检索查询`)

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // 阶段3：多轮检索执行
    const allResults: SearchResult[] = []
    const seenKeys = new Set<string>()
    let roundsExecuted = 0

    for (let i = 0; i < Math.min(searchPlan.queries.length, maxRounds); i++) {
      if (options?.signal?.aborted) throw new Error('Search aborted')

      const subQuery = searchPlan.queries[i]
      trace.push(`第 ${i + 1} 轮检索: ${subQuery}`)

      // 第一轮使用语义搜索（如果有embedding配置），后续轮次根据规划决定
      const useSemantic = i === 0 || searchPlan.useSemanticForAll
      let queryEmbedding: Float32Array | undefined
      if (useSemantic) {
        try {
          const defaultEmbConfig = llmClient.getDefaultEmbeddingConfig()
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
      for (const r of results) {
        const key = this.getResultKey(r)
        if (!seenKeys.has(key)) {
          seenKeys.add(key)
          allResults.push(r)
        }
      }

      roundsExecuted++

      // 如果已经收集到足够结果，提前结束
      if (allResults.length >= topK * 2) {
        trace.push(`已收集 ${allResults.length} 条结果，提前结束检索`)
        break
      }

      // 如果首轮无结果，尝试放宽搜索
      if (i === 0 && results.length === 0) {
        trace.push('首轮无结果，尝试使用原始查询重试')
        const fallbackResults = searchEngine.search(query, queryEmbedding, baseSearchOpts)
        for (const r of fallbackResults) {
          const key = this.getResultKey(r)
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            allResults.push(r)
          }
        }
      }
    }

    trace.push(`共收集 ${allResults.length} 条原始结果`)

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // 阶段4：内容筛选提纯
    trace.push('筛选提纯内容')
    const distilled = await this.distillResults(
      query,
      queryType,
      allResults,
      llmClient,
      providerId,
      options?.signal
    )

    trace.push(`生成结论（${distilled.conclusion.length} 字符）`)

    // 记录搜索命中
    this.logSearchHits(allResults)

    return {
      queryType,
      queryTypeLabel: QUERY_TYPE_LABELS[queryType],
      conclusion: distilled.conclusion,
      sources: distilled.sources,
      searchRounds: roundsExecuted,
      searchTrace: trace,
    }
  }

  // ==================== 私有方法 ====================

  private getDefaultProviderId(): string | null {
    // 优先使用知识库场景的默认模型
    const row = this.db.prepare(
      "SELECT value FROM settings WHERE key = 'default_model_knowledge'"
    ).get() as any
    if (row?.value) {
      try {
        const config = JSON.parse(row.value)
        if (config.provider_id) return config.provider_id
      } catch {}
    }
    // 降级到全局默认
    return getDefaultProviderId({ getDb: () => this.db })
  }

  /**
   * 识别查询类型
   */
  private async identifyQueryType(
    query: string,
    llmClient: LLMClientService,
    providerId: string,
    signal?: AbortSignal
  ): Promise<QueryType> {
    const prompt = `分析以下用户查询的意图类型，只返回类型代码，不要其他内容。

查询：${query}

类型定义：
- locate: 定位查找（找某个具体信息在哪里，如"xxx在哪"、"xxx的联系方式"、"找出包含xxx的文件"）
- concept: 概念解释（解释某个概念、术语、定义，如"什么是xxx"、"xxx是什么意思"）
- trend: 趋势梳理（梳理时间线、变化趋势、发展过程，如"xxx的发展历程"、"xxx的变化趋势"）
- analysis: 综合分析（汇总多源信息得出结论，如"总结xxx"、"分析xxx的现状"、"对比xxx和yyy"）

只返回类型代码（locate/concept/trend/analysis）：`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个查询意图分类器，只输出类型代码。' },
        { role: 'user', content: prompt },
      ], { temperature: 0, max_tokens: 20, signal, logSource: 'kms_agent_classify' })

      const type = result.trim().toLowerCase()
      if (['locate', 'concept', 'trend', 'analysis'].includes(type)) {
        return type as QueryType
      }
    } catch (err) {
      logger.warn('Failed to identify query type:', err)
    }

    // 降级：基于关键词的简单分类
    return this.fallbackClassify(query)
  }

  /**
   * 降级查询类型分类
   */
  private fallbackClassify(query: string): QueryType {
    const lower = query.toLowerCase()
    if (/在哪|哪里|位置|定位|找出|找到|查找|哪个文件/.test(lower)) return 'locate'
    if (/什么是|是什么|解释|定义|含义|意思/.test(lower)) return 'concept'
    if (/趋势|变化|发展|历程|时间线|演变/.test(lower)) return 'trend'
    if (/总结|分析|对比|汇总|概括|综述/.test(lower)) return 'analysis'
    return 'locate'
  }

  /**
   * 规划检索路径
   */
  private async planSearchPath(
    query: string,
    queryType: QueryType,
    llmClient: LLMClientService,
    providerId: string,
    signal?: AbortSignal
  ): Promise<{ queries: string[]; useSemanticForAll: boolean }> {
    const typeStrategy: Record<QueryType, string> = {
      locate: '使用精确关键词直接定位，可尝试同义词扩展',
      concept: '先搜索概念定义，再搜索相关上下文',
      trend: '按时间维度搜索，关注历史数据和最新数据',
      analysis: '多角度搜索，覆盖不同方面的信息',
    }

    const prompt = `你是一个检索路径规划器。根据用户查询和查询类型，生成多个检索查询用于多轮检索。

用户查询：${query}
查询类型：${queryType}（${QUERY_TYPE_LABELS[queryType]}）
检索策略：${typeStrategy[queryType]}

要求：
1. 生成 1-3 个检索查询，每个查询应该是关键词组合，适合全文检索
2. 第一个查询应最贴近原始查询
3. 后续查询用于补充信息，可以是同义词、相关概念或不同角度
4. 每个查询不超过 30 个字符
5. 返回 JSON 格式：{"queries": ["查询1", "查询2"], "use_semantic_for_all": false}`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个检索路径规划器，只返回JSON。' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, max_tokens: 300, signal, logSource: 'kms_agent_plan' })

      const parsed = JSON.parse(result)
      if (Array.isArray(parsed.queries) && parsed.queries.length > 0) {
        return {
          queries: parsed.queries.slice(0, 3).map((q: any) => String(q).trim()).filter(Boolean),
          useSemanticForAll: Boolean(parsed.use_semantic_for_all),
        }
      }
    } catch (err) {
      logger.warn('Failed to plan search path:', err)
    }

    // 降级：直接使用原始查询
    return { queries: [query], useSemanticForAll: false }
  }

  /**
   * 筛选提纯结果
   */
  private async distillResults(
    query: string,
    queryType: QueryType,
    results: SearchResult[],
    llmClient: LLMClientService,
    providerId: string,
    signal?: AbortSignal
  ): Promise<{ conclusion: string; sources: AgentSearchSource[] }> {
    if (results.length === 0) {
      return {
        conclusion: `未找到与"${query}"相关的内容。建议：\n1. 尝试更宽泛的关键词\n2. 检查索引目录是否已添加并完成索引\n3. 使用更通用的术语`,
        sources: [],
      }
    }

    // 限制传入LLM的结果数量，避免token过多
    const maxResults = Math.min(results.length, 15)
    const limitedResults = results.slice(0, maxResults)

    // 构建结果摘要
    const resultsText = limitedResults.map((r, i) => {
      const parts: string[] = [`[${i + 1}] ${r.file_name}`]
      if (r.paragraph_title) parts.push(`段落: ${r.paragraph_title}`)
      if (r.start_line !== undefined && r.end_line !== undefined) {
        parts.push(`行: ${r.start_line}-${r.end_line}`)
      }
      parts.push(`内容: ${r.text.substring(0, 300)}`)
      return parts.join(' | ')
    }).join('\n')

    const typeInstruction: Record<QueryType, string> = {
      locate: '直接指出查询内容所在的位置，包括文件名和具体位置（行号/段落）。',
      concept: '基于检索到的内容解释概念，整合多个来源的信息给出完整解释。',
      trend: '按时间顺序梳理趋势变化，标注关键节点和对应来源。',
      analysis: '综合分析多源信息，得出结论并标注各结论的依据来源。',
    }

    const prompt = `你是一个内容提纯助手。基于检索结果，针对用户查询生成核心结论。

用户查询：${query}
查询类型：${queryType}（${QUERY_TYPE_LABELS[queryType]}）

检索结果：
${resultsText}

要求：
1. ${typeInstruction[queryType]}
2. 结论简洁明了，不要堆砌原文
3. 在结论中用 [序号] 标注信息来源，如"xxx [1]"
4. 如果信息不足以回答，明确说明缺失的内容
5. 结论不超过 500 字
6. 直接输出结论，不要添加"根据检索结果"之类的开场白`

    try {
      const conclusion = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个内容提纯助手，输出简洁准确的结论。' },
        { role: 'user', content: prompt },
      ], { temperature: 0.2, max_tokens: 800, signal, logSource: 'kms_agent_distill' })

      // 构建溯源信息
      const sources: AgentSearchSource[] = limitedResults.map(r => ({
        fileId: r.file_id,
        fileName: r.file_name,
        filePath: r.file_path,
        paragraphId: r.paragraph_id,
        paragraphTitle: r.paragraph_title,
        snippet: r.text.substring(0, 200),
        startLine: r.start_line,
        endLine: r.end_line,
        startOffset: r.start_offset,
        endOffset: r.end_offset,
        score: r.score,
      }))

      return { conclusion: conclusion.trim(), sources }
    } catch (err) {
      logger.warn('Failed to distill results:', err)

      // 降级：直接返回原始结果摘要
      const conclusion = limitedResults.map((r, i) =>
        `[${i + 1}] ${r.file_name}${r.paragraph_title ? ` > ${r.paragraph_title}` : ''}: ${r.text.substring(0, 150)}`
      ).join('\n')

      const sources: AgentSearchSource[] = limitedResults.map(r => ({
        fileId: r.file_id,
        fileName: r.file_name,
        filePath: r.file_path,
        paragraphId: r.paragraph_id,
        paragraphTitle: r.paragraph_title,
        snippet: r.text.substring(0, 200),
        startLine: r.start_line,
        endLine: r.end_line,
        startOffset: r.start_offset,
        endOffset: r.end_offset,
        score: r.score,
      }))

      return { conclusion, sources }
    }
  }

  private getFileIdsByDirIds(dirIds: string[]): string[] {
    if (dirIds.length === 0) return []
    const placeholders = dirIds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT id FROM kms_files WHERE dir_id IN (${placeholders})`
    ).all(...dirIds) as any[]
    return rows.map(r => r.id)
  }

  private getResultKey(result: SearchResult): string {
    if (result.paragraph_id) return `paragraph-${result.paragraph_id}`
    if (result.match_type === 'content_paragraph' && result.start_offset !== undefined) {
      return `content-${result.file_id}-${result.start_offset}`
    }
    return `${result.match_type}-${result.file_id}`
  }

  private logSearchHits(results: SearchResult[]): void {
    const fileIds = new Set(results.map(r => r.file_id))
    const crawler = require('./kms-crawler.service').default.getInstance()
    for (const fileId of fileIds) {
      try {
        crawler.logFileAccess(fileId, 'search_hit')
      } catch {}
    }
  }
}

export default KMSSearchAgentService
