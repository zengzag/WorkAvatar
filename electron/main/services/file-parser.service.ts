import fs from 'fs'
import path from 'path'
import { convert } from 'file2md'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import XLSX from 'xlsx'
import { extractTextItems } from 'unpdf'
import type { ParseResult } from '../../shared/types'
import OCRService from './ocr.service'

class FileParserService {
  private ocr: OCRService
  private static instance: FileParserService

  private constructor() {
    this.ocr = OCRService.getInstance()
    this.ocr.initialize().catch(console.error)
  }

  static getInstance(): FileParserService {
    if (!FileParserService.instance) {
      FileParserService.instance = new FileParserService()
    }
    return FileParserService.instance
  }

  private async parsePDF(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    try {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const buffer = await fs.promises.readFile(filePath)
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const data = new Uint8Array(buffer)
      const result = await extractTextItems(data)
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const pages = result.items.map(pageItems =>
        pageItems
          .map(item => item.str + (item.hasEOL ? '\n' : ''))
          .join('')
      )
      const fullText = pages.join('\n\n')

      return {
        type: 'pdf',
        fullText,
        sections: this.splitIntoSections(fullText),
        tables: [],
        metadata: {
          pageCount: result.totalPages,
        },
      }
    } catch (error: any) {
      console.error('[FileParser] PDF parse error:', {
        filePath,
        message: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  private async parseDoc(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    try {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const extractor = new WordExtractor()
      const doc = await extractor.extract(filePath)
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const bodyText = doc.getBody()

      return {
        type: 'word',
        fullText: bodyText,
        sections: this.splitIntoSections(bodyText),
        tables: [],
        metadata: {},
      }
    } catch (error: any) {
      console.error('[FileParser] DOC parse error:', {
        filePath,
        message: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  private async parseWord(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    try {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const result = await convert(filePath, {
        preserveLayout: true,
        extractImages: false,
        extractCharts: false,
      })
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

      return {
        type: 'word',
        fullText: result.markdown,
        sections: this.splitIntoSections(result.markdown),
        tables: [],
        metadata: {},
      }
    } catch (error: any) {
      console.warn('[FileParser] DOCX file2md parse failed, falling back to mammoth:', {
        filePath,
        message: error.message,
        code: error.code,
        originalError: error.originalError?.message || error.originalError,
      })

      try {
        if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
        const buffer = await fs.promises.readFile(filePath)
        const result = await (mammoth as any).convertToMarkdown({ buffer })
        if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
        console.info('[FileParser] DOCX mammoth fallback succeeded:', { filePath })

        const rawMarkdown = result.value || ''
        const markdown = rawMarkdown
          .replace(/<a\s+id="[^"]*"><\/a>/g, '')
          .replace(/!\[[^\]]*\]\(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+\)/g, '')
        return {
          type: 'word',
          fullText: markdown,
          sections: this.splitIntoSections(markdown),
          tables: [],
          metadata: { fallbackParser: 'mammoth-markdown' },
        }
      } catch (mammothError: any) {
        console.error('[FileParser] DOCX mammoth fallback also failed:', {
          filePath,
          originalError: error.message,
          mammothError: mammothError.message,
        })
        throw error
      }
    }
  }

  private async parseExcel(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    const ext = path.extname(filePath).toLowerCase()

    if (ext === '.xlsx') {
      try {
        const result = await convert(filePath, {
          preserveLayout: true,
          extractImages: false,
          extractCharts: false,
        })
        if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

        return {
          type: 'excel',
          fullText: result.markdown,
          sections: this.splitIntoSections(result.markdown),
          tables: [],
          metadata: {},
        }
      } catch (error: any) {
        console.warn('[FileParser] XLSX file2md parse failed, falling back to SheetJS:', {
          filePath,
          message: error.message,
          code: error.code,
          originalError: error.originalError?.message || error.originalError,
        })
      }
    }

    const workbook = XLSX.readFile(filePath)
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    let fullText = ''
    const tables: ParseResult['tables'] = []

    for (const sheetName of workbook.SheetNames) {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const sheet = workbook.Sheets[sheetName]
      const csvData = XLSX.utils.sheet_to_csv(sheet)
      fullText += `\n--- Sheet: ${sheetName} ---\n${csvData}`

      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][]
      if (jsonData.length > 0) {
        tables.push({
          headers: (jsonData[0] || []).map(String),
          rows: jsonData.slice(1).map(row => row.map(cell => String(cell || ''))),
          context: `Sheet: ${sheetName}`,
        })
      }
    }

    return {
      type: 'excel',
      fullText: fullText.trim(),
      sections: [],
      tables,
      metadata: { sheetNames: workbook.SheetNames },
    }
  }

  private async parseText(filePath: string, type: string, signal?: AbortSignal): Promise<ParseResult> {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    const content = await fs.promises.readFile(filePath, 'utf-8')
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    return {
      type,
      fullText: content,
      sections: this.splitIntoSections(content),
      tables: [],
      metadata: {},
    }
  }

  private async parsePPTX(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    try {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const result = await convert(filePath, {
        preserveLayout: true,
        extractImages: false,
        extractCharts: false,
      })
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

      return {
        type: 'pptx',
        fullText: result.markdown,
        sections: this.splitIntoSections(result.markdown),
        tables: [],
        metadata: {},
      }
    } catch (error: any) {
      console.error('[FileParser] PPTX parse error:', {
        filePath,
        message: error.message,
        stack: error.stack,
      })
      throw error
    }
  }

  private async parseImage(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    const ocrResult = await this.ocr.recognize(filePath)
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    return {
      type: 'image',
      fullText: ocrResult.text,
      sections: this.splitIntoSections(ocrResult.text),
      tables: [],
      metadata: {
        ocrEngine: ocrResult.engine,
        confidence: ocrResult.confidence,
        blocks: ocrResult.blocks || [],
      },
    }
  }

  private getFileType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    const supportedTypes = ['pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'pptx', 'txt', 'md', 'html', 'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp']
    return supportedTypes.includes(ext) ? ext : 'unknown'
  }

  private splitIntoSections(text: string): ParseResult['sections'] {
    const headingPatterns = [
      /^#{1,6}\s+\S/,
      /^第[一二三四五六七八九十百千\d]+章\s*/,
      /^第[一二三四五六七八九十百千\d]+节\s*/,
      /^\d+\.\d+\s+/,
      /^\d+\.\s+/,
      /^[一二三四五六七八九十]+\、\s*/,
      /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/,
    ]

    const lines = text.split('\n')
    const nonEmptyLines = lines.filter(l => l.trim().length > 0)
    if (nonEmptyLines.length === 0) {
      return text.trim().length > 0 ? [{ title: '全文', content: text, level: 1 }] : []
    }

    let headingCount = 0
    for (const line of nonEmptyLines) {
      const trimmed = line.trim()
      if (trimmed.length < 100 && headingPatterns.some(p => p.test(trimmed))) {
        headingCount++
      }
    }

    if (headingCount / nonEmptyLines.length > 0.3) {
      return [{ title: '全文', content: text, level: 1 }]
    }

    const sections: ParseResult['sections'] = []
    let currentSection: ParseResult['sections'][0] | null = null

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (!trimmedLine) continue

      const isHeading = headingPatterns.some(pattern => pattern.test(trimmedLine))

      if (isHeading && trimmedLine.length < 100) {
        if (currentSection) {
          sections.push(currentSection)
        }

        let level = 2
        const mdMatch = trimmedLine.match(/^(#{1,6})\s/)
        if (mdMatch) {
          level = mdMatch[1].length
        } else if (trimmedLine.startsWith('第')) {
          level = 1
        }

        currentSection = {
          title: trimmedLine,
          content: '',
          level,
        }
      } else if (currentSection) {
        currentSection.content += line + '\n'
      }
    }

    if (currentSection) {
      sections.push(currentSection)
    }

    if (sections.length === 0 && text.trim().length > 0) {
      sections.push({
        title: '全文',
        content: text,
        level: 1,
      })
    }

    return sections
  }

  async parseFilePath(filePath: string, signal?: AbortSignal): Promise<ParseResult> {
    const fileType = this.getFileType(filePath)
    let result: ParseResult

    switch (fileType) {
      case 'pdf':
        result = await this.parsePDF(filePath, signal)
        break
      case 'doc':
        result = await this.parseDoc(filePath, signal)
        break
      case 'docx':
        result = await this.parseWord(filePath, signal)
        break
      case 'xlsx':
      case 'xls':
      case 'csv':
        result = await this.parseExcel(filePath, signal)
        break
      case 'pptx':
        result = await this.parsePPTX(filePath, signal)
        break
      case 'txt':
      case 'md':
      case 'html':
        result = await this.parseText(filePath, fileType, signal)
        break
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'bmp':
      case 'tiff':
      case 'webp':
        result = await this.parseImage(filePath, signal)
        break
      default:
        throw new Error(`Unsupported file type: ${fileType}`)
    }

    return result
  }

}

export default FileParserService
