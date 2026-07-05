import type Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import FileParserService from '../file-parser.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-FileReader')

/**
 * KMS 文件读取服务
 * 负责文件与段落级别的读取操作：目录扫描、段落列表/内容/TOC 查询、
 * 文件内容按段落/偏移/行号定位读取、文件摘要获取、文件全文预览。
 *
 * 从原 KMSService 中抽离，保持 SQL 与行为一致。
 */
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

  /**
   * 扫描目录下所有支持格式的文件（递归），用于"文件夹批量导入到合集"
   * 返回 { files: string[], skipped: number }
   */
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

  /**
   * 获取文件的段落列表（用于前端内容浏览）
   * 返回段落的目录树结构（TOC）+ 完整段落列表
   */
  getFileParagraphs(fileId: string): any[] {
    return this.db.prepare(`
      SELECT id, title, title_path, level, paragraph_index, start_offset, end_offset, summary, keywords_json
      FROM kms_paragraphs
      WHERE file_id = ?
      ORDER BY paragraph_index ASC
    `).all(fileId) as any[]
  }

  /**
   * 获取单个段落的完整内容（含原文，用于预览）
   */
  getParagraphContent(paragraphId: string): { id: string; title: string; title_path: string; level: number; paragraph_index: number; content: string; summary: string | null; keywords_json: string | null; file_id: string } | null {
    return this.db.prepare(`
      SELECT id, title, title_path, level, paragraph_index, content, summary, keywords_json, file_id
      FROM kms_paragraphs
      WHERE id = ?
    `).get(paragraphId) as any || null
  }

  /**
   * 获取文件的目录结构（TOC，从段落表的 title_path 派生）
   */
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

  /**
   * 按段落ID批量查询段落详情（含所属文件名）
   * 用于 Agent 工具 kms_get_paragraphs
   */
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
   * 获取文件内容（按段落/偏移/行号定位）
   */
  async getFileContent(fileId: string, options?: { paragraphId?: string; startOffset?: number; endOffset?: number; startLine?: number; maxChars?: number }): Promise<string> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    // 文件存在后再记录访问日志（避免外键约束失败）
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    // 如果指定了段落ID，从段落表获取
    if (options?.paragraphId) {
      const paragraph = this.db.prepare('SELECT content FROM kms_paragraphs WHERE id = ? AND file_id = ?').get(options.paragraphId, fileId) as any
      if (paragraph) return paragraph.content
    }

    // 否则重新解析文件获取原文
    const maxChars = options?.maxChars || 5000
    try {
      const parseResult = await FileParserService.getInstance().parseFilePath(file.file_path)
      let content = parseResult.fullText

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

  /**
   * 获取文件摘要
   */
  getFileSummary(fileId: string): any {
    const summary = this.db.prepare('SELECT * FROM kms_file_summaries WHERE file_id = ?').get(fileId)
    if (!summary) return null

    // 摘要存在后再记录访问日志（避免外键约束失败）
    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'summary_view')

    return summary
  }

  /**
   * 获取文件完整文本内容（用于预览）
   * 添加字符上限避免超大文件一次性载入内存导致 OOM
   */
  async getFileFullContent(fileId: string): Promise<{ content: string; fileName: string; filePath: string; truncated: boolean }> {
    const file = this.db.prepare('SELECT * FROM kms_files WHERE id = ?').get(fileId) as any
    if (!file) throw new Error('File not found')

    const crawler = KMSCrawlerService.getInstance()
    crawler.logFileAccess(fileId, 'read')

    // 字符上限：约 5MB 文本，超过则截断并标记 truncated，前端可提示分段加载
    const MAX_CONTENT_CHARS = 5_000_000

    try {
      const parseResult = await FileParserService.getInstance().parseFilePath(file.file_path)
      const fullText = parseResult.fullText || ''
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
