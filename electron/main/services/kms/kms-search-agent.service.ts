import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSSearchEngineService, { type SearchResult, type SearchOptions } from './kms-search-engine.service'
import LLMClientService from '../llm-client.service'
import DatabaseService from '../database.service'
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
 * 检索过程步骤（结构化中间过程）
 */
export interface SearchTraceStep {
  /** 阶段名称 */
  phase: string
  /** 步骤描述 */
  action: string
  /** 详细信息 */
  detail?: string
  /** 耗时（毫秒） */
  durationMs?: number
  /** 步骤类型：info/llm/search/read/plan */
  type: 'info' | 'llm' | 'search' | 'read' | 'plan' | 'result'
}

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
  /** 检索过程摘要（兼容旧格式，简单字符串列表） */
  searchTrace: string[]
  /** 结构化检索过程（详细中间步骤） */
  searchSteps: SearchTraceStep[]
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
  /** 中间过程回调（实时输出检索步骤） */
  onProgress?: (step: SearchTraceStep) => void
}

const QUERY_TYPE_LABELS: Record<QueryType, string> = {
  locate: '定位查找',
  concept: '概念解释',
  trend: '趋势梳理',
  analysis: '综合分析',
}

/** 文件分片读取的字符数 */
const READ_CHUNK_SIZE = 2000

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
   */
  async search(query: string, options?: AgentSearchOptions): Promise<AgentSearchResult> {
    const steps: SearchTraceStep[] = []
    const trace: string[] = []
    const maxRounds = Math.min(Math.max(options?.maxRounds ?? 3, 1), 5)
    const topK = Math.min(Math.max(options?.topK ?? 10, 3), 30)

    /** 记录一个步骤并通知回调 */
    const addStep = (step: SearchTraceStep) => {
      steps.push(step)
      trace.push(step.action + (step.detail ? `：${step.detail}` : ''))
      options?.onProgress?.(step)
    }

    // 获取 LLM 提供商和模型
    const llmConfig = options?.providerId
      ? { providerId: options.providerId, modelId: this.getModelIdByProvider(options.providerId) }
      : this.getDefaultLLMConfig()
    if (!llmConfig || !llmConfig.providerId) {
      throw new Error('No LLM provider configured. Please configure an LLM provider first.')
    }

    const llmClient = LLMClientService.getInstance()
    const searchEngine = KMSSearchEngineService.getInstance()

    addStep({ phase: '初始化', action: '获取LLM配置', detail: `provider: ${llmConfig.providerId}`, type: 'info' })

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

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段1：查询类型识别 ==========
    addStep({ phase: '查询类型识别', action: '分析查询意图', type: 'llm' })
    const t0 = Date.now()
    const queryType = await this.identifyQueryType(query, llmClient, llmConfig.providerId, llmConfig.modelId, options?.signal)
    addStep({
      phase: '查询类型识别',
      action: `查询类型: ${QUERY_TYPE_LABELS[queryType]}`,
      detail: queryType,
      type: 'llm',
      durationMs: Date.now() - t0,
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段2：获取文件清单（结合文件名/路径判断内容） ==========
    addStep({ phase: '获取文件清单', action: '读取索引目录文件列表', type: 'info' })
    const t1 = Date.now()
    const fileInventory = this.getFileInventory(options?.dirIds)
    addStep({
      phase: '获取文件清单',
      action: `获取到 ${fileInventory.length} 个文件的信息`,
      detail: fileInventory.length > 0 ? `代表文件: ${fileInventory.slice(0, 3).map(f => f.fileName).join(', ')}...` : '无文件',
      type: 'info',
      durationMs: Date.now() - t1,
    })

    // 获取目录摘要
    const dirSummaries = this.getDirSummaries(options?.dirIds)
    if (dirSummaries.length > 0) {
      addStep({
        phase: '获取文件清单',
        action: `获取到 ${dirSummaries.length} 个目录摘要`,
        type: 'info',
      })
    }

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段3：检索路径规划（结合文件清单） ==========
    addStep({ phase: '检索路径规划', action: 'LLM 规划检索策略', type: 'plan' })
    const t2 = Date.now()
    const searchPlan = await this.planSearchPath(
      query, queryType, fileInventory, dirSummaries,
      llmClient, llmConfig.providerId, llmConfig.modelId, options?.signal
    )
    addStep({
      phase: '检索路径规划',
      action: `规划 ${searchPlan.queries.length} 个检索查询，${searchPlan.candidateFileIds.length} 个候选文件`,
      detail: `查询: ${searchPlan.queries.join(' | ')}${searchPlan.candidateFileIds.length > 0 ? `；候选文件: ${searchPlan.candidateFileIds.length}个` : ''}`,
      type: 'plan',
      durationMs: Date.now() - t2,
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段4：多轮检索执行（搜索 + 文件读取） ==========
    const allResults: SearchResult[] = []
    const seenKeys = new Set<string>()
    let roundsExecuted = 0

    for (let i = 0; i < Math.min(searchPlan.queries.length, maxRounds); i++) {
      if (options?.signal?.aborted) throw new Error('Search aborted')

      const subQuery = searchPlan.queries[i]
      const t3 = Date.now()

      // 第一轮使用语义搜索（如果有embedding配置），后续轮次根据规划决定
      const useSemantic = i === 0 || searchPlan.useSemanticForAll
      let queryEmbedding: Float32Array | undefined
      if (useSemantic) {
        try {
          const defaultEmbConfig = this.getKmsEmbeddingConfig(llmClient)
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
        const key = this.getResultKey(r)
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

    addStep({
      phase: '检索完成',
      action: `共收集 ${allResults.length} 条原始结果`,
      type: 'result',
    })

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段5：信息补充（文件分片读取） ==========
    // 如果搜索结果不足，或LLM规划了候选文件，读取相关文件片段补充信息
    let supplementaryContent = ''
    const filesToRead = this.selectFilesToRead(allResults, searchPlan.candidateFileIds, allResults.length < topK)

    if (filesToRead.length > 0) {
      addStep({
        phase: '信息补充',
        action: `读取 ${filesToRead.length} 个文件片段补充信息`,
        detail: filesToRead.map(f => f.fileName).join(', '),
        type: 'read',
      })

      const t4 = Date.now()
      const readChunks: string[] = []
      for (const fileInfo of filesToRead.slice(0, 5)) { // 最多读取5个文件
        try {
          const chunk = await this.readFileChunk(fileInfo.fileId, 0, READ_CHUNK_SIZE)
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
      supplementaryContent = readChunks.join('\n\n---\n\n')
      if (supplementaryContent) {
        addStep({
          phase: '信息补充',
          action: `补充读取完成，共 ${supplementaryContent.length} 字符`,
          type: 'read',
          durationMs: Date.now() - t4,
        })
      }
    }

    if (options?.signal?.aborted) throw new Error('Search aborted')

    // ========== 阶段6：内容筛选提纯 ==========
    addStep({ phase: '内容提纯', action: 'LLM 生成核心结论', type: 'llm' })
    const t5 = Date.now()
    const distilled = await this.distillResults(
      query,
      queryType,
      allResults,
      supplementaryContent,
      llmClient,
      llmConfig.providerId,
      llmConfig.modelId,
      options?.signal
    )

    addStep({
      phase: '内容提纯',
      action: `生成结论（${distilled.conclusion.length} 字符，${distilled.sources.length} 个来源）`,
      type: 'result',
      durationMs: Date.now() - t5,
    })

    // 记录搜索命中
    this.logSearchHits(allResults)

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

  // ==================== 私有方法 ====================

  /**
   * 获取默认 LLM 配置（providerId + modelId）
   * 优先级：KMS 专属设置 (kms_model) > 知识场景默认模型 (default_model_knowledge) > 任意可用提供商
   */
  private getDefaultLLMConfig(): { providerId: string; modelId: string | undefined } | null {
    const db = this.mainDb.getDb()

    // 1. 优先使用 KMS 专属模型设置
    try {
      const kmsModelRow = db.prepare("SELECT value FROM settings WHERE key = 'kms_model'").get() as any
      if (kmsModelRow?.value) {
        const config = JSON.parse(kmsModelRow.value)
        if (config.provider_id) {
          return {
            providerId: config.provider_id,
            modelId: config.model_id || undefined,
          }
        }
      }
    } catch {}

    // 2. 回退到知识场景默认模型
    try {
      const row = db.prepare(
        "SELECT value FROM settings WHERE key = 'default_model_knowledge'"
      ).get() as any
      if (row?.value) {
        const config = JSON.parse(row.value)
        if (config.provider_id) {
          return {
            providerId: config.provider_id,
            modelId: config.model_id || undefined,
          }
        }
      }
    } catch {}

    // 3. 最后回退到任意可用提供商
    const fallbackProviderId = getDefaultProviderId(this.mainDb)
    if (fallbackProviderId) {
      return { providerId: fallbackProviderId, modelId: undefined }
    }
    return null
  }

  /**
   * 获取 KMS 专属 Embedding 配置
   * 优先级：KMS 专属设置 (kms_embedding_model) > 默认 Embedding 配置
   */
  private getKmsEmbeddingConfig(llmClient: LLMClientService): { providerId: string; modelName: string } | null {
    const db = this.mainDb.getDb()
    // 1. 优先使用 KMS 专属 Embedding 模型设置
    try {
      const kmsEmbRow = db.prepare("SELECT value FROM settings WHERE key = 'kms_embedding_model'").get() as any
      if (kmsEmbRow?.value) {
        const config = JSON.parse(kmsEmbRow.value)
        if (config.provider_id) {
          const provider = llmClient.getProvider(config.provider_id) as any
          if (provider) {
            let modelName = ''
            if (config.model_id && provider.models_json) {
              try {
                const models = JSON.parse(provider.models_json)
                const model = models.find((m: any) => m.id === config.model_id)
                if (model) {
                  modelName = model.model
                }
              } catch {}
            }
            if (!modelName) {
              modelName = provider.embedding_model || 'text-embedding-3-small'
            }
            return { providerId: config.provider_id, modelName }
          }
        }
      }
    } catch {}

    // 2. 回退到默认 Embedding 配置
    return llmClient.getDefaultEmbeddingConfig()
  }

  /**
   * 根据 providerId 获取其默认 model_id
   */
  private getModelIdByProvider(providerId: string): string | undefined {
    const row = this.mainDb.getDb().prepare(
      'SELECT model, models_json FROM llm_providers WHERE id = ?'
    ).get(providerId) as any
    if (!row) return undefined
    if (row.models_json) {
      try {
        const models = JSON.parse(row.models_json)
        if (Array.isArray(models) && models.length > 0 && models[0].id) {
          return models[0].id
        }
      } catch {}
    }
    return row.model || undefined
  }

  /**
   * 获取文件清单（文件名、路径、轻量摘要）—— 用于LLM判断哪些文件可能相关
   */
  private getFileInventory(dirIds?: string[]): Array<{ fileId: string; fileName: string; filePath: string; fileExt: string; lightSummary: string }> {
    try {
      let sql = `
        SELECT f.id as file_id, f.file_name, f.file_path, f.file_ext,
               COALESCE(s.light_summary, '') as light_summary,
               COALESCE(s.summary, '') as summary
        FROM kms_files f
        LEFT JOIN kms_file_summaries s ON s.file_id = f.id
        WHERE f.index_status = 'completed'
      `
      const params: any[] = []
      if (dirIds && dirIds.length > 0) {
        const placeholders = dirIds.map(() => '?').join(',')
        sql += ` AND f.dir_id IN (${placeholders})`
        params.push(...dirIds)
      }
      sql += ` ORDER BY f.file_name LIMIT 200`

      const rows = this.db.prepare(sql).all(...params) as any[]
      return rows.map(r => ({
        fileId: r.file_id,
        fileName: r.file_name,
        filePath: r.file_path,
        fileExt: r.file_ext || '',
        lightSummary: r.summary || r.light_summary || '',
      }))
    } catch (err) {
      logger.warn('Failed to get file inventory:', err)
      return []
    }
  }

  /**
   * 获取目录摘要
   */
  private getDirSummaries(dirIds?: string[]): Array<{ dirPath: string; summary: string; fileCount: number }> {
    try {
      let sql = 'SELECT dir_path, summary, file_count FROM kms_dir_summaries'
      const params: any[] = []
      if (dirIds && dirIds.length > 0) {
        const placeholders = dirIds.map(() => '?').join(',')
        sql += ` WHERE dir_id IN (${placeholders})`
        params.push(...dirIds)
      }
      const rows = this.db.prepare(sql).all(...params) as any[]
      return rows.map(r => ({
        dirPath: r.dir_path,
        summary: r.summary,
        fileCount: r.file_count,
      }))
    } catch {
      return []
    }
  }

  /**
   * 识别查询类型
   */
  private async identifyQueryType(
    query: string,
    llmClient: LLMClientService,
    providerId: string,
    modelId: string | undefined,
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
      ], { temperature: 0, max_tokens: 20, model: modelId, signal, logSource: 'kms_agent_classify' })

      const type = result.trim().toLowerCase()
      if (['locate', 'concept', 'trend', 'analysis'].includes(type)) {
        return type as QueryType
      }
    } catch (err) {
      logger.warn('Failed to identify query type:', err)
    }

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
   * 规划检索路径（结合文件清单和目录摘要）
   * LLM 基于文件名/路径/轻量摘要判断哪些文件可能包含相关信息
   */
  private async planSearchPath(
    query: string,
    queryType: QueryType,
    fileInventory: Array<{ fileId: string; fileName: string; filePath: string; fileExt: string; lightSummary: string }>,
    dirSummaries: Array<{ dirPath: string; summary: string; fileCount: number }>,
    llmClient: LLMClientService,
    providerId: string,
    modelId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ queries: string[]; useSemanticForAll: boolean; candidateFileIds: string[] }> {
    const typeStrategy: Record<QueryType, string> = {
      locate: '提取核心实体名、术语、关键标识符进行精确搜索',
      concept: '提取概念名称和定义关键词，先搜概念再搜上下文',
      trend: '提取主题词和时间相关关键词，关注历史与最新数据',
      analysis: '提取多角度关键词，覆盖不同方面的核心术语',
    }

    // 构建文件清单文本（限制数量避免token过多）
    const maxFiles = 50
    const fileListText = fileInventory.slice(0, maxFiles).map((f, i) => {
      const summary = f.lightSummary ? ` | 摘要: ${f.lightSummary.substring(0, 60)}` : ''
      return `${i + 1}. ${f.fileName} (${f.fileExt})${summary}`
    }).join('\n')

    // 构建目录摘要文本
    const dirSummaryText = dirSummaries.map(d =>
      `目录: ${d.dirPath} (${d.fileCount}个文件)\n摘要: ${d.summary}`
    ).join('\n\n')

    const prompt = `你是一个搜索引擎查询规划器。参考主流搜索引擎的做法，将用户的自然语言问题转化为适合全文检索的关键词查询。

用户问题：${query}
查询类型：${queryType}（${QUERY_TYPE_LABELS[queryType]}）
检索策略：${typeStrategy[queryType]}

${dirSummaryText ? `目录摘要：\n${dirSummaryText}\n\n` : ''}可用文件清单：
${fileListText || '（无文件清单）'}

【关键词提取规则】（参考搜索引擎做法）：
1. 从用户问题中提取核心关键词（实体名、术语、专有名词、关键动词/名词），去掉"如何、怎么、什么、为什么、的、了、吗、呢、在、是"等无意义词
2. 每个关键词用空格分隔，形成关键词组合，例如：用户问"如何配置数据库连接" → 关键词 "配置 数据库 连接"
3. 中文关键词保持2-4个字符的粒度，不要整句作为关键词
4. 生成 1-3 组关键词查询：
   - 第1组：最核心的关键词（从原问题提取）
   - 第2组：同义词或相关术语扩展（如"配置"→"设置"，"数据库"→"DB"）
   - 第3组：不同角度的补充关键词
5. 每组关键词不超过 5 个词，总长度不超过 30 字符
6. 基于文件名和摘要，判断哪些文件可能包含相关信息，列出候选文件序号（1-based）

返回 JSON 格式：
{"queries": ["关键词1 关键词2 关键词3", "同义词1 同义词2", "补充词1 补充词2"], "use_semantic_for_all": false, "candidate_file_indices": [1, 3]}

示例：
- 用户问"项目部署流程是什么" → {"queries": ["部署 流程", "部署 步骤", "发布 上线"], ...}
- 用户问"数据库连接池配置" → {"queries": ["数据库 连接池 配置", "连接池 设置", "DB pool"], ...}
- 用户问"用户登录失败怎么排查" → {"queries": ["登录 失败 排查", "登录 错误 日志", "登录 问题 诊断"], ...}`

    try {
      const result = await llmClient.chat(providerId, [
        { role: 'system', content: '你是一个搜索引擎查询规划器，只返回JSON。' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, max_tokens: 400, model: modelId, signal, logSource: 'kms_agent_plan' })

      const parsed = JSON.parse(result)
      const queries = Array.isArray(parsed.queries) && parsed.queries.length > 0
        ? parsed.queries.slice(0, 3).map((q: any) => String(q).trim()).filter(Boolean)
        : [query]

      // 将候选文件序号转换为文件ID
      const candidateFileIds: string[] = []
      if (Array.isArray(parsed.candidate_file_indices)) {
        for (const idx of parsed.candidate_file_indices) {
          const i = Number(idx) - 1
          if (i >= 0 && i < fileInventory.length) {
            candidateFileIds.push(fileInventory[i].fileId)
          }
        }
      }

      return {
        queries,
        useSemanticForAll: Boolean(parsed.use_semantic_for_all),
        candidateFileIds,
      }
    } catch (err) {
      logger.warn('Failed to plan search path:', err)
    }

    // 降级：直接使用原始查询
    return { queries: [query], useSemanticForAll: false, candidateFileIds: [] }
  }

  /**
   * 选择需要读取片段的文件
   * 综合考虑：搜索结果中的文件 + LLM规划的候选文件
   */
  private selectFilesToRead(
    searchResults: SearchResult[],
    candidateFileIds: string[],
    resultsInsufficient: boolean
  ): Array<{ fileId: string; fileName: string }> {
    const fileMap = new Map<string, string>() // fileId -> fileName

    // 如果搜索结果不足，读取搜索结果中的文件
    if (resultsInsufficient) {
      for (const r of searchResults.slice(0, 3)) {
        if (r.file_id && r.file_name) {
          fileMap.set(r.file_id, r.file_name)
        }
      }
    }

    // 添加LLM规划的候选文件
    for (const fileId of candidateFileIds.slice(0, 3)) {
      if (!fileMap.has(fileId)) {
        const file = this.db.prepare('SELECT file_name FROM kms_files WHERE id = ?').get(fileId) as any
        if (file) {
          fileMap.set(fileId, file.file_name)
        }
      }
    }

    return Array.from(fileMap.entries()).map(([fileId, fileName]) => ({ fileId, fileName }))
  }

  /**
   * 读取文件分片（不直接读取全文，分片慢慢读取）
   */
  private async readFileChunk(fileId: string, startOffset: number, maxChars: number): Promise<string> {
    try {
      const file = this.db.prepare('SELECT file_path FROM kms_files WHERE id = ?').get(fileId) as any
      if (!file) return ''

      const FileParserService = require('../file-parser.service').default
      const parseResult = await FileParserService.getInstance().parseFilePath(file.file_path)
      const content = parseResult.fullText || ''
      return content.substring(startOffset, startOffset + maxChars)
    } catch (err) {
      logger.warn(`Failed to read chunk from file ${fileId}:`, err)
      return ''
    }
  }

  /**
   * 筛选提纯结果
   */
  private async distillResults(
    query: string,
    queryType: QueryType,
    results: SearchResult[],
    supplementaryContent: string,
    llmClient: LLMClientService,
    providerId: string,
    modelId: string | undefined,
    signal?: AbortSignal
  ): Promise<{ conclusion: string; sources: AgentSearchSource[] }> {
    if (results.length === 0 && !supplementaryContent) {
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

    const supplementarySection = supplementaryContent
      ? `\n\n补充读取的文件内容：\n${supplementaryContent.substring(0, 3000)}`
      : ''

    const prompt = `你是一个内容提纯助手。基于检索结果，针对用户查询生成核心结论。

用户查询：${query}
查询类型：${queryType}（${QUERY_TYPE_LABELS[queryType]}）

检索结果：
${resultsText || '（无搜索结果）'}${supplementarySection}

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
      ], { temperature: 0.2, max_tokens: 800, model: modelId, signal, logSource: 'kms_agent_distill' })

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
