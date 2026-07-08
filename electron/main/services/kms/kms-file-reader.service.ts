import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import FileParserService from '../file-parser.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-FileReader')

class KMSFileReaderService {
  private db: Database.Database
  private static instance: KMSFileReaderService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSFileReaderService {
    if (!KMSFileReaderService.instance) {
      KMSFileReaderService.instance = new KMSFileReaderService()
    }
    return KMSFileReaderService.instance
  }

  scanDirFiles(dirPath: string, extensions?: string[]): { files: string[]; skipped: number } {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { files: [], skipped: 0 }
    }
    const supportedExts = (extensions && extensions.length > 0
      ? extensions
      : ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'html', 'htm']
    ).map(e => e.toLowerCase().replace(/^\./, ''))
    const result: string[] = []
    let skipped = 0
    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '')
          if (supportedExts.includes(ext)) {
            result.push(fullPath)
          } else {
            skipped++
          }
        }
      }
    }
    walk(dirPath)
    logger.info(`scanDirFiles: ${dirPath} -> ${result.length} files, ${skipped} skipped`)
    return { files: result, skipped }
  }

  getFileParagraphs(fileId: string): any[] {
    return this.db.prepare(`
      SELECT id, title, title_path, level, paragraph_index, start_offset, end_offset, summary, keywords_json
      FROM kms_paragraphs
      WHERE file_id = ?
      ORDER BY paragraph_index ASC
    `).all(fileId) as any[]
  }

  getParagraphContent(paragraphId: string): { id: string; title: string; title_path: string; level: number; paragraph_index: number; content: string; summary: string | null; keywords_json: string | null; file_id: string } | null {
    return this.db.prepare(`
      SELECT id, title, title_path, level, paragraph_index, content, summary, keywords_json, file_id
      FROM kms_paragraphs
      WHERE id = ?
    `).get(paragraphId) as any || null
  }

  getFileToc(fileId: string): any[] {
    const paragraphs = this.db.prepare(`
      SELECT id, title, title_path, level, paragraph_index, start_offset, end_offset
      FROM kms_paragraphs
      WHERE file_id = ?
      ORDER BY paragraph_index ASC
    `).all(fileId) as any[]
    return paragraphs.map(p => ({
      id: p.id,
      title: p.title,
      titlePath: p.title_path,
      level: p.level,
      paragraphIndex: p.paragraph_index,
      startOffset: p.start_offset,
      endOffset: p.end_offset,
    }))
  }

  getParagraphsByIds(paragraphIds: string[]): any[] {
    if (!paragraphIds || paragraphIds.length === 0) return []
    const placeholders = paragraphIds.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT p.id, p.title, p.title_path, p.level, p.paragraph_index,
             p.start_offset, p.end_offset, p.summary, p.keywords_json,
             p.file_id,
             (SELECT file_name FROM kms_files WHERE id = p.file_id) as file_name
      FROM kms_paragraphs p
      WHERE p.id IN (${placeholders})
      ORDER BY p.file_id, p.paragraph_index
    `).all(...paragraphIds) as any[]
  }

  /**
   * 获取热数据文件已存储的完整文本内容。
   *
   * 热数据文件在 processHotFile 流程中将 LLM 切分后的段落原文写入 kms_paragraphs.content，
   * 因此可以直接从数据库读取，无需重新解析文件（file2md 较慢）。
   *
   * 冷数据文件没有 kms_paragraphs 记录（仅在 kms_search_index 中存截断的 500 字符），
   * 此时返回 null，调用方需重新解析文件。
   *
   * @return 拼接后的完整文本；若无段落记录则返回 null
   */
  getStoredFullContent(fileId: string): string | null {
    const rows = this.db.prepare(
      'SELECT content FROM kms_paragraphs WHERE file_id = ? AND content != \'\' ORDER BY paragraph_index ASC'
    ).all(fileId) as any[]
    if (rows.length === 0) return null
    return rows.map(r => r.content).join('\n\n')
  }

  /**
   * 读取索引时保存的解析模式，用于决定重新解析时使用 file2md（hot）还是普通解析器（cold）
   */
  private getStoredParseMode(fileId: string): string | undefined {
    const row = this.db.prepare('SELECT parse_mode FROM kms_file_summaries WHERE file_id = ?').get(fileId) as any
    return row?.parse_mode || undefined
  }

  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    if (options?.paragraphId) {
      const paragraph = this.db.prepare('SELECT content FROM kms_paragraphs WHERE id = ? AND file_id = ?').get(options.paragraphId, fileId) as any
      if (paragraph) return paragraph.content
    }

    const maxChars = options?.maxChars || 5000
    try {
      // 优先使用已存储的段落内容（热数据），避免重新解析文件
      // 冷数据没有段落记录，回退到重新解析
      let content = this.getStoredFullContent(fileId)
      if (content === null) {
        const parseMode = this.getStoredParseMode(fileId)
        const parseResult = await FileParserService.getInstance().parseFilePath(
          file.file_path,
          undefined,
          parseMode === 'file2md' ? 'hot' : 'cold',
        )
        content = parseResult.fullText
      }

      if (options?.startOffset !== undefined && options?.endOffset !== undefined) {
        content = content.substring(options.startOffset, options.endOffset)
      } else if (options?.startLine !== undefined) {
        const lines = content.split('\n')
        content = lines.slice(options.startLine - 1, options.startLine + 50).join('\n')
      }

      return content.substring(0, maxChars)
    } catch (err) {
      logger.error(`Failed to read file content for ${file.file_path}:`, err)
      throw err
    }
  }

  getFileSummary(fileId: string): any {
    const summary = this.db.prepare('SELECT * FROM kms_file_summaries WHERE file_id = ?').get(fileId)
    if (!summary) return null

    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'summary_view')

    return summary
  }

  async getFileFullContent(fileId: string): Promise<{ content: string; fileName: string; filePath: string; truncated: boolean }> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    // 字符上限：约 20MB 文本
    const MAX_CONTENT_CHARS = 20_000_000

    try {
      // 优先使用已存储的段落内容（热数据），避免重新解析文件
      let fullText = this.getStoredFullContent(fileId)
      if (fullText === null) {
        // 冷数据：读取索引时保存的解析模式，确保预览与索引使用相同解析器
        const parseMode = this.getStoredParseMode(fileId)

        const parseResult = await FileParserService.getInstance().parseFilePath(
          file.file_path,
          undefined, // signal
          parseMode === 'file2md' ? 'hot' : 'cold', // file2md 对应 hot 路径
        )
        fullText = parseResult.fullText || ''
      }

      const truncated = fullText.length > MAX_CONTENT_CHARS
      return {
        content: truncated ? fullText.substring(0, MAX_CONTENT_CHARS) : fullText,
        fileName: file.file_name,
        filePath: file.file_path,
        truncated,
      }
    } catch (err) {
      logger.error(`Failed to read file content for ${file.file_path}:`, err)
      throw err
    }
  }
}

export default KMSFileReaderService
