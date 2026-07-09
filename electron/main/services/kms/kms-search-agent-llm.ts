import type LLMClientService from '../llm-client.service'
import { callLLMForJSON } from './kms-llm-helpers'
import { createLogger } from '../logger'
import {
  type QueryType,
  type SearchPlan,
  type DistilledResult,
  type AgentSearchSource,
  type FileInventoryItem,
  type ScopeSummaryItem,
  QUERY_TYPE_LABELS,
} from './kms-search-agent-types'
import type { SearchResult } from './kms-search-engine.service'

const logger = createLogger('KMS-SearchAgent-LLM')

/**
 * 识别查询类型
 * LLM 判断属于 locate/concept/trend/analysis，失败时降级为关键词匹配
 */
export async function identifyQueryType(
  query: string,
  llmClient: LLMClientService,
  providerId: string,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
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
    ], { temperature: 0, max_tokens: 20, model: modelId, signal, logSource: 'kms_agent_classify', enable_thinking: enableThinking })

    const type = result.trim().toLowerCase()
    if (['locate', 'concept', 'trend', 'analysis'].includes(type)) {
      return type as QueryType
    }
  } catch (err) {
    logger.warn('Failed to identify query type:', err)
  }

  return fallbackClassify(query)
}

/** 降级查询类型分类（基于关键词正则匹配） */
export function fallbackClassify(query: string): QueryType {
  const lower = query.toLowerCase()
  if (/在哪|哪里|位置|定位|找出|找到|查找|哪个文件/.test(lower)) return 'locate'
  if (/什么是|是什么|解释|定义|含义|意思/.test(lower)) return 'concept'
  if (/趋势|变化|发展|历程|时间线|演变/.test(lower)) return 'trend'
  if (/总结|分析|对比|汇总|概括|综述/.test(lower)) return 'analysis'
  return 'locate'
}

/**
 * 规划检索路径
 * LLM 基于文件清单和目录摘要生成关键词查询 + 候选文件列表
 */
export async function planSearchPath(
  query: string,
  queryType: QueryType,
  fileInventory: FileInventoryItem[],
  dirSummaries: ScopeSummaryItem[],
  llmClient: LLMClientService,
  providerId: string,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<SearchPlan> {
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
    const parsed = await callLLMForJSON<{
      queries: string[]
      use_semantic_for_all: boolean
      candidate_file_indices: number[]
    }>(
      llmClient,
      providerId,
      modelId,
      [
        { role: 'system', content: '你是一个搜索引擎查询规划器，只返回JSON。' },
        { role: 'user', content: prompt },
      ],
      { queries: [], use_semantic_for_all: false, candidate_file_indices: [] },
      { temperature: 0.1, maxTokens: 400, signal, logSource: 'kms_agent_plan', enable_thinking: enableThinking },
    )

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
 * 筛选提纯结果
 * LLM 从检索结果和补充内容中提取核心结论，并附上精准溯源信息
 */
export async function distillResults(
  query: string,
  queryType: QueryType,
  results: SearchResult[],
  supplementaryContent: string,
  llmClient: LLMClientService,
  providerId: string,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<DistilledResult> {
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
    ], { temperature: 0.2, max_tokens: 800, model: modelId, signal, logSource: 'kms_agent_distill', enable_thinking: enableThinking })

    return { conclusion: conclusion.trim(), sources: buildSources(limitedResults) }
  } catch (err) {
    logger.warn('Failed to distill results:', err)

    // 降级：直接返回原始结果摘要
    const conclusion = limitedResults.map((r, i) =>
      `[${i + 1}] ${r.file_name}${r.paragraph_title ? ` > ${r.paragraph_title}` : ''}: ${r.text.substring(0, 150)}`
    ).join('\n')

    return { conclusion, sources: buildSources(limitedResults) }
  }
}

/** 从检索结果构建溯源信息 */
function buildSources(results: SearchResult[]): AgentSearchSource[] {
  return results.map(r => ({
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
}
