import KMSSearchEngineService from './kms-search-engine.service'

/** LLM 识别的目录条目（未验证） */
export interface LLMTocEntry {
  title: string
  level: number
  lineNumber: number
}

/** 已验证的目录条目（含原文偏移） */
export interface ValidatedTocEntry {
  title: string
  level: number
  lineNumber: number
  offset: number
}

/** 段落切分结果 */
export interface ParagraphSlice {
  title: string
  titlePath: string
  level: number
  paragraphIndex: number
  startOffset: number
  endOffset: number
  content: string
}

// 段落处理常量（对齐旧知识库 KnowledgeProcessorService）
export const MAX_PARAGRAPH_CHARS = 5000
export const PARAGRAPH_OVERLAP_CHARS = 500
export const MAX_HEADING_LINE_RATIO = 0.25
export const TOC_CHUNK_LINES = 100
export const TOC_OVERLAP_LINES = 10
export const TOC_MIN_HEADING_DENSITY = 8000
export const MIN_CONTENT_WORDS = 50

/** 统计文本字数（CJK 计字符数，其余按词计） */
export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const cjkCount = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length
  const nonCjkText = trimmed.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
  const latinWords = nonCjkText.split(/\s+/).filter(w => w.length > 0).length
  return cjkCount + latinWords
}

function splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
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

function chunkParagraphs(text: string): ParagraphSlice[] {
  const chunks = splitIntoChunks(text, MAX_PARAGRAPH_CHARS, PARAGRAPH_OVERLAP_CHARS)
  return chunks.map((chunk, i) => {
    const startOff = text.indexOf(chunk)
    return {
      title: `段落 ${i + 1}`,
      titlePath: `段落 ${i + 1}`,
      level: 1,
      paragraphIndex: i,
      startOffset: startOff >= 0 ? startOff : i * (MAX_PARAGRAPH_CHARS - PARAGRAPH_OVERLAP_CHARS),
      endOffset: startOff >= 0 ? startOff + chunk.length : (i + 1) * MAX_PARAGRAPH_CHARS,
      content: chunk,
    }
  })
}

/**
 * 检测一行是否为标题，返回 { level, title } 或 null
 * 支持 Markdown 标题与中文常见标题格式：
 * - # / ## / ###（Markdown）
 * - 第X章 / 第X节
 * - 1. / 1.1 / 1.1.1（数字编号，最多3级）
 * - 一、 二、 三、（中文数字）
 * - （一） （二）（中文括号数字）
 * 标题行约束：trim 后非空、长度 < 100、不含句末标点（。！？；）
 */
function detectHeading(line: string): { level: number; title: string } | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length >= 100) return null
  // 含句末标点的行视为正文，避免误识别
  if (/[。！？；]/.test(trimmed)) return null

  // Markdown 标题: # / ## / ###
  const mdMatch = trimmed.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/)
  if (mdMatch) {
    return { level: mdMatch[1].length, title: mdMatch[2].trim() }
  }

  // 第X章 / 第X节（中文数字或阿拉伯数字）
  const chapterMatch = trimmed.match(/^第([一二三四五六七八九十百千\d]+)(章|节)\s*(.*)$/)
  if (chapterMatch) {
    const level = chapterMatch[2] === '章' ? 1 : 2
    return { level, title: trimmed }
  }

  // 数字编号: 1. / 1.1 / 1.1.1（最多3级，点号分隔）
  const numericMatch = trimmed.match(/^(\d{1,2}(?:\.\d{1,2}){0,2})[\.、\s]\s*(.+)$/)
  if (numericMatch) {
    const level = numericMatch[1].split('.').length
    if (level >= 1 && level <= 3) {
      return { level, title: trimmed }
    }
  }

  // 中文数字: 一、 二、 三、
  const cnNumericMatch = trimmed.match(/^([一二三四五六七八九十]+)、\s*(.+)$/)
  if (cnNumericMatch) {
    return { level: 1, title: trimmed }
  }

  // 中文括号数字: （一） （二）
  const cnParenMatch = trimmed.match(/^[（(]([一二三四五六七八九十]+)[)）]\s*(.+)$/)
  if (cnParenMatch) {
    return { level: 2, title: trimmed }
  }

  return null
}

/**
 * 段落识别（对齐旧知识库 KnowledgeProcessorService.identifyParagraphs）
 * - 通过 detectHeading 识别 Markdown + 中文标题（第X章/节、数字编号等）
 * - 标题比例过高（>25% 非空行）则降级为固定大小分块
 * - 首个标题前的正文作为"前言"段落
 * - 内容不足 MIN_CONTENT_WORDS 词时忽略该段落
 * - 超长段落按 MAX_PARAGRAPH_CHARS 二次切分（带 PARAGRAPH_OVERLAP_CHARS 重叠）
 */
export function splitParagraphs(fullText: string, fileName: string): ParagraphSlice[] {
  const paragraphs: Array<any> = []
  const lines = fullText.split('\n')
  let currentOffset = 0
  const headingPositions: Array<{ title: string; offset: number; level: number; lineIndex: number }> = []

  // 第一遍：扫描所有标题行
  for (let i = 0; i < lines.length; i++) {
    const heading = detectHeading(lines[i])
    if (heading) {
      headingPositions.push({
        title: heading.title,
        offset: currentOffset,
        level: heading.level,
        lineIndex: i,
      })
    }
    currentOffset += lines[i].length + 1
  }

  // 无标题 → 固定大小分块
  if (headingPositions.length === 0) {
    return chunkParagraphs(fullText)
  }

  // 标题比例过高 → 可能不是真正的结构标题，降级为分块
  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length
  const headingRatio = headingPositions.length / Math.max(nonEmptyLines, 1)
  if (headingRatio > MAX_HEADING_LINE_RATIO) {
    return chunkParagraphs(fullText)
  }

  // 标题栈：维护路径
  const headingStack: Array<{ title: string; level: number }> = []
  let paraIdx = 0

  // 首个标题前的内容 → "前言"
  const firstHeadingOffset = headingPositions[0].offset
  if (firstHeadingOffset > 0) {
    const prefaceContent = fullText.substring(0, firstHeadingOffset).trim()
    if (countWords(prefaceContent) >= MIN_CONTENT_WORDS) {
      if (prefaceContent.length > MAX_PARAGRAPH_CHARS) {
        const subChunks = splitIntoChunks(prefaceContent, MAX_PARAGRAPH_CHARS, PARAGRAPH_OVERLAP_CHARS)
        for (let si = 0; si < subChunks.length; si++) {
          paragraphs.push({
            title: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
            titlePath: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
            level: 1,
            paragraphIndex: paraIdx++,
            startOffset: 0,
            endOffset: firstHeadingOffset,
            content: subChunks[si],
          })
        }
      } else {
        paragraphs.push({
          title: '前言',
          titlePath: '前言',
          level: 1,
          paragraphIndex: paraIdx++,
          startOffset: 0,
          endOffset: firstHeadingOffset,
          content: prefaceContent,
        })
      }
    }
  }

  // 按标题切分段落
  for (let i = 0; i < headingPositions.length; i++) {
    const heading = headingPositions[i]

    // 维护标题栈
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= heading.level) {
      headingStack.pop()
    }
    headingStack.push({ title: heading.title, level: heading.level })

    const titlePath = headingStack.map(h => h.title).join(' > ')

    const nextHeading = headingPositions[i + 1]
    const startOff = heading.offset
    const endOff = nextHeading ? nextHeading.offset : fullText.length
    const content = fullText.substring(startOff, endOff).trim()

    // 内容太少 → 跳过该段落
    if (countWords(content) < MIN_CONTENT_WORDS) continue

    if (content.length > MAX_PARAGRAPH_CHARS) {
      const subChunks = splitIntoChunks(content, MAX_PARAGRAPH_CHARS, PARAGRAPH_OVERLAP_CHARS)
      for (let si = 0; si < subChunks.length; si++) {
        const subStartInContent = content.indexOf(subChunks[si])
        const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (MAX_PARAGRAPH_CHARS - PARAGRAPH_OVERLAP_CHARS))
        paragraphs.push({
          title: subChunks.length > 1 ? `${heading.title} (${si + 1})` : heading.title,
          titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
          level: heading.level,
          paragraphIndex: paraIdx++,
          startOffset: absStartOff,
          endOffset: absStartOff + subChunks[si].length,
          content: subChunks[si],
        })
      }
    } else {
      paragraphs.push({
        title: heading.title,
        titlePath,
        level: heading.level,
        paragraphIndex: paraIdx++,
        startOffset: startOff,
        endOffset: endOff,
        content,
      })
    }
  }

  // 兜底：无有效段落时，全文作为单一段落
  if (paragraphs.length === 0) {
    paragraphs.push({
      title: fileName,
      titlePath: fileName,
      level: 1,
      paragraphIndex: 0,
      startOffset: 0,
      endOffset: fullText.length,
      content: fullText.trim(),
    })
  }

  return paragraphs
}

/**
 * 生成文件 TOC（从段落表派生目录结构，写入 kms_file_summaries.toc_json）
 * TOC 仅包含标题与层级，不含正文内容
 */
export function generateFileToc(
  fileId: string,
  paragraphs: Array<{ title: string; titlePath: string; level: number; paragraphIndex: number; startOffset: number; endOffset: number }>,
  searchEngine: KMSSearchEngineService
): void {
  const toc = paragraphs
    .filter(p => p.title && p.title !== '前言')
    .map(p => ({
      id: p.paragraphIndex,
      title: p.title,
      titlePath: p.titlePath,
      level: p.level,
      paragraphIndex: p.paragraphIndex,
      startOffset: p.startOffset,
      endOffset: p.endOffset,
    }))

  searchEngine.saveFileToc(fileId, JSON.stringify(toc))
}

/**
 * 判断是否需要 LLM TOC 恢复
 * 条件：无标题 或 标题密度过低（平均每个标题承载超过 8000 字符）
 */
export function needsTocRestoration(text: string): boolean {
  const lines = text.split('\n')
  let headingCount = 0
  for (const line of lines) {
    if (detectHeading(line)) {
      headingCount++
    }
  }
  if (headingCount === 0) return true
  if (text.length / headingCount > TOC_MIN_HEADING_DENSITY) return true
  return false
}

/** 为文本添加行号标记（[L数字] 前缀） */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `[L${startLine + i}] ${line}`).join('\n')
}

/** 判断某行内容是否包含指定标题（容错匹配：归一化后子串包含或字符重合度 ≥ 0.6） */
function lineContainsTitle(lineContent: string, title: string): boolean {
  const normalize = (s: string) => s.replace(/[\s\u3000]+/g, '').toLowerCase()
  const normalizedLine = normalize(lineContent)
  const normalizedTitle = normalize(title)
  if (!normalizedLine || !normalizedTitle) return false
  if (normalizedLine === normalizedTitle) return true
  if (normalizedLine.includes(normalizedTitle) || normalizedTitle.includes(normalizedLine)) return true
  const titleChars = [...normalizedTitle]
  const lineChars = [...normalizedLine]
  let matchCount = 0
  for (const ch of titleChars) {
    if (lineChars.includes(ch)) matchCount++
  }
  return matchCount / titleChars.length >= 0.6
}

/** 对 TOC 条目按行号去重（行号相近且标题相似视为重复） */
export function deduplicateTocEntries(entries: LLMTocEntry[]): LLMTocEntry[] {
  const sorted = [...entries].sort((a, b) => a.lineNumber - b.lineNumber)
  const result: LLMTocEntry[] = []
  for (const entry of sorted) {
    const isDuplicate = result.some(existing =>
      Math.abs(existing.lineNumber - entry.lineNumber) <= 3 &&
      lineContainsTitle(existing.title, entry.title)
    )
    if (!isDuplicate) result.push(entry)
  }
  return result
}

/** 校验 LLM 识别的 TOC 条目，定位到原文真实行号与偏移 */
export function validateTocEntries(text: string, entries: LLMTocEntry[]): ValidatedTocEntry[] {
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
    if (entry.level < 1 || entry.level > 3) continue

    const targetLineIndex = entry.lineNumber - 1
    let foundLineIndex = -1

    if (targetLineIndex >= 0 && targetLineIndex < lines.length) {
      if (lineContainsTitle(lines[targetLineIndex], entry.title)) {
        foundLineIndex = targetLineIndex
      }
    }

    if (foundLineIndex === -1) {
      for (let delta = -5; delta <= 5; delta++) {
        const idx = targetLineIndex + delta
        if (idx >= 0 && idx < lines.length && lineContainsTitle(lines[idx], entry.title)) {
          foundLineIndex = idx
          break
        }
      }
    }

    if (foundLineIndex === -1) {
      for (let i = 0; i < lines.length; i++) {
        if (lineContainsTitle(lines[i], entry.title)) {
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

/** 构建已识别 TOC 上下文（取最近5条，按层级缩进）供 LLM 续识别参考 */
export function buildTocContext(entries: LLMTocEntry[]): string {
  if (entries.length === 0) return ''
  const recentEntries = entries.slice(-5)
  const contextLines = recentEntries.map(e => `${'  '.repeat(e.level - 1)}[L${e.level}] ${e.title}`)
  return contextLines.join('\n')
}

/**
 * 基于 LLM 还原的 TOC 重新切分段落（对齐旧知识库 identifyParagraphsFromLLMToc）
 */
export function identifyParagraphsFromLLMToc(
  text: string,
  tocEntries: ValidatedTocEntry[],
): ParagraphSlice[] {
  if (tocEntries.length === 0) return []

  const paragraphs: Array<any> = []
  const sortedEntries = [...tocEntries].sort((a, b) => a.offset - b.offset)
  const headingStack: Array<{ title: string; level: number }> = []
  let paraIdx = 0

  // 首个TOC条目之前的内容 → "前言"
  const firstEntryOffset = sortedEntries[0].offset
  if (firstEntryOffset > 0) {
    const prefaceContent = text.substring(0, firstEntryOffset).trim()
    if (countWords(prefaceContent) >= MIN_CONTENT_WORDS) {
      if (prefaceContent.length > MAX_PARAGRAPH_CHARS) {
        const subChunks = splitIntoChunks(prefaceContent, MAX_PARAGRAPH_CHARS, PARAGRAPH_OVERLAP_CHARS)
        for (let si = 0; si < subChunks.length; si++) {
          paragraphs.push({
            title: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
            titlePath: subChunks.length > 1 ? `前言 (${si + 1})` : '前言',
            level: 1,
            paragraphIndex: paraIdx++,
            startOffset: 0,
            endOffset: firstEntryOffset,
            content: subChunks[si],
          })
        }
      } else {
        paragraphs.push({
          title: '前言',
          titlePath: '前言',
          level: 1,
          paragraphIndex: paraIdx++,
          startOffset: 0,
          endOffset: firstEntryOffset,
          content: prefaceContent,
        })
      }
    }
  }

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

    if (countWords(content) < MIN_CONTENT_WORDS) continue

    if (content.length > MAX_PARAGRAPH_CHARS) {
      const subChunks = splitIntoChunks(content, MAX_PARAGRAPH_CHARS, PARAGRAPH_OVERLAP_CHARS)
      for (let si = 0; si < subChunks.length; si++) {
        const subStartInContent = content.indexOf(subChunks[si])
        const absStartOff = startOff + (subStartInContent >= 0 ? subStartInContent : si * (MAX_PARAGRAPH_CHARS - PARAGRAPH_OVERLAP_CHARS))
        paragraphs.push({
          title: subChunks.length > 1 ? `${entry.title} (${si + 1})` : entry.title,
          titlePath: subChunks.length > 1 ? `${titlePath} (${si + 1})` : titlePath,
          level: entry.level,
          paragraphIndex: paraIdx++,
          startOffset: absStartOff,
          endOffset: absStartOff + subChunks[si].length,
          content: subChunks[si],
        })
      }
    } else {
      paragraphs.push({
        title: entry.title,
        titlePath,
        level: entry.level,
        paragraphIndex: paraIdx++,
        startOffset: startOff,
        endOffset: endOff,
        content,
      })
    }
  }

  return paragraphs
}

/**
 * 按内容量过滤 TOC 条目（移除正文不足 MIN_CONTENT_WORDS 词的条目）
 */
export function filterTocByContentVolume(text: string, entries: ValidatedTocEntry[]): ValidatedTocEntry[] {
  if (entries.length === 0) return entries
  const sorted = [...entries].sort((a, b) => a.offset - b.offset)
  return sorted.filter((entry, i) => {
    const nextEntry = sorted[i + 1]
    const startOff = entry.offset
    const endOff = nextEntry ? nextEntry.offset : text.length
    const content = text.substring(startOff, endOff).trim()
    return countWords(content) >= MIN_CONTENT_WORDS
  })
}

/** 基于已验证的 TOC 条目构建带层级路径的目录 */
export function buildTocWithPath(entries: ValidatedTocEntry[]): Array<{ title: string; level: number; path: string; offset: number }> {
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

/** 解析 LLM 返回的 JSON（支持 ```json 代码块和裸 JSON 提取，失败时尝试修复） */
export function parseJSON<T>(raw: string, fallback: T): T {
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
      const repaired = repairJSON(raw)
      return JSON.parse(repaired) as T
    } catch {
      return fallback
    }
  }
}

/** 修复 LLM 输出的非法 JSON（转义字符串内的换行/制表符） */
function repairJSON(raw: string): string {
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
