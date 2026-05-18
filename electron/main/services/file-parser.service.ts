import fs from 'fs'
import path from 'path'
import pdf from 'pdf-parse'
import mammoth from 'mammoth'
import XLSX from 'xlsx'
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

  private async parsePDF(filePath: string): Promise<ParseResult> {
    const dataBuffer = await fs.promises.readFile(filePath)
    const data = await pdf(dataBuffer)

    return {
      type: 'pdf',
      fullText: data.text,
      sections: this.splitIntoSections(data.text),
      tables: [],
      entities: [],
      metadata: {
        pageCount: data.numpages,
        info: data.info,
      },
    }
  }

  private async parseDoc(filePath: string): Promise<ParseResult> {
    try {
      const buffer = await fs.promises.readFile(filePath)
      const result = await mammoth.extractRawText({ buffer })

      return {
        type: 'word',
        fullText: result.value,
        sections: this.splitIntoSections(result.value),
        tables: [],
        entities: [],
        metadata: {},
      }
    } catch (error) {
      throw new Error('.doc 文件格式解析失败，请转换为 .docx 格式后重试')
    }
  }

  private async parseWord(filePath: string): Promise<ParseResult> {
    const buffer = await fs.promises.readFile(filePath)
    const result = await mammoth.extractRawText({ buffer })

    return {
      type: 'word',
      fullText: result.value,
      sections: this.splitIntoSections(result.value),
      tables: [],
      entities: [],
      metadata: {},
    }
  }

  private async parseExcel(filePath: string): Promise<ParseResult> {
    const workbook = XLSX.readFile(filePath)
    let fullText = ''
    const tables: ParseResult['tables'] = []

    for (const sheetName of workbook.SheetNames) {
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
      entities: [],
      metadata: { sheetNames: workbook.SheetNames },
    }
  }

  private async parseText(filePath: string, type: string): Promise<ParseResult> {
    const content = await fs.promises.readFile(filePath, 'utf-8')

    return {
      type,
      fullText: content,
      sections: this.splitIntoSections(content),
      tables: [],
      entities: [],
      metadata: {},
    }
  }

  private async parseImage(filePath: string): Promise<ParseResult> {
    const ocrResult = await this.ocr.recognize(filePath)

    return {
      type: 'image',
      fullText: ocrResult.text,
      sections: this.splitIntoSections(ocrResult.text),
      tables: [],
      entities: [],
      metadata: {
        ocrEngine: ocrResult.engine,
        confidence: ocrResult.confidence,
        blocks: ocrResult.blocks || [],
      },
    }
  }

  private getFileType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase().slice(1)
    const supportedTypes = ['pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'html', 'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp']
    return supportedTypes.includes(ext) ? ext : 'unknown'
  }

  private splitIntoSections(text: string): ParseResult['sections'] {
    const sections: ParseResult['sections'] = []
    const lines = text.split('\n')
    let currentSection: ParseResult['sections'][0] | null = null

    const headingPatterns = [
      /^第[一二三四五六七八九十百千\d]+章\s*/,
      /^第[一二三四五六七八九十百千\d]+节\s*/,
      /^\d+\.\d+\s+/,
      /^\d+\.\s+/,
      /^[一二三四五六七八九十]+\、\s*/,
      /^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/,
    ]

    for (const line of lines) {
      const trimmedLine = line.trim()
      if (!trimmedLine) continue

      const isHeading = headingPatterns.some(pattern => pattern.test(trimmedLine))

      if (isHeading && trimmedLine.length < 100) {
        if (currentSection) {
          sections.push(currentSection)
        }
        currentSection = {
          title: trimmedLine,
          content: '',
          level: trimmedLine.startsWith('第') ? 1 : 2,
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

  async parseFilePath(filePath: string): Promise<ParseResult> {
    const fileType = this.getFileType(filePath)
    let result: ParseResult

    switch (fileType) {
      case 'pdf':
        result = await this.parsePDF(filePath)
        break
      case 'doc':
        result = await this.parseDoc(filePath)
        break
      case 'docx':
        result = await this.parseWord(filePath)
        break
      case 'xlsx':
      case 'xls':
      case 'csv':
        result = await this.parseExcel(filePath)
        break
      case 'txt':
      case 'md':
      case 'html':
        result = await this.parseText(filePath, fileType)
        break
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'bmp':
      case 'tiff':
      case 'webp':
        result = await this.parseImage(filePath)
        break
      default:
        throw new Error(`Unsupported file type: ${fileType}`)
    }

    return result
  }

}

export default FileParserService
