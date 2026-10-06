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
  const systemPrompt = `You are an expert document structure analyst. Your task is to analyze document content and accurately identify its section headings, their hierarchy, and their positions.

Identification rules:
1. Identify only genuine structural headings. Do not mistake emphasized text, list items, or table content in the body for headings.
2. A heading is typically a short standalone line (usually no longer than 60 characters) that summarizes what follows.
3. Common heading patterns:
   - Numbered: "Chapter/Section/Part X", "1."/"1.1"/"1.1.1", or other ordered schemes
   - Unnumbered: a standalone summarizing phrase followed by detailed content
4. level is the hierarchy depth, up to 3 levels: 1 = top level (chapter/part), 2 = next level (section), 3 = finest level (subsection). Never exceed 3 levels.
5. lineNumber must exactly match the [L<number>] line markers in the content.
6. If a heading is followed by too little body content (for example, fewer than 50 words), ignore that heading.
7. When upper-level TOC context is provided, use it to determine the level of the current headings and avoid misclassifying lower-level headings as higher-level ones.
8. Copy every heading title verbatim from the source content and keep it in the document's original language. Never translate headings into English.${existingTocContext ? `\n\nAlready identified upper-level TOC context (for reference):\n${existingTocContext}` : ''}

Output requirements:
- Return strictly valid JSON.
- Return only the JSON, with no explanatory text.
- If no heading structure can be identified, return {"toc":[]}`

  const userPrompt = `Analyze the following document content and identify all section headings and their positions.

Document content:
${numberedContent}

Response format:
{"toc":[{"title":"heading text","level":1,"lineNumber":5}]}`

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
  const prompt = `Generate a summary for the paragraph below and return it as JSON.
Paragraph title: ${paragraphTitle}
Paragraph content:
${paragraphContent.substring(0, 8000)}

Return these fields:
- title: the paragraph title
- summary: a concise, tightly written summary (about 50 words)
- keywords: a list of 3-5 keywords

Write the title, summary, and keywords in the same language as the paragraph content. If the paragraph is not in English, do not translate it into English — keep the original language.

Return only JSON.`

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
    `### Paragraph ${i + 1}: ${ps.title}\n${ps.summary}\nKeywords: ${ps.keywords.join(', ')}`
  ).join('\n\n')

  const prompt = `Generate a document-level summary from the paragraph summaries below and return it as JSON.
Document title: ${documentTitle}
Paragraph summaries:
${summariesText.substring(0, 15000)}

Return these fields:
- summary: a document-level summary (about 150 words, concise and tight)
- keywords: a list of 5-8 keywords
- mainTopics: a list of 3-5 main topics

Write the summary, keywords, and main topics in the same language as the source material. If the source is not in English, do not translate it into English — keep the original language.

Return only JSON.`

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
  summaries: Array<{ title: string; summary: string; keywords: string[]; paragraphIndex?: number }>,
  searchEngine: KMSSearchEngineService,
): void {
  const paraById = new Map<number, string>()
  for (const sp of savedParagraphs) paraById.set(sp.paragraphIndex, sp.id)
  const paraByIndex = new Map<number, any>()
  for (const p of paragraphs) paraByIndex.set(p.paragraphIndex, p)

  for (let i = 0; i < summaries.length; i++) {
    const summary = summaries[i]
    if (!summary.summary && summary.keywords.length === 0) continue

    // 摘要数组的下标对应的是摘要候选（savedParagraphs 的过滤子集），
    // 不能把数组下标直接当 paragraphIndex，否则候选跳号时摘要整体错位写入错误段落
    const targetParaIndex = summary.paragraphIndex ?? i
    const paraId = paraById.get(targetParaIndex)
    if (!paraId) continue

    searchEngine.updateParagraphSummary(paraId, summary.summary, summary.keywords)

    const p = paraByIndex.get(targetParaIndex)
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
  const summaryPrompt = `Generate a concise summary (about 150 words) of the document content below, and extract 5-8 keywords and 3-5 main topics.

Document content:
${truncatedText}

Write the summary, keywords, and main topics in the same language as the document. If the document is not in English, do not translate it into English — keep the original language.

Return the result as JSON: {"summary": "...", "keywords": ["..."], "main_topics": ["..."]}`

  if (signal?.aborted) return

  const parsed = await callLLMForJSON<{ summary: string; keywords: string[]; main_topics: string[] }>(
    providerId,
    modelId,
    [
      { role: 'system', content: 'You are a document summarization assistant. Always return results in strict JSON format.' },
      { role: 'user', content: summaryPrompt },
    ],
    { summary: '', keywords: [], main_topics: [] },
    // 失败必须抛出：静默返回空 fallback 会让调用方用空摘要覆盖已有摘要
    { temperature: 0.7, maxTokens: 500, signal, enable_thinking: enableThinking ? 'high' : false, throwOnError: true },
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
    return `- ${f.file_name} (${f.file_ext || 'no extension'}, ${formatSize(f.file_size)})${summary ? ': ' + summary.substring(0, 80) : ''}`
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
    const prompt = `Generate a concise summary (about 200 words) of the directory below, covering its content themes and structure, and extract 5-10 keywords.

Directory path: ${dirPath}
File count: ${files.length}
File list:
${fileList}

Write the summary and keywords in the same language as the file names and summaries above. If they are not in English, do not translate them into English — keep the original language.

Return the result as JSON: {"summary": "...", "keywords": ["..."]}`

    try {
      const parsed = await callLLMForJSON<{ summary: string; keywords: string[] }>(
        providerId,
        modelId,
        [
          { role: 'system', content: 'You are a directory content summarization assistant. Output concise, accurate JSON.' },
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
