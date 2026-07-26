import { OpenAIProvider } from '../agent/llm/openai-provider'
import { ToolRegistry } from '../agent/tools/tool-registry'
import { ToolDispatcher } from '../agent/tools/tool-dispatcher'
import { createKMSTools, type SearchScopeRef } from '../agent/tools/kms-search.tool'
import { getKmsSummaryLLMConfig } from './kms-config-helpers'
import type { KmsLLMConfig } from './kms-config-helpers'
import LLMClientService from '../llm-client.service'
import type { LLMMessage } from '../agent/llm/types'
import type { SearchTraceStep } from './kms-search-agent-types'
import { createLogger } from '../logger'

const logger = createLogger('KMS-UnifiedAgent')

const MAX_ITERATIONS = 30

/** 稳定的系统提示词——search 和 card 模式共用，不随模式变化，利于 prompt cache 命中 */
const UNIFIED_SYSTEM_PROMPT = `你是一个资料库智能检索与知识整合助手。

你可以使用以下工具获取信息：
- kms_search: 搜索本地资料库（支持关键词和语义检索，结果自动附加知识卡片与合集摘要）
- kms_get_content: 读取文件正文（需先通过 kms_search 获取 file_id）

工作原则：
1. 先用关键词直接搜索，根据结果决定是否需要深入
2. 选择性地读取重要文件正文以获取更详细信息
3. 如需从不同角度搜索，可多次调用 kms_search
4. 当信息充分后，按照指定格式输出最终结果
5. 在结论/摘要中用 [序号] 标注信息来源
6. 如果信息不足以完整回答，明确指出缺失方向，不要编造`

export type AgentMode = 'search' | 'card'

export interface AccessedFile {
  fileId: string
  fileName: string
  filePath: string
  snippet: string
  paragraphId?: string
  paragraphTitle?: string
  startLine?: number
  endLine?: number
}

export interface KnowledgeCardKeyPoint {
  point: string
  sourceIndex: number
}

export interface KnowledgeCardCitation {
  fileId: string
  fileName: string
  filePath: string
  paragraphId?: string
  paragraphTitle?: string
  snippet: string
  startLine?: number
  endLine?: number
}

export interface UnifiedAgentResult {
  /** 最终输出内容（search 模式为结论文本，card 模式为 JSON 字符串） */
  content: string
  accessedFiles: AccessedFile[]
  iterations: number
  steps: SearchTraceStep[]
}

export interface UnifiedAgentOptions {
  mode: AgentMode
  signal?: AbortSignal
  onProgress?: (step: SearchTraceStep) => void
  maxIterations?: number
  /** card 模式：关键词累计搜索次数 */
  searchCount?: number
  /** 检索范围限制 */
  collectionIds?: string[]
  dirIds?: string[]
  fileExtensions?: string[]
}

/** 构建模式相关的初始用户消息（输出格式指令放在 user 消息中，保持 system prompt 稳定） */
function buildInitialUserMessage(query: string, mode: AgentMode, searchCount?: number): string {
  if (mode === 'card') {
    return `请为关键词「${query}」生成知识卡片。该关键词已被搜索 ${searchCount || 0} 次。

输出格式（纯JSON，不要包含其他内容、不要用 markdown 代码块包裹）：
{"summary": "深入的综合摘要，整合多源信息，包含背景、核心内容、关键细节等（500-1200字）", "keyPoints": [{"point": "要点描述", "sourceIndex": 0}]}

sourceIndex 对应你使用的文件来源序号（从0开始），按你在搜索结果中遇到的文件顺序编号，同一文件只算一个序号。

注意：
- 首轮搜索请直接使用关键词本身"${query}"，之后再逐渐深入
- summary 应深入整合多源信息，不要简单罗列
- 如果多个来源的信息有矛盾或差异，指出并分析可能原因
- 如果信息不足以完整回答，明确指出缺失方向
- keyPoints 每条都要标注 sourceIndex`
  }

  return `请针对以下查询进行检索并生成核心结论。

查询：${query}

输出要求：
1. 直接输出结论，用 [序号] 标注信息来源
2. 结论简洁明了，不要堆砌原文，不超过 500 字
3. 如果信息不足以回答，明确说明缺失的内容
4. 不要添加"根据检索结果"等开场白
5. 首轮搜索请直接使用查询中的关键词，之后可根据结果深入搜索`
}

/**
 * 统一增量式 Agent Loop
 *
 * search 和 card 模式共用同一 system prompt（稳定前缀，利于 prompt cache），
 * 消息在多轮迭代中累积追加（前缀不变、尾部追加），最大化 cache 命中率。
 * 两种模式仅在初始 user 消息的输出格式指令上不同。
 */
export async function runUnifiedAgentLoop(
  query: string,
  llmConfig: KmsLLMConfig,
  options: UnifiedAgentOptions,
): Promise<{ success: boolean; result?: UnifiedAgentResult; error?: string }> {
  const llmClient = LLMClientService.getInstance()
  const providerConfig = await llmClient.getProviderConfig(llmConfig.providerId)
  if (!providerConfig) return { success: false, error: 'NO_LLM_PROVIDER' }

  const provider = new OpenAIProvider({
    model: llmConfig.modelId || providerConfig.model,
    apiKey: providerConfig.api_key,
    baseUrl: providerConfig.base_url,
    providerType: providerConfig.provider_type,
    defaultOptions: {
      enableThinking: llmConfig.enableThinking,
      providerType: providerConfig.provider_type,
    },
  })

  // 搜索范围 ref（工具内读取默认范围）
  const scopeRef: SearchScopeRef = {
    current: {
      collectionIds: options.collectionIds || [],
      dirIds: options.dirIds,
      fileExtensions: options.fileExtensions,
    },
  }

  const tools = createKMSTools(scopeRef)
  const registry = new ToolRegistry()
  registry.registerTools(tools)
  const dispatcher = new ToolDispatcher(registry)
  const openaiTools = registry.getOpenAISchemas()

  const accessedFiles: AccessedFile[] = []
  const accessedFileMap = new Map<string, AccessedFile>()
  const steps: SearchTraceStep[] = []
  const addStep = (step: SearchTraceStep) => {
    steps.push(step)
    options.onProgress?.(step)
  }

  // 累积 messages 数组：system prompt 为稳定前缀，后续消息逐步追加
  const messages: LLMMessage[] = [
    { role: 'system', content: UNIFIED_SYSTEM_PROMPT },
    { role: 'user', content: buildInitialUserMessage(query, options.mode, options.searchCount) },
  ]

  const maxIters = Math.min(options.maxIterations || MAX_ITERATIONS, MAX_ITERATIONS)
  addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: '启动 Agent 循环', type: 'plan', detail: `关键词: ${query}, 最大 ${maxIters} 轮` })

  let iterations = 0
  let finalContent = ''

  for (let i = 0; i < maxIters; i++) {
    if (options.signal?.aborted) return { success: false, error: 'ABORTED' }
    iterations++

    const isLastIteration = i === maxIters - 1
    const toolsForThisRound = isLastIteration ? undefined : openaiTools

    if (i === maxIters - 2) {
      messages.push({
        role: 'user',
        content: '⚠️ 这是你最后可以调用工具的机会。下一轮将无法再调用工具，请确保本次调用后你能输出最终内容。',
      })
    }

    const t0 = Date.now()
    let response
    try {
      response = await provider.chat(messages, toolsForThisRound, {
        enableThinking: llmConfig.enableThinking,
        providerType: providerConfig.provider_type,
      })
    } catch (err: any) {
      addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: `LLM 调用失败 (第${i + 1}轮)`, type: 'llm', detail: err?.message || String(err), durationMs: Date.now() - t0 })
      return { success: false, error: `LLM_CALL_FAILED: ${err?.message || err}` }
    }

    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls,
    })

    if (!response.toolCalls || response.toolCalls.length === 0) {
      finalContent = response.content || ''
      addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: 'LLM 生成完成', type: 'result', detail: `${finalContent.length} 字符`, durationMs: Date.now() - t0 })
      break
    }

    addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: `LLM 第 ${i + 1} 轮`, type: 'llm', detail: `${response.toolCalls.length} 个工具调用`, durationMs: Date.now() - t0 })

    for (const tc of response.toolCalls) {
      if (options.signal?.aborted) return { success: false, error: 'ABORTED' }

      const toolName = tc.function.name
      let args: any
      try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

      const toolType: SearchTraceStep['type'] = toolName === 'kms_search' ? 'search' : toolName === 'kms_get_content' ? 'read' : 'info'
      const argsDesc = toolName === 'kms_search' ? `query="${args.query || ''}", search_mode=${args.search_mode || 'keyword'}` : toolName === 'kms_get_content' ? `file_id=${args.file_id || ''}` : `query="${args.query || ''}"`
      addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: `调用 ${toolName}`, type: toolType, detail: argsDesc })

      const toolStart = Date.now()
      const result = await dispatcher.dispatch(toolName, args)

      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: `${toolName} 结果`,
        type: toolType,
        detail: result.success ? `${(result.output || '').length} 字符` : `失败: ${result.error}`,
        durationMs: Date.now() - toolStart,
      })

      if (toolName === 'kms_search' && result.success) {
        trackFilesFromSearchOutput(result.output || '', accessedFiles, accessedFileMap)
      }

      messages.push({
        role: 'tool',
        content: result.success ? (result.output || '') : (result.error || 'Tool failed'),
        tool_call_id: tc.id,
      })
    }
  }

  if (!finalContent) {
    const lastAssistant = messages.filter(m => m.role === 'assistant').pop()
    const rawContent = lastAssistant?.content
    finalContent = typeof rawContent === 'string' ? rawContent : ''
    if (!finalContent) {
      addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: 'Agent 循环结束', type: 'info', detail: `达到最大轮次 ${maxIters} 且无最终输出` })
      return { success: false, error: 'MAX_ITERATIONS_REACHED' }
    }
    addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: '从历史消息中提取内容', type: 'info', detail: `${finalContent.length} 字符` })
  }

  addStep({ phase: options.mode === 'card' ? 'card' : 'search', action: '解析完成', type: 'result', detail: `${finalContent.length} 字符, ${accessedFiles.length} 个引用文件, ${iterations} 轮迭代` })

  logger.info(`Unified agent loop completed for "${query}" (mode=${options.mode}): ${iterations} iterations, ${accessedFiles.length} files accessed, ${finalContent.length} chars`)

  return {
    success: true,
    result: {
      content: finalContent,
      accessedFiles,
      iterations,
      steps,
    },
  }
}

// === 向后兼容：知识卡片专用接口 ===

export interface CardAgentResult {
  summary: string
  keyPoints: { point: string; sourceIndex: number }[]
  accessedFiles: AccessedFile[]
  iterations: number
}

/** 知识卡片生成的向后兼容包装 */
export async function generateCardViaAgentLoop(
  displayKeyword: string,
  searchCount: number,
  onProgress?: (step: SearchTraceStep) => void,
  signal?: AbortSignal,
): Promise<{ success: boolean; result?: CardAgentResult; error?: string }> {
  const llmConfig = getKmsSummaryLLMConfig()
  if (!llmConfig) return { success: false, error: 'NO_LLM_PROVIDER' }

  const agentResult = await runUnifiedAgentLoop(displayKeyword, llmConfig, {
    mode: 'card',
    searchCount,
    signal,
    onProgress,
  })

  if (!agentResult.success || !agentResult.result) {
    return { success: false, error: agentResult.error }
  }

  // 解析 JSON 输出
  let parsed: { summary?: string; keyPoints?: { point: string; sourceIndex: number }[] }
  try {
    const jsonMatch = agentResult.result.content.match(/\{[\s\S]*\}/)
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : agentResult.result.content)
  } catch {
    parsed = { summary: agentResult.result.content, keyPoints: [] }
  }

  if (!parsed.summary) {
    return { success: false, error: 'LLM_GENERATION_FAILED' }
  }

  return {
    success: true,
    result: {
      summary: parsed.summary,
      keyPoints: parsed.keyPoints || [],
      accessedFiles: agentResult.result.accessedFiles,
      iterations: agentResult.result.iterations,
    },
  }
}

/** 从 kms_search 的输出中解析文件信息并跟踪 */
function trackFilesFromSearchOutput(output: string, files: AccessedFile[], fileMap: Map<string, AccessedFile>) {
  const lines = output.split('\n')
  let currentFileName = ''
  let currentFilePath = ''
  let currentFileId = ''
  let currentSnippet = ''
  let currentParagraphTitle = ''
  let currentParagraphId = ''
  let currentStartLine: number | undefined
  let currentEndLine: number | undefined

  for (const line of lines) {
    const fileIdMatch = line.match(/^file_id:\s*(.+)$/i)
    if (fileIdMatch) {
      currentFileId = fileIdMatch[1].trim()
    }
    const pathMatch = line.match(/^路径:\s*(.+)$/)
    if (pathMatch) {
      currentFilePath = pathMatch[1].trim()
    }
    const titleMatch = line.match(/^\[\d+\].*?\|\s*(.+?)(?:\s*>\s*(.+))?$/)
    if (titleMatch) {
      currentFileName = titleMatch[1].trim()
      currentParagraphTitle = titleMatch[2]?.trim() || ''
    }
    const pIdMatch = line.match(/^paragraph_id:\s*(.+)$/i)
    if (pIdMatch) {
      currentParagraphId = pIdMatch[1].trim()
    }
    const linesMatch = line.match(/^lines:\s*(\d+)-(\d+)/i)
    if (linesMatch) {
      currentStartLine = parseInt(linesMatch[1], 10)
      currentEndLine = parseInt(linesMatch[2], 10)
    }

    if (currentFileId && !fileMap.has(currentFileId)) {
      const snippetLines = lines.filter(l =>
        !l.match(/^\[\d+\]/) &&
        !l.match(/^路径:/) &&
        !l.match(/^file_id:/i) &&
        !l.match(/^paragraph_id:/i) &&
        !l.match(/^lines:/i) &&
        !l.match(/^offset:/i) &&
        l.trim().length > 0
      )
      currentSnippet = snippetLines.slice(0, 3).join(' ').substring(0, 200)

      const file: AccessedFile = {
        fileId: currentFileId,
        fileName: currentFileName,
        filePath: currentFilePath,
        snippet: currentSnippet,
        paragraphId: currentParagraphId || undefined,
        paragraphTitle: currentParagraphTitle || undefined,
        startLine: currentStartLine,
        endLine: currentEndLine,
      }
      fileMap.set(currentFileId, file)
      files.push(file)
    }
  }
}
