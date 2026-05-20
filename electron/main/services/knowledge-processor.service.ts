import KBDatabaseService from './kb-database.service'
import { generateId } from './common-utils'
import LLMClientService from './llm-client.service'
import SearchEngineService from './search-engine.service'

interface ParagraphInfo {
  title: string
  titlePath: string
  index: number
  startOffset: number
  endOffset: number
  content: string
  level: number
}

interface ParagraphSummary {
  title: string
  summary: string
  keywords: string[]
}

interface DocumentSummary {
  summary: string
  keywords: string[]
  mainTopics: string[]
  toc: Array<{
    title: string
    level: number
    path: string
    offset: number
  }>
}

interface LLMTocEntry {
  title: string
  level: number
  lineNumber: number
}

interface ValidatedTocEntry {
  title: string
  level: number
  lineNumber: number
  offset: number
}

class KnowledgeProcessorService {
  private kbDb: KBDatabaseService
  private llmClient: LLMClientService
  private searchEngine: SearchEngineService
  private static instance: KnowledgeProcessorService

  private get db() { return this.kbDb.getDb() }

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.searchEngine = SearchEngineService.getInstance()
  }

  static getInstance(): KnowledgeProcessorService {
    if (!KnowledgeProcessorService.instance) {
      KnowledgeProcessorService.instance = new KnowledgeProcessorService()
    }
    return KnowledgeProcessorService.instance
  }

  private static readonly MAX_PARAGRAPH_CHARS = 5000
  private static readonly PARAGRAPH_OVERLAP_CHARS = 500
  private static readonly MAX_HEADING_LINE_RATIO = 0.25
  private static readonly TOC_CHUNK_LINES = 100
  private static readonly TOC_OVERLAP_LINES = 10
  private static readonly TOC_MIN_HEADING_DENSITY = 8000

  identifyParagraphs(text: string): ParagraphInfo[] {
    const paragraphs: ParagraphInfo[] = []
    const lines = text.split('\n')
    let currentOffset = 0
    const headingPositions: Array<{ title: string; offset: number; level: number; lineIndex: number }> = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = line.match(/^(#{1,4})\s+(.+)/)
      if (match) {
        headingPositions.push({
          title: match[2].trim(),
          offset: currentOffset,
          level: match[1].length,
          lineIndex: i,
        })
      }
      currentOffset += line.length + 1
    }

    if (headingPositions.length === 0) {
      return this.chunkParagraphs(text)
    }

    const nonEmptyLines = lines.filter(l => l.trim().length > 0).length
    const headingRatio = headingPositions.length / Math.max(nonEmptyLines, 1)
    if (headingRatio > KnowledgeProcessorService.MAX_HEADING_LINE_RATIO) {
      return this.chunkParagraphs(text)
    }

    const headingStack: Array<{ title: string; level: number }> = []

    for (let i = 0; i < headingPositions.length; i++) {
      const heading = headingPositions[i]

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= heading.level) {
        headingStack.pop()
      }
      headingStack.push({ title: heading.title, level: heading.level })

      const titlePath = headingStack.map(h => h.title).join(' > ')

      const nextHeading = headingPositions[i + 1]
      const startOff = heading.offset
      const endOff = nextHeading ? nextHeading.offset : text.length
      const content = text.substring(startOff, endOff).trim()

      if (content.length > 50) {
        if (content.length > KnowledgeProcessorService.MAX_PARAGRAPH_CHARS) {
          const subChunks = this.splitIntoChunks(content, KnowledgeProcessorService.MAX_PARAGRAPH_CHARS, KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS)
          for (let si = 0; si < subChunks.length; si++) {
            const subStartInContent = content.indexOf(subChunks[si])
            const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (KnowledgeProcessorService.MAX_PARAGRAPH_CHARS - KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS))
            paragraphs.push({
              title: subChunks.length > 1 ? `${heading.title} (${si + 1})` : heading.title,
              titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
              index: paragraphs.length,
              startOffset: absStartOff,
              endOffset: absStartOff + subChunks[si].length,
              content: subChunks[si],
              level: heading.level,
            })
          }
        } else {
          paragraphs.push({
            title: heading.title,
            titlePath,
            index: paragraphs.length,
            startOffset: startOff,
            endOffset: endOff,
            content,
            level: heading.level,
          })
        }
      }
    }

    if (paragraphs.length === 0) {
      paragraphs.push({
        title: '全文',
        titlePath: '全文',
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        content: text,
        level: 1,
      })
    }

    return paragraphs
  }

  extractToc(text: string): Array<{ title: string; level: number; path: string; offset: number }> {
    const lines = text.split('\n')
    let currentOffset = 0
    const headings: Array<{ title: string; level: number; offset: number }> = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = line.match(/^(#{1,4})\s+(.+)/)
      if (match) {
        headings.push({
          title: match[2].trim(),
          level: match[1].length,
          offset: currentOffset,
        })
      }
      currentOffset += line.length + 1
    }

    const headingStack: Array<{ title: string; level: number }> = []
    return headings.map(h => {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= h.level) {
        headingStack.pop()
      }
      headingStack.push({ title: h.title, level: h.level })
      return {
        title: h.title,
        level: h.level,
        path: headingStack.map(s => s.title).join(' > '),
        offset: h.offset,
      }
    })
  }

  needsTocRestoration(text: string): boolean {
    const lines = text.split('\n')
    let headingCount = 0
    for (const line of lines) {
      if (/^#{1,4}\s+/.test(line.trim())) {
        headingCount++
      }
    }
    if (headingCount === 0) return true
    if (text.length / headingCount > KnowledgeProcessorService.TOC_MIN_HEADING_DENSITY) return true
    return false
  }

  private addLineNumbers(text: string, startLine: number = 1): string {
    const lines = text.split('\n')
    return lines.map((line, i) => `[L${startLine + i}] ${line}`).join('\n')
  }

  private async callLLMForToc(
    numberedContent: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean
  ): Promise<LLMTocEntry[]> {
    const systemPrompt = `你是一个专业的文档结构分析专家。你的任务是分析文档内容，精确识别其中的章节标题、层级关系和位置。

识别规则：
1. 只识别真正的结构性标题，不要把正文中的强调文本、列表项、表格内容误认为标题
2. 标题特征：通常是独立成行的短文本（一般不超过60字），具有概括性
3. 常见标题模式：
   - 编号型："第X章/节/部分"、"1."/"1.1"/"1.1.1"、"一、"/"二、"
   - 无编号型：独立成行的概括性短语，后续跟随详细说明内容
4. level表示层级深度：1=最高级（章/部分），2=次级（节），3=更次级（小节），4=最细粒度
5. lineNumber必须精确对应内容中的行号标记[L数字]

输出要求：
- 严格按照JSON格式输出
- 只返回JSON，不要包含任何解释文字
- 如果无法识别任何标题结构，返回{"toc":[]}`

    const userPrompt = `请分析以下文档内容，识别所有章节标题及其位置。

文档内容：
${numberedContent}

返回格式：
{"toc":[{"title":"标题文字","level":1,"lineNumber":5}]}`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        temperature: 0.1,
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      const parsed = this.parseJSON<{ toc: LLMTocEntry[] }>(result, { toc: [] })
      return Array.isArray(parsed.toc) ? parsed.toc : []
    } catch {
      return []
    }
  }

  private lineContainsTitle(lineContent: string, title: string): boolean {
    const normalize = (s: string) => s.replace(/[\s\u3000]+/g, '').toLowerCase()
    const normalizedLine = normalize(lineContent)
    const normalizedTitle = normalize(title)
    if (!normalizedLine || !normalizedTitle) return false
    if (normalizedLine === normalizedTitle) return true
    if (normalizedLine.includes(normalizedTitle) || normalizedTitle.includes(normalizedLine)) return true
    const titleChars = [...normalizedTitle]
    const lineChars = [...normalizedLine]
    const shorterLen = Math.min(titleChars.length, lineChars.length)
    if (shorterLen === 0) return false
    let matchCount = 0
    for (const ch of titleChars) {
      if (lineChars.includes(ch)) matchCount++
    }
    return matchCount / titleChars.length >= 0.6
  }

  validateTocEntries(text: string, entries: LLMTocEntry[]): ValidatedTocEntry[] {
    const lines = text.split('\n')
    const lineOffsets: number[] = []
    let offset = 0
    for (const line of lines) {
      lineOffsets.push(offset)
      offset += line.length + 1
    }

    const validated: ValidatedTocEntry[] = []

    for (const entry of entries) {
      if (!entry.title || entry.lineNumber == null || entry.level == null) continue
      if (entry.level < 1 || entry.level > 4) continue

      const targetLineIndex = entry.lineNumber - 1
      let foundLineIndex = -1

      if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
        if (this.lineContainsTitle(lines[targetLineIndex], entry.title)) {
          foundLineIndex = targetLineIndex
        }
      }

      if (foundLineIndex === -1) {
        for (let delta = -5; delta <= 5; delta++) {
          const idx = targetLineIndex + delta
          if (idx >= 0 && idx < lines.length && this.lineContainsTitle(lines[idx], entry.title)) {
            foundLineIndex = idx
            break
          }
        }
      }

      if (foundLineIndex === -1) {
        for (let i = 0; i < lines.length; i++) {
          if (this.lineContainsTitle(lines[i], entry.title)) {
            foundLineIndex = i
            break
          }
        }
      }

      if (foundLineIndex >= 0) {
        validated.push({
          title: entry.title,
          level: entry.level,
          lineNumber: foundLineIndex + 1,
          offset: lineOffsets[foundLineIndex],
        })
      } else if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
        const trimmedLine = lines[targetLineIndex].trim()
        if (trimmedLine.length > 0 && trimmedLine.length <= 10) {
          validated.push({
            title: entry.title,
            level: entry.level,
            lineNumber: targetLineIndex + 1,
            offset: lineOffsets[targetLineIndex],
          })
        }
      }
    }

    return validated
  }

  private deduplicateTocEntries(entries: LLMTocEntry[]): LLMTocEntry[] {
    const sorted = [...entries].sort((a, b) => a.lineNumber - b.lineNumber)
    const result: LLMTocEntry[] = []

    for (const entry of sorted) {
      const isDuplicate = result.some(existing =>
        Math.abs(existing.lineNumber - entry.lineNumber) <= 3 &&
        this.lineContainsTitle(existing.title, entry.title)
      )
      if (!isDuplicate) {
        result.push(entry)
      }
    }

    return result
  }

  async restoreTocWithLLM(
    text: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<ValidatedTocEntry[]> {
    const lines = text.split('\n')

    onProgress?.('toc_restore', 'Starting TOC restoration with LLM...')

    if (lines.length <= KnowledgeProcessorService.TOC_CHUNK_LINES) {
      const numberedContent = this.addLineNumbers(text)
      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, enableThinking)
      return this.validateTocEntries(text, entries)
    }

    const allEntries: LLMTocEntry[] = []
    let startLine = 0
    let chunkIndex = 0

    while (startLine < lines.length) {
      const endLine = Math.min(startLine + KnowledgeProcessorService.TOC_CHUNK_LINES, lines.length)
      const chunkLines = lines.slice(startLine, endLine)
      const numberedContent = this.addLineNumbers(chunkLines.join('\n'), startLine + 1)

      onProgress?.('toc_restore', `Analyzing chunk ${chunkIndex + 1} for TOC structure...`)

      const entries = await this.callLLMForToc(numberedContent, providerId, modelId, enableThinking)
      allEntries.push(...entries)

      chunkIndex++
      if (endLine >= lines.length) break
      startLine = endLine - KnowledgeProcessorService.TOC_OVERLAP_LINES
    }

    const deduplicated = this.deduplicateTocEntries(allEntries)
    const validated = this.validateTocEntries(text, deduplicated)

    onProgress?.('toc_restore', `TOC restoration completed: ${validated.length} entries found`)

    return validated
  }

  identifyParagraphsFromLLMToc(text: string, tocEntries: ValidatedTocEntry[]): ParagraphInfo[] {
    if (tocEntries.length === 0) {
      return this.identifyParagraphs(text)
    }

    const paragraphs: ParagraphInfo[] = []
    const sortedEntries = [...tocEntries].sort((a, b) => a.offset - b.offset)

    const headingStack: Array<{ title: string; level: number }> = []

    for (let i = 0; i < sortedEntries.length; i++) {
      const entry = sortedEntries[i]

      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= entry.level) {
        headingStack.pop()
      }
      headingStack.push({ title: entry.title, level: entry.level })

      const titlePath = headingStack.map(h => h.title).join(' > ')
      const nextEntry = sortedEntries[i + 1]
      const startOff = entry.offset
      const endOff = nextEntry ? nextEntry.offset : text.length
      const content = text.substring(startOff, endOff).trim()

      if (content.length > 10) {
        if (content.length > KnowledgeProcessorService.MAX_PARAGRAPH_CHARS) {
          const subChunks = this.splitIntoChunks(content, KnowledgeProcessorService.MAX_PARAGRAPH_CHARS, KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS)
          for (let si = 0; si < subChunks.length; si++) {
            const subStartInContent = content.indexOf(subChunks[si])
            const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (KnowledgeProcessorService.MAX_PARAGRAPH_CHARS - KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS))
            paragraphs.push({
              title: subChunks.length > 1 ? `${entry.title} (${si + 1})` : entry.title,
              titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
              index: paragraphs.length,
              startOffset: absStartOff,
              endOffset: absStartOff + subChunks[si].length,
              content: subChunks[si],
              level: entry.level,
            })
          }
        } else {
          paragraphs.push({
            title: entry.title,
            titlePath,
            index: paragraphs.length,
            startOffset: startOff,
            endOffset: endOff,
            content,
            level: entry.level,
          })
        }
      }
    }

    if (paragraphs.length === 0) {
      return this.identifyParagraphs(text)
    }

    return paragraphs
  }

  buildTocWithPath(entries: ValidatedTocEntry[]): Array<{ title: string; level: number; path: string; offset: number }> {
    const sorted = [...entries].sort((a, b) => a.offset - b.offset)
    const headingStack: Array<{ title: string; level: number }> = []

    return sorted.map(entry => {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= entry.level) {
        headingStack.pop()
      }
      headingStack.push({ title: entry.title, level: entry.level })
      return {
        title: entry.title,
        level: entry.level,
        path: headingStack.map(h => h.title).join(' > '),
        offset: entry.offset,
      }
    })
  }

  saveTocOnly(kbId: string, documentId: string, toc: Array<{ title: string; level: number; path: string; offset: number }>): void {
    const existing = this.db.prepare(
      'SELECT id FROM kb_document_summaries WHERE document_id = ?'
    ).get(documentId) as any

    if (existing) {
      this.db.prepare(
        'UPDATE kb_document_summaries SET toc_json = ?, updated_at = unixepoch() WHERE document_id = ?'
      ).run(JSON.stringify(toc), documentId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, toc_json, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, '[]', '[]', unixepoch(), unixepoch())
      `).run(id, kbId, documentId, JSON.stringify(toc))
    }
  }

  async generateParagraphSummary(
    paragraphContent: string,
    paragraphTitle: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<ParagraphSummary> {
    onProgress?.('paragraph_summary', `Generating paragraph summary: ${paragraphTitle}`)

    const prompt = `为以下段落生成摘要，JSON格式返回。

段落标题：${paragraphTitle}
段落内容：
${paragraphContent.substring(0, 8000)}

返回字段：
- title: 段落标题
- summary: 摘要（150字以内，简洁精炼）
- keywords: 关键词列表（3-5个）

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], {
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON<ParagraphSummary>(result, {
        title: paragraphTitle,
        summary: '',
        keywords: [],
      })
    } catch (error) {
      throw new Error(`Paragraph summary generation failed (${paragraphTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async generateDocumentSummary(
    paragraphSummaries: ParagraphSummary[],
    documentTitle: string,
    toc: Array<{ title: string; level: number; path: string; offset: number }>,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<DocumentSummary> {
    onProgress?.('doc_summary', `Generating document summary: ${documentTitle}`)

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

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], {
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      const parsed = this.parseJSON<Omit<DocumentSummary, 'toc'>>(result, {
        summary: '',
        keywords: [],
        mainTopics: [],
      })

      return { ...parsed, toc }
    } catch (error) {
      throw new Error(`Document summary generation failed (${documentTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async generateGlobalSummary(
    documentSummaries: Array<{ title: string; summary: string; mainTopics: string[] }>,
    kbName: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<{
    summary: string
    keyTopics: string[]
  }> {
    onProgress?.('global_summary', 'Generating global knowledge summary...')

    const docsText = documentSummaries.map((ds, i) =>
      `### 文档${i + 1}: ${ds.title}\n${ds.summary}\n主要主题: ${ds.mainTopics.join(', ')}`
    ).join('\n\n')

    const prompt = `基于文档摘要生成知识库全局摘要，JSON格式返回。

知识库名称：${kbName}
文档摘要：
${docsText.substring(0, 20000)}

返回字段：
- summary: 全局摘要（150字以内）
- keyTopics: 核心主题列表

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer specializing in cross-document knowledge integration. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], {
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON(result, {
        summary: '',
        keyTopics: [],
      })
    } catch (error) {
      throw new Error(`Global summary generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  saveParagraphs(kbId: string, documentId: string, paragraphs: ParagraphInfo[], summaries: ParagraphSummary[]): void {
    const existingParagraphs = this.db.prepare(
      'SELECT id FROM kb_paragraphs WHERE document_id = ?'
    ).all(documentId) as any[]

    if (existingParagraphs.length > 0) {
      this.db.prepare('DELETE FROM kb_paragraphs WHERE document_id = ?').run(documentId)
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO kb_paragraphs (id, kb_id, document_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, summary, keywords_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `)

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i]
      const summary = summaries[i]
      const id = generateId()

      insertStmt.run(
        id,
        kbId,
        documentId,
        paragraph.title,
        paragraph.titlePath,
        paragraph.level,
        paragraph.index,
        paragraph.startOffset,
        paragraph.endOffset,
        paragraph.content,
        summary?.summary || null,
        JSON.stringify(summary?.keywords || []),
      )

      this.searchEngine.indexParagraph(
        kbId,
        documentId,
        id,
        paragraph.title,
        paragraph.titlePath,
        summary?.summary || '',
        summary?.keywords || [],
        paragraph.startOffset,
        paragraph.endOffset
      )
    }
  }

  saveParagraphsWithoutSummary(kbId: string, documentId: string, paragraphs: ParagraphInfo[]): void {
    const existingParagraphs = this.db.prepare(
      'SELECT id FROM kb_paragraphs WHERE document_id = ?'
    ).all(documentId) as any[]

    if (existingParagraphs.length > 0) {
      this.db.prepare('DELETE FROM kb_paragraphs WHERE document_id = ?').run(documentId)
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO kb_paragraphs (id, kb_id, document_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, summary, keywords_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', unixepoch(), unixepoch())
    `)

    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i]
      const id = generateId()

      insertStmt.run(
        id,
        kbId,
        documentId,
        paragraph.title,
        paragraph.titlePath,
        paragraph.level,
        paragraph.index,
        paragraph.startOffset,
        paragraph.endOffset,
        paragraph.content,
      )

      this.searchEngine.indexParagraph(
        kbId,
        documentId,
        id,
        paragraph.title,
        paragraph.titlePath,
        '',
        [],
        paragraph.startOffset,
        paragraph.endOffset
      )
    }
  }

  updateParagraphSummaries(documentId: string, summaries: ParagraphSummary[]): void {
    const paragraphs = this.db.prepare(
      'SELECT id, kb_id, title, start_offset, end_offset FROM kb_paragraphs WHERE document_id = ? ORDER BY paragraph_index'
    ).all(documentId) as Array<{ id: string; kb_id: string; title: string; start_offset: number; end_offset: number }>

    const updateStmt = this.db.prepare(`
      UPDATE kb_paragraphs SET summary = ?, keywords_json = ?, updated_at = unixepoch() WHERE id = ?
    `)

    for (let i = 0; i < Math.min(paragraphs.length, summaries.length); i++) {
      const paragraph = paragraphs[i]
      const summary = summaries[i]
      updateStmt.run(
        summary?.summary || null,
        JSON.stringify(summary?.keywords || []),
        paragraph.id,
      )

      this.searchEngine.indexParagraph(
        paragraph.kb_id,
        documentId,
        paragraph.id,
        paragraph.title,
        '',
        summary?.summary || '',
        summary?.keywords || [],
        paragraph.start_offset,
        paragraph.end_offset,
      )
    }
  }

  saveDocumentSummary(kbId: string, documentId: string, docSummary: DocumentSummary): void {
    const existing = this.db.prepare(
      'SELECT id, toc_json FROM kb_document_summaries WHERE document_id = ?'
    ).get(documentId) as any

    const existingTocJson = existing?.toc_json
    const existingToc = existingTocJson ? JSON.parse(existingTocJson) : []
    const finalToc = existingToc.length > 0 ? existingToc : docSummary.toc

    const data = {
      summary: docSummary.summary,
      toc_json: JSON.stringify(finalToc),
      keywords_json: JSON.stringify(docSummary.keywords),
      main_topics_json: JSON.stringify(docSummary.mainTopics),
    }

    if (existing) {
      this.db.prepare(`
        UPDATE kb_document_summaries SET summary = ?, toc_json = ?, keywords_json = ?, main_topics_json = ?, updated_at = unixepoch()
        WHERE document_id = ?
      `).run(data.summary, data.toc_json, data.keywords_json, data.main_topics_json, documentId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, toc_json, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, documentId, data.summary, data.toc_json, data.keywords_json, data.main_topics_json)
    }

    this.searchEngine.indexDocumentSummary(
      kbId,
      documentId,
      docSummary.summary,
      docSummary.keywords
    )
  }

  saveGlobalSummary(kbId: string, globalSummary: {
    summary: string
    keyTopics: string[]
  }): void {
    const existing = this.db.prepare(
      'SELECT id FROM kb_global_summaries WHERE kb_id = ?'
    ).get(kbId) as any

    const data = {
      summary: globalSummary.summary,
      key_topics_json: JSON.stringify(globalSummary.keyTopics),
    }

    if (existing) {
      this.db.prepare(`
        UPDATE kb_global_summaries SET summary = ?, key_topics_json = ?, updated_at = unixepoch()
        WHERE kb_id = ?
      `).run(data.summary, data.key_topics_json, kbId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, data.summary, data.key_topics_json)
    }
  }

  getParagraphs(documentId: string): any[] {
    return this.db.prepare(
      'SELECT * FROM kb_paragraphs WHERE document_id = ? ORDER BY paragraph_index'
    ).all(documentId)
  }

  getParagraphsByKb(kbId: string): any[] {
    return this.db.prepare(
      'SELECT * FROM kb_paragraphs WHERE kb_id = ? ORDER BY document_id, paragraph_index'
    ).all(kbId)
  }

  updateParagraph(paragraphId: string, updates: { summary?: string; keywords_json?: string; content?: string; title?: string }): boolean {
    const sets: string[] = []
    const values: any[] = []
    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary) }
    if (updates.keywords_json !== undefined) { sets.push('keywords_json = ?'); values.push(updates.keywords_json) }
    if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content) }
    if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
    if (sets.length === 0) return false
    sets.push('updated_at = unixepoch()')
    values.push(paragraphId)
    const result = this.db.prepare(`UPDATE kb_paragraphs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return result.changes > 0
  }

  updateDocumentSummary(documentId: string, updates: { summary?: string; keywords_json?: string; main_topics_json?: string }): boolean {
    const sets: string[] = []
    const values: any[] = []
    if (updates.summary !== undefined) { sets.push('summary = ?'); values.push(updates.summary) }
    if (updates.keywords_json !== undefined) { sets.push('keywords_json = ?'); values.push(updates.keywords_json) }
    if (updates.main_topics_json !== undefined) { sets.push('main_topics_json = ?'); values.push(updates.main_topics_json) }
    if (sets.length === 0) return false
    sets.push('updated_at = unixepoch()')
    values.push(documentId)
    const result = this.db.prepare(`UPDATE kb_document_summaries SET ${sets.join(', ')} WHERE document_id = ?`).run(...values)
    return result.changes > 0
  }

  getDocumentSummary(documentId: string): any | null {
    return this.db.prepare(
      'SELECT * FROM kb_document_summaries WHERE document_id = ?'
    ).get(documentId) || null
  }

  getGlobalSummary(kbId: string): any | null {
    return this.db.prepare(
      'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
    ).get(kbId) || null
  }

  getProcessingJobs(kbId: string, status?: string): any[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM kb_processing_jobs WHERE kb_id = ? AND status = ? ORDER BY created_at DESC'
      ).all(kbId, status)
    }
    return this.db.prepare(
      'SELECT * FROM kb_processing_jobs WHERE kb_id = ? ORDER BY created_at DESC'
    ).all(kbId)
  }

  createProcessingJob(kbId: string, documentId: string | null, jobType: string, totalSteps: number): string {
    const id = generateId()
    this.db.prepare(`
      INSERT INTO kb_processing_jobs (id, kb_id, document_id, job_type, status, total_steps, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, unixepoch(), unixepoch())
    `).run(id, kbId, documentId, jobType, totalSteps)
    return id
  }

  updateProcessingJob(jobId: string, status: string, progress?: number, currentStep?: string, errorMessage?: string): void {
    const updates: string[] = ['status = ?', 'updated_at = unixepoch()']
    const values: any[] = [status]

    if (progress !== undefined) { updates.push('progress = ?'); values.push(progress) }
    if (currentStep !== undefined) { updates.push('current_step = ?'); values.push(currentStep) }
    if (errorMessage !== undefined) { updates.push('error_message = ?'); values.push(errorMessage) }
    if (status === 'running') { updates.push('started_at = unixepoch()') }
    if (status === 'completed' || status === 'failed') { updates.push('completed_at = unixepoch()') }

    values.push(jobId)
    this.db.prepare(`UPDATE kb_processing_jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteKnowledgeData(kbId: string, documentId?: string): void {
    if (documentId) {
      this.db.prepare('DELETE FROM kb_paragraphs WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_document_summaries WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_processing_jobs WHERE document_id = ?').run(documentId)
    } else {
      this.db.prepare('DELETE FROM kb_paragraphs WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_document_summaries WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_global_summaries WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_processing_jobs WHERE kb_id = ?').run(kbId)
    }
  }

  getKnowledgeStats(kbId: string): {
    paragraphCount: number
    documentSummaryCount: number
    hasGlobalSummary: boolean
  } {
    const paragraphCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_paragraphs WHERE kb_id = ?').get(kbId) as any)?.count || 0
    const documentSummaryCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_document_summaries WHERE kb_id = ?').get(kbId) as any)?.count || 0
    const hasGlobalSummary = !!this.db.prepare('SELECT id FROM kb_global_summaries WHERE kb_id = ?').get(kbId)

    return { paragraphCount, documentSummaryCount, hasGlobalSummary }
  }

  private splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
    if (text.length <= chunkSize) return [text]
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length)
      chunks.push(text.substring(start, end))
      if (end >= text.length) break
      start = end - overlap
    }
    return chunks.filter(c => c.length > 50)
  }

  private chunkParagraphs(text: string): ParagraphInfo[] {
    const chunkSize = KnowledgeProcessorService.MAX_PARAGRAPH_CHARS
    const chunks = this.splitIntoChunks(text, chunkSize, KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS)
    return chunks.map((chunk, i) => {
      const startOff = text.indexOf(chunk)
      return {
        title: `段落 ${i + 1}`,
        titlePath: `段落 ${i + 1}`,
        index: i,
        startOffset: startOff >= 0 ? startOff : i * (chunkSize - KnowledgeProcessorService.PARAGRAPH_OVERLAP_CHARS),
        endOffset: startOff >= 0 ? startOff + chunk.length : (i + 1) * chunkSize,
        content: chunk,
        level: 1,
      }
    })
  }

  private parseJSON<T>(raw: string, fallback: T): T {
    try {
      let jsonStr = raw.trim()
      const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m)
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim()
      } else {
        const firstBrace = jsonStr.indexOf('{')
        const lastBrace = jsonStr.lastIndexOf('}')
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
        }
      }
      return JSON.parse(jsonStr) as T
    } catch {
      try {
        const repaired = this.repairJSON(raw)
        return JSON.parse(repaired) as T
      } catch {
        return fallback
      }
    }
  }

  private repairJSON(raw: string): string {
    let result = ''
    let inString = false
    let escaped = false

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (escaped) { result += ch; escaped = false; continue }
      if (ch === '\\') { result += ch; escaped = true; continue }
      if (ch === '"') { inString = !inString; result += ch; continue }
      if (inString) {
        if (ch === '\n') result += '\\n'
        else if (ch === '\r') result += '\\r'
        else if (ch === '\t') result += '\\t'
        else result += ch
      } else {
        result += ch
      }
    }

    return result
  }
}

export default KnowledgeProcessorService
