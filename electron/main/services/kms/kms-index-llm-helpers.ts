import type KMSSearchEngineService from './kms-search-engine.service'
import { callLLMForJSON } from './kms-llm-helpers'
import {
  addLineNumbers,
  deduplicateTocEntries,
  validateTocEntries,
  buildTocContext,
  TOC_CHUNK_LINES,
  TOC_OVERLAP_LINES,
  type LLMTocEntry,
  type ValidatedTocEntry,
} from './kms-paragraph-processor'
import type { ProgressCallback } from './kms-index-types'
import { createLogger } from '../logger'

const logger = createLogger('KMS-LLM')

/** 通过 LLM 识别文档中的目录结构 */
export async function callLLMForToc(
  numberedContent: string,
  providerId: string,
  modelId: string | undefined,
  existingTocContext?: string,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<LLMTocEntry[]> {
  const systemPrompt = `你是一个专业的文档结构分析专家。你的任务是分析文档内容，准确识别其中的章节标题、层级关系和位置。

识别规则：
1. 只识别真正的结构性标题，不要把正文中的强调文本、列表项、表格内容误认为标题
2. 标题特征：通常是独立成行的短文本（一般不超过60字），具有概括性
3. 常见标题模式：
   - 编号型："第X章/节/部分"、"1."/"1.1"/"1.1.1"、"一、"/"二、"
   - 无编号型：独立成行的概括性短句，后续跟随详细说明内容
4. level表示层级深度，最大3级：1=最高级（章/部分），2=次级（节），3=最细粒度（小节），不允许超过3级
5. lineNumber必须精确对应内容中的行号标记[L数字]
6. 标题对应的正文内容太少（例如小于50词）时，忽略该标题
7. 如果提供了已识别的上层目录上下文，请参考该上下文来确定当前标题的层级，避免将低层级标题误判为高层级${existingTocContext ? `\n\n已识别的上层目录上下文（供参考）：\n${existingTocContext}` : ''}

输出要求：
- 严格按照JSON格式输出
- 只返回JSON，不要包含任何解释文字
- 如果无法识别任何标题结构，返回{"toc":[]}`

  const userPrompt = `请分析以下文档内容，识别所有章节标题及其位置。

文档内容：
${numberedContent}

返回格式：
{"toc":[{"title":"标题文字","level":1,"lineNumber":5}]}`

  const parsed = await callLLMForJSON<{ toc: LLMTocEntry[] }>(
    providerId,
    modelId,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { toc: [] },
    { temperature: 0.7, signal, logSource: 'knowledge_toc', enable_thinking: enableThinking ? 'high' : false },
  )
  return Array.isArray(parsed.toc) ? parsed.toc : []
}

/** 通过分块方式调用 LLM 识别文档目录结构 */
export async function restoreTocWithLLM(
  text: string,
  providerId: string,
  modelId: string | undefined,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<ValidatedTocEntry[]> {
  const lines = text.split('\n')

  if (lines.length <= TOC_CHUNK_LINES) {
    const numberedContent = addLineNumbers(text)
    const entries = await callLLMForToc(numberedContent, providerId, modelId, undefined, signal, enableThinking)
    return validateTocEntries(text, entries)
  }

  const allEntries: LLMTocEntry[] = []
  let startLine = 0
  let chunkIndex = 0

  let totalChunks = 0
  {
    let s = 0
    while (s < lines.length) {
      totalChunks++
      const e = Math.min(s + TOC_CHUNK_LINES, lines.length)
      if (e >= lines.length) break
      s = e - TOC_OVERLAP_LINES
    }
  }

  while (startLine < lines.length) {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    const endLine = Math.min(startLine + TOC_CHUNK_LINES, lines.length)
    const chunkLines = lines.slice(startLine, endLine)
    const numberedContent = addLineNumbers(chunkLines.join('\n'), startLine + 1)

    const existingTocContext = buildTocContext(allEntries)

    onProgress?.({
      phase: 'toc',
      current: chunkIndex + 1,
      total: totalChunks,
      message: `LLM目录分析: 第${chunkIndex + 1}/${totalChunks}块 (行${startLine + 1}-${endLine})`,
      startedAt: Math.floor(Date.now() / 1000),
    })

    const entries = await callLLMForToc(numberedContent, providerId, modelId, existingTocContext, signal, enableThinking)
    allEntries.push(...entries)

    chunkIndex++
    if (endLine >= lines.length) break
    startLine = endLine - TOC_OVERLAP_LINES
  }

  const deduplicated = deduplicateTocEntries(allEntries)
  return validateTocEntries(text, deduplicated)
}

/** 为段落生成摘要 */
export async function generateParagraphSummary(
  paragraphContent: string,
  paragraphTitle: string,
  providerId: string,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<{ title: string; summary: string; keywords: string[] }> {
  const prompt = `为以下段落生成摘要，JSON格式返回。
段落标题：${paragraphTitle}
段落内容：
${paragraphContent.substring(0, 8000)}

返回字段：
- title: 段落标题
- summary: 摘要（50字以内，简洁精炼）
- keywords: 关键词列表（3-5个）

只返回JSON。`

  return callLLMForJSON<{ title: string; summary: string; keywords: string[] }>(
    providerId,
    modelId,
    [
      { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    { title: paragraphTitle, summary: '', keywords: [] },
    {
      signal,
      logSource: 'knowledge_paragraph_summary',
      throwOnError: true,
      enable_thinking: enableThinking ? 'high' : false,
      errorMessage: (err) => `Paragraph summary generation failed (${paragraphTitle}): ${err instanceof Error ? err.message : 'Unknown error'}`,
    },
  )
}

/** 根据段落摘要生成文档全局摘要 */
export async function generateDocumentSummaryFromParagraphs(
  paragraphSummaries: Array<{ title: string; summary: string; keywords: string[] }>,
  documentTitle: string,
  providerId: string,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
): Promise<{ summary: string; keywords: string[]; mainTopics: string[] }> {
  const summariesText = paragraphSummaries.map((ps, i) =>
    `### 段落${i + 1}: ${ps.title}\n${ps.summary}\n关键词: ${ps.keywords.join(', ')}`
  ).join('\n\n')

  const prompt = `基于段落摘要生成文档全局摘要，JSON格式返回。
文档标题：${documentTitle}
段落摘要：
${summariesText.substring(0, 15000)}

返回字段：
- summary: 全局摘要（150字以内，简洁精炼）
- keywords: 关键词列表（5-8个）
- mainTopics: 主要主题列表（3-5个）

只返回JSON。`

  return callLLMForJSON<{ summary: string; keywords: string[]; mainTopics: string[] }>(
    providerId,
    modelId,
    [
      { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    { summary: '', keywords: [], mainTopics: [] },
    {
      signal,
      logSource: 'knowledge_document_summary',
      throwOnError: true,
      enable_thinking: enableThinking ? 'high' : false,
      errorMessage: (err) => `Document summary generation failed (${documentTitle}): ${err instanceof Error ? err.message : 'Unknown error'}`,
    },
  )
}

/** 更新段落摘要到搜索引擎 */
export function updateParagraphSummaries(
  fileId: string,
  paragraphs: Array<{ title: string; titlePath: string; level: number; paragraphIndex: number; startOffset: number; endOffset: number; content?: string }>,
  savedParagraphs: Array<{ id: string; paragraphIndex: number }>,
  summaries: Array<{ title: string; summary: string; keywords: string[] }>,
  searchEngine: KMSSearchEngineService,
): void {
  const paraById = new Map<number, string>()
  for (const sp of savedParagraphs) paraById.set(sp.paragraphIndex, sp.id)
  const paraByIndex = new Map<number, any>()
  for (const p of paragraphs) paraByIndex.set(p.paragraphIndex, p)

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i]
    if (!summary.summary && summary.keywords.length === 0) continue

    const paraId = paraById.get(i)
    if (!paraId) continue

    searchEngine.updateParagraphSummary(paraId, summary.summary, summary.keywords)

    const p = paraByIndex.get(i)
    if (p) {
      searchEngine.indexParagraph(
        fileId,
        paraId,
        p.title,
        p.titlePath,
        summary.summary,
        summary.keywords,
        p.startOffset,
        p.endOffset
      )
    }
  }
}

/** 为文件生成摘要（LLM 调用 + 索引更新） */
export async function generateFileSummary(
  fileId: string,
  fullText: string,
  providerId: string,
  modelId: string | undefined,
  searchEngine: KMSSearchEngineService,
  signal: AbortSignal | undefined,
  enableThinking: boolean | undefined,
  onSaveSummary: (fileId: string, summary: string, keywords: string[], mainTopics: string[]) => void,
): Promise<void> {
  if (!modelId) {
    throw new Error('MODEL_NOT_CONFIGURED')
  }
  const truncatedText = fullText.substring(0, 3000)
  const summaryPrompt = `请为以下文档内容生成简洁摘要（150字以内），并提取5-8个关键词和3-5个主要主题。\n\n文档内容：\n${truncatedText}\n\n请以JSON格式返回：{"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

  if (signal?.aborted) return

  const parsed = await callLLMForJSON<{ summary: string; keywords: string[]; main_topics: string[] }>(
    providerId,
    modelId,
    [
      { role: 'system', content: '你是一个文档摘要助手。请严格按照JSON格式返回结果。' },
      { role: 'user', content: summaryPrompt },
    ],
    { summary: '', keywords: [], main_topics: [] },
    { temperature: 0.7, maxTokens: 500, signal, enable_thinking: enableThinking ? 'high' : false },
  )

  if (signal?.aborted) return

  const summary = parsed.summary || ''
  const keywords = parsed.keywords || []
  const mainTopics = parsed.main_topics || []

  onSaveSummary(fileId, summary, keywords, mainTopics)
  searchEngine.indexFileSummary(fileId, summary, keywords)
}

/** 当 LLM 不可用时的降级目录摘要生成 */
export function generateSimpleDirSummary(files: any[]): string {
  const extCount: Record<string, number> = {}
  for (const f of files) {
    const ext = f.file_ext || '其他'
    extCount[ext] = (extCount[ext] || 0) + 1
  }
  const extList = Object.entries(extCount)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext}(${count})`)
    .join(', ')

  const sampleFiles = files.slice(0, 10).map(f => f.file_name).join(', ')
  return `目录包含 ${files.length} 个文件（${extList}）。代表文件：${sampleFiles}`
}

/** 字节大小格式化 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** 构建目录摘要的文件清单文本 */
export function buildDirFileList(files: any[]): string {
  return files.map(f => {
    const summary = f.summary || f.light_summary || ''
    return `- ${f.file_name} (${f.file_ext || '无扩展名'}, ${formatSize(f.file_size)})${summary ? ': ' + summary.substring(0, 80) : ''}`
  }).join('\n')
}

/** 通过 LLM 生成目录摘要，失败时降级为简单摘要 */
export async function generateDirSummaryViaLLM(
  dirPath: string,
  files: any[],
  providerId: string | undefined,
  modelId: string | undefined,
  signal?: AbortSignal,
  enableThinking?: boolean,
  logSource = 'kms_dir_summary',
): Promise<{ summary: string; keywords: string[] }> {
  const fileList = buildDirFileList(files)

  if (providerId && modelId && files.length <= 100) {
    const prompt = `请为以下目录生成简洁摘要（200字以内），概括目录内容主题和结构，并提取5-10个关键词。

目录路径：${dirPath}
文件数量：${files.length}
文件清单：
${fileList}

请以JSON格式返回：{"summary": "...", "keywords": ["..."]}`

    try {
      const parsed = await callLLMForJSON<{ summary: string; keywords: string[] }>(
        providerId,
        modelId,
        [
          { role: 'system', content: '你是一个目录内容摘要助手，输出简洁准确的JSON。' },
          { role: 'user', content: prompt },
        ],
        { summary: '', keywords: [] },
        { temperature: 0.7, maxTokens: 400, signal, logSource, enable_thinking: enableThinking ? 'high' : false },
      )
      const summary = parsed.summary || ''
      if (summary) {
        return { summary, keywords: parsed.keywords || [] }
      }
    } catch (err: any) {
      // LLM 目录摘要生成失败，降级到简单摘要
      logger.warn('LLM dir summary generation failed, falling back to simple summary:', err?.message || err)
    }
  }

  return { summary: generateSimpleDirSummary(files), keywords: [] }
}
