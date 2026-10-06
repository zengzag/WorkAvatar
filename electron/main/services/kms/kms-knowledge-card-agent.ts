import { PiAIProvider } from '../agent/llm/pi-ai-provider'
import { ToolRegistry } from '../agent/tools/tool-registry'
import { ToolDispatcher } from '../agent/tools/tool-dispatcher'
import { createKMSTools, type SearchScopeRef } from '../agent/tools/kms-search.tool'
import { getKmsSummaryLLMConfig } from './kms-config-helpers'
import type { KmsLLMConfig } from './kms-config-helpers'
import LLMClientService from '../llm-client.service'
import type { LLMMessage } from '../agent/llm/types'
import type { SearchTraceStep } from './kms-search-agent-types'
import { parseJSON } from './kms-paragraph-processor'
import { createLogger } from '../logger'

const logger = createLogger('KMS-UnifiedAgent')

const MAX_ITERATIONS = 30

/** 稳定的系统提示词——search 和 card 模式共用，不随模式变化，利于 prompt cache 命中 */
const UNIFIED_SYSTEM_PROMPT = `You are an intelligent retrieval and knowledge-synthesis assistant for a local knowledge base.

You can use the following tools to gather information:
- kms_search: search the local knowledge base (supports keyword and semantic retrieval; results are automatically enriched with knowledge cards and collection summaries)
- kms_get_content: read the full text of a file (obtain the file_id via kms_search first)

Working principles:
1. Start with a direct keyword search, then decide from the results whether to dig deeper.
2. Selectively read the full text of important files to get more detail.
3. Call kms_search multiple times to search from different angles when needed.
4. When you have enough information, produce the final result in the required format.
5. Cite sources with [n] markers in your conclusions/summaries.
6. If the available information cannot fully answer the question, explicitly state what is missing; never fabricate.
7. Always write the final output in the same language as the retrieved source material. If the sources are not in English, do not translate them into English — keep the original language.`

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
  /** card 模式：用户补充的生成要求，用于引导内容生成方向 */
  requirement?: string
  /** 检索范围限制 */
  collectionIds?: string[]
  dirIds?: string[]
  fileExtensions?: string[]
}

/** 构建模式相关的初始用户消息（输出格式指令放在 user 消息中，保持 system prompt 稳定） */
function buildInitialUserMessage(query: string, mode: AgentMode, requirement?: string): string {
  if (mode === 'card') {
    const userRequirement = requirement && requirement.trim()
      ? `\n\nAdditional user requirements:\n${requirement.trim()}\n\nOrganize the card content strictly according to the additional requirements above.`
      : ''
    return `Based on the retrieval results from the local knowledge base, generate a high-quality knowledge card for the keyword "${query}".

Synthesize strictly from the real content retrieved via kms_search / kms_get_content; do not fabricate information that does not exist in the sources.${userRequirement}

Write the summary in the same language as the retrieved source material. If the sources are not in English, do not translate them into English — keep the original language.

Output format (plain JSON only, no other content, and do not wrap it in a markdown code block):
{"summary": "a complete and well-structured synthesis"}

The summary should be about 200-500 words and include:
- Background and definition: what the topic is and which materials it covers
- Key points: critical information, conclusions, and methods, organized into structured sections
- Source citations: add [n] markers after the relevant sentences; number sources in the order they appear in the retrieval results starting from 1, counting each file only once
- Completeness note: if the materials do not fully cover the topic, explicitly state what is missing

Notes:
- For the first search, use the keyword "${query}" directly; afterwards decide from the results whether to dig deeper or search from another angle.
- The summary is a synthesis of the retrieved content, not an enumeration of the original text, and it must not open with phrases like "based on the retrieval results".
- Do not output extra fields such as "key points"; summary is the single, sufficient field.`
  }

  return `Retrieve information for the query below and produce the core conclusion.

Query: ${query}

Output requirements:
1. Output the conclusion directly and cite sources with [n] markers.
2. Keep the conclusion concise and clear; do not pile up original text; no more than 500 words.
3. If the information is insufficient to answer, clearly state what is missing.
4. Do not add opening phrases like "based on the retrieval results".
5. For the first search, use the keywords from the query directly; afterwards you may search deeper based on the results.
6. Write the conclusion in the same language as the retrieved source material. If the sources are not in English, do not translate them into English — keep the original language.`
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

  const provider = new PiAIProvider({
    model: llmConfig.modelId || providerConfig.model,
    apiKey: providerConfig.api_key,
    baseUrl: providerConfig.base_url,
    providerType: providerConfig.provider_type,
    defaultOptions: {
      enableThinking: llmConfig.enableThinking ? 'high' : false,
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
  // KMS 工具定义默认 onDemand（员工侧经 list_available_tools 按需发现），
  // 本循环必须常驻 tools schema 供 LLM 直接调用，否则 LLM 无工具可调、引用为空
  registry.registerTools(tools.map(t => ({ ...t, onDemand: false })))
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
    { role: 'user', content: buildInitialUserMessage(query, options.mode, options.requirement) },
  ]

  const maxIters = Math.min(options.maxIterations || MAX_ITERATIONS, MAX_ITERATIONS)
  addStep({
    phase: options.mode === 'card' ? 'card' : 'search',
    action: '启动 Agent 循环',
    actionKey: 'kms.knowledgeCards.trace.startLoop',
    type: 'plan',
    detail: `关键词: ${query}, 最大 ${maxIters} 轮`,
    detailKey: 'kms.knowledgeCards.trace.startLoopDetail',
    detailParams: { query, rounds: maxIters },
  })

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
        content: '⚠️ This is your last chance to call tools. You will not be able to call tools in the next round, so make sure you can produce the final content after this call.',
      })
    }

    const t0 = Date.now()
    let response
    try {
      response = await provider.chat(messages, toolsForThisRound, {
        enableThinking: llmConfig.enableThinking ? 'high' : false,
        providerType: providerConfig.provider_type,
      })
    } catch (err: any) {
      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: `LLM 调用失败 (第${i + 1}轮)`,
        actionKey: 'kms.knowledgeCards.trace.llmFailed',
        actionParams: { round: i + 1 },
        type: 'llm',
        detail: err?.message || String(err),
        durationMs: Date.now() - t0,
      })
      return { success: false, error: `LLM_CALL_FAILED: ${err?.message || err}` }
    }

    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.toolCalls,
    })

    // 展示本次 LLM 的思考内容，便于排查其检索/调用意图
    if (response.reasoningContent) {
      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: 'LLM 思考',
        actionKey: 'kms.knowledgeCards.trace.llmThinking',
        type: 'info',
        detail: truncateText(response.reasoningContent, 400),
      })
    }

    // 兜底：思考模型不原生支持函数调用时，会以 XML 文本输出工具调用，解析后作为真实调用执行。
    // 注意扫描 content 与 reasoningContent 两处：DeepSeek 思考模型常把工具调用计划写在思考内容中，
    // 而 content 直接是最终摘要，若不扫描思考内容会漏掉本次检索，导致 0 引用文件。
    let roundCalls = response.toolCalls
    let callsFromXml = false
    if (!roundCalls || roundCalls.length === 0) {
      const xmlCalls = extractXmlToolCalls(`${response.content || ''}\n${response.reasoningContent || ''}`)
      if (xmlCalls.length > 0) {
        roundCalls = xmlCalls.map((c, idx) => ({
          id: `call_${i}_${idx}`,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        }))
        callsFromXml = true
      }
    }

    if (!roundCalls || roundCalls.length === 0) {
      finalContent = response.content || ''
      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: 'LLM 生成完成',
        actionKey: 'kms.knowledgeCards.trace.llmGenerated',
        type: 'result',
        detail: `${finalContent.length} 字符`,
        detailKey: 'kms.knowledgeCards.trace.chars',
        detailParams: { count: finalContent.length },
        durationMs: Date.now() - t0,
      })
      break
    }

    addStep({
      phase: options.mode === 'card' ? 'card' : 'search',
      action: `LLM 第 ${i + 1} 轮`,
      actionKey: 'kms.knowledgeCards.trace.llmRound',
      actionParams: { round: i + 1 },
      type: 'llm',
      detail: `${roundCalls.length} 个工具调用${callsFromXml ? '（XML文本形式）' : ''}`,
      detailKey: callsFromXml ? 'kms.knowledgeCards.trace.toolCallsXml' : 'kms.knowledgeCards.trace.toolCalls',
      detailParams: { count: roundCalls.length },
      durationMs: Date.now() - t0,
    })

    for (const tc of roundCalls) {
      if (options.signal?.aborted) return { success: false, error: 'ABORTED' }

      const toolName = tc.function.name
      let args: any
      try { args = JSON.parse(tc.function.arguments) } catch { args = {} }

      const toolType: SearchTraceStep['type'] = toolName === 'kms_search' ? 'search' : toolName === 'kms_get_content' ? 'read' : 'info'
      const argsDesc = toolName === 'kms_search' ? `keyword="${(args.keyword ?? args.query) || ''}"` : toolName === 'kms_get_content' ? `file_id=${args.file_id || ''}` : `query="${args.query || ''}"`
      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: `调用 ${toolName}`,
        actionKey: 'kms.knowledgeCards.trace.toolCall',
        actionParams: { name: toolName },
        type: toolType,
        detail: argsDesc,
      })

      const toolStart = Date.now()
      const result = await dispatcher.dispatch(toolName, args)

      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: `${toolName} 结果`,
        actionKey: 'kms.knowledgeCards.trace.toolResult',
        actionParams: { name: toolName },
        type: toolType,
        detail: result.success ? truncateText(result.output, 400) : `失败: ${result.error}`,
        detailKey: result.success ? undefined : 'kms.knowledgeCards.trace.toolFailed',
        detailParams: result.success ? undefined : { error: result.error || '' },
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
      addStep({
        phase: options.mode === 'card' ? 'card' : 'search',
        action: 'Agent 循环结束',
        actionKey: 'kms.knowledgeCards.trace.loopEnded',
        type: 'info',
        detail: `达到最大轮次 ${maxIters} 且无最终输出`,
        detailKey: 'kms.knowledgeCards.trace.maxRoundsReached',
        detailParams: { rounds: maxIters },
      })
      return { success: false, error: 'MAX_ITERATIONS_REACHED' }
    }
    addStep({
      phase: options.mode === 'card' ? 'card' : 'search',
      action: '从历史消息中提取内容',
      actionKey: 'kms.knowledgeCards.trace.extractFromHistory',
      type: 'info',
      detail: `${finalContent.length} 字符`,
      detailKey: 'kms.knowledgeCards.trace.chars',
      detailParams: { count: finalContent.length },
    })
  }

  addStep({
    phase: options.mode === 'card' ? 'card' : 'search',
    action: '解析完成',
    actionKey: 'kms.knowledgeCards.trace.completed',
    type: 'result',
    detail: `${finalContent.length} 字符, ${accessedFiles.length} 个引用文件, ${iterations} 轮迭代`,
    detailKey: 'kms.knowledgeCards.trace.completedDetail',
    detailParams: { chars: finalContent.length, files: accessedFiles.length, iterations },
  })

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

/** 截断文本用于流程展示：压缩空白、超出最大长度加省略号 */
function truncateText(text: string, max = 400): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 兜底：部分思考模型（如 DeepSeek R1）不原生支持函数调用，会把工具调用作为
 * XML 文本输出，例如 `<tool_calls><invoke name="kms_search"><parameter name="keyword">报告模板</parameter></invoke></tool_calls>`。
 * 此处解析该文本形式，转成可分派的结构化工具调用。
 */
function extractXmlToolCalls(content: string): Array<{ name: string; arguments: string }> {
  const calls: Array<{ name: string; arguments: string }> = []
  const invokeRe = /<invoke\s+name=["']([^"'\s>]+)["']([\s\S]*?)<\/invoke>/gi
  let m: RegExpExecArray | null
  while ((m = invokeRe.exec(content))) {
    const name = m[1]
    const body = m[2] || ''
    const args: Record<string, string> = {}
    // 内嵌形式：<parameter name="keyword">值</parameter>
    const pRe = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi
    let pm: RegExpExecArray | null
    while ((pm = pRe.exec(body))) {
      args[pm[1]] = pm[2].trim()
    }
    // 属性形式：<invoke name="x" keyword="值">
    const attrRe = /([a-zA-Z_][\w]*)\s*=\s*["']([^"']*)["']/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(body))) {
      if (!(am[1] in args)) args[am[1]] = am[2]
    }
    calls.push({ name, arguments: JSON.stringify(args) })
  }
  return calls
}

export interface CardAgentResult {
  summary: string
  accessedFiles: AccessedFile[]
  iterations: number
  /** Agent Loop 完整执行轨迹（搜索/读取/LLM 各步骤），用于事后排查生成流程 */
  steps: SearchTraceStep[]
}

/** 知识卡片生成的向后兼容包装 */
export async function generateCardViaAgentLoop(
  displayKeyword: string,
  onProgress?: (step: SearchTraceStep) => void,
  signal?: AbortSignal,
  requirement?: string,
): Promise<{ success: boolean; result?: CardAgentResult; error?: string }> {
  const llmConfig = getKmsSummaryLLMConfig()
  if (!llmConfig) return { success: false, error: 'NO_LLM_PROVIDER' }

  const agentResult = await runUnifiedAgentLoop(displayKeyword, llmConfig, {
    mode: 'card',
    signal,
    onProgress,
    requirement,
  })

  if (!agentResult.success || !agentResult.result) {
    return { success: false, error: agentResult.error }
  }

  // 解析 JSON 输出：复用 KMS 通用容错解析（剥离代码围栏 + 修复字符串内换行）
  const content = agentResult.result.content || ''
  const parsed = parseJSON<{ summary?: unknown }>(content, {})
  let summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!summary) summary = extractSummaryValue(content)

  if (!summary) {
    return { success: false, error: 'LLM_GENERATION_FAILED' }
  }

  return {
    success: true,
    result: {
      summary,
      accessedFiles: agentResult.result.accessedFiles,
      iterations: agentResult.result.iterations,
      steps: agentResult.result.steps,
    },
  }
}

/** 从解析失败的 LLM 输出中提取 summary 字段值；非 JSON 的纯文本原样返回 */
function extractSummaryValue(content: string): string {
  const text = content.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim()
  const match = text.match(/"summary"\s*:\s*"([\s\S]*)/)
  if (!match) return text.startsWith('{') ? '' : text
  return match[1]
    .replace(/"\s*[}\]]*\s*$/, '')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .trim()
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
