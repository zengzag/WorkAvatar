import fs from 'fs'
import path from 'path'
import { convert } from 'file2md'
import mammoth from 'mammoth'
import WordExtractor from 'word-extractor'
import XLSX from 'xlsx'
import { extractTextItems } from 'unpdf'
import type { ParseResult } from '../../shared/types'
import OCRService from './ocr.service'
import { createLogger } from './logger'

const logger = createLogger('FileParser')

// Excel 解析保护阈值：防止超大/异常 Excel（如单元格散落在 R1048576/XFD 列）导致内存爆炸卡死
const EXCEL_MAX_SHEETS = 50
const EXCEL_MAX_ROWS_PER_SHEET = 10000
const EXCEL_MAX_TOTAL_CELLS = 200000
const EXCEL_MAX_FULL_TEXT_CHARS = 1_000_000

class FileParserService {
  private ocr: OCRService
  private static instance: FileParserService

  private constructor() {
    this.ocr = OCRService.getInstance()
    this.ocr.initialize().catch(err => logger.error('OCR 初始化失败:', err))
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
      logger.error('PDF parse error:', { filePath, message: error.message, stack: error.stack })
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
      logger.error('DOC parse error:', { filePath, message: error.message, stack: error.stack })
      throw error
    }
  }

  private async parseWord(filePath: string, signal?: AbortSignal, tier?: 'hot' | 'cold'): Promise<ParseResult> {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    // 热数据使用 file2md 解析（保留布局和格式），冷数据使用 mammoth 快速解析
    if (tier === 'hot') {
      const result = await convert(filePath, {
        preserveLayout: true,
        extractImages: false,
        extractCharts: false,
        maxMemoryUsage: 4 * 1024 * 1024 * 1024,
      })
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      return {
        type: 'word',
        fullText: result.markdown,
        sections: this.splitIntoSections(result.markdown),
        tables: [],
        metadata: { parser: 'file2md' },
      }
    }

    // 冷数据：mammoth 快速纯文本提取
    const buffer = await fs.promises.readFile(filePath)
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    const result = await mammoth.extractRawText({ buffer })
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    const fullText = (result.value || '').replace(/\n{3,}/g, '\n\n')

    return {
      type: 'word',
      fullText,
      sections: this.splitIntoSections(fullText),
      tables: [],
      metadata: { parser: 'mammoth' },
    }
  }

  private async parseExcel(filePath: string, signal?: AbortSignal, _tier?: 'hot' | 'cold'): Promise<ParseResult> {
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    // Excel 统一使用 SheetJS 解析。
    // file2md 的 xlsx-parser 会按行号/列号直接索引创建整行/整列空对象数组，
    // 当单元格散落在 R1048576/XFD 等高编号位置时会导致百万级空对象数组，内存爆炸卡死。
    // Excel 为表格数据，SheetJS 的值提取已足够用于搜索索引，无需保留复杂格式。
    const workbook = XLSX.readFile(filePath, {
      cellStyles: false,
      cellHTML: false,
      cellFormula: false,
      sheetStubs: false,
    })
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    let fullText = ''
    const tables: ParseResult['tables'] = []
    let totalCells = 0

    const sheetNames = workbook.SheetNames.slice(0, EXCEL_MAX_SHEETS)
    for (const sheetName of sheetNames) {
      if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue

      // 一次遍历同时用于 fullText 和 tables，避免 sheet_to_csv + sheet_to_json 重复遍历
      // raw: false 返回格式化文本（日期/数字按显示格式），避免 Date 对象序列化问题
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
        raw: false,
      }) as any[][]
      if (rows.length === 0) continue

      const limitedRows = rows.slice(0, EXCEL_MAX_ROWS_PER_SHEET)
      const csvLines: string[] = []
      const tableRows: string[][] = []
      for (const row of limitedRows) {
        if (!Array.isArray(row)) continue
        const cells = row.map(cell => (cell == null ? '' : String(cell)))
        csvLines.push(cells.join('\t'))
        tableRows.push(cells)
        totalCells += cells.length
        if (totalCells > EXCEL_MAX_TOTAL_CELLS) break
      }

      fullText += `\n--- Sheet: ${sheetName} ---\n${csvLines.join('\n')}\n`

      if (tableRows.length > 0) {
        tables.push({
          headers: tableRows[0].map(String),
          rows: tableRows.slice(1),
          context: `Sheet: ${sheetName}`,
        })
      }

      if (totalCells > EXCEL_MAX_TOTAL_CELLS || fullText.length > EXCEL_MAX_FULL_TEXT_CHARS) break
    }

    if (fullText.length > EXCEL_MAX_FULL_TEXT_CHARS) {
      fullText = fullText.substring(0, EXCEL_MAX_FULL_TEXT_CHARS)
    }

    return {
      type: 'excel',
      fullText: fullText.trim(),
      sections: [],
      tables,
      metadata: { sheetNames, parser: 'sheetjs' },
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
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')
    const result = await convert(filePath, {
      preserveLayout: true,
      extractImages: false,
      extractCharts: false,
      maxMemoryUsage: 4 * 1024 * 1024 * 1024,
    })
    if (signal?.aborted) throw new DOMException('Parse cancelled', 'AbortError')

    return {
      type: 'pptx',
      fullText: result.markdown,
      sections: this.splitIntoSections(result.markdown),
      tables: [],
      metadata: { parser: 'file2md' },
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

  async parseFilePath(filePath: string, signal?: AbortSignal, tier?: 'hot' | 'cold'): Promise<ParseResult> {
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
        result = await this.parseWord(filePath, signal, tier)
        break
      case 'xlsx':
      case 'xls':
      case 'csv':
        result = await this.parseExcel(filePath, signal, tier)
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
