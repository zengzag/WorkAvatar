import fs from 'fs'
import path from 'path'
import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'
import FileParserService from './file-parser.service'
import KnowledgeProcessorService from './knowledge-processor.service'
import ParseTaskManager from './parse-task-manager.service'
import TaskQueueService from './task-queue.service'
import SearchEngineService from './search-engine.service'
import LLMClientService from './llm-client.service'
import PathService from './path.service'
import type { SearchResult } from './search-engine.service'
import { calculateFileHash, getDefaultProviderId, generateId } from './common-utils'
import type Database from 'better-sqlite3'
import type { DBKBDocument, DBKBDocumentSummary, DBKBChapter, DBKBEntity, DBProject } from '../../shared/db-types'

export interface KBDocumentServiceDeps {
  db: Database.Database
  mainDb: DatabaseService
  kbDb: KBDatabaseService
  fileParser: FileParserService
  processor: KnowledgeProcessorService
  parseTaskManager: ParseTaskManager
  taskQueue: TaskQueueService
  searchEngine: SearchEngineService
  llmClient: LLMClientService
  ensureDefaultKB: () => string
}

class KBDocumentService {
  private db: Database.Database
  private mainDb: DatabaseService
  private fileParser: FileParserService
  private processor: KnowledgeProcessorService
  private parseTaskManager: ParseTaskManager
  private taskQueue: TaskQueueService
  private searchEngine: SearchEngineService
  private llmClient: LLMClientService
  private ensureDefaultKBCallback: () => string

  private readonly SUPPORTED_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv',
    'txt', 'md', 'html', 'htm',
    'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp',
  ])

  constructor(deps: KBDocumentServiceDeps) {
    this.db = deps.db
    this.mainDb = deps.mainDb
    this.fileParser = deps.fileParser
    this.processor = deps.processor
    this.parseTaskManager = deps.parseTaskManager
    this.taskQueue = deps.taskQueue
    this.searchEngine = deps.searchEngine
    this.llmClient = deps.llmClient
    this.ensureDefaultKBCallback = deps.ensureDefaultKB
  }

  private getKBBasePath(kbId: string): string {
    return PathService.getInstance().getKBBasePath(kbId)
  }

  private getDocParseDir(docId: string, kbId: string): string {
    const dir = path.join(this.getKBBasePath(kbId), '_parsed', docId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  private saveDocParsedJson(docId: string, kbId: string, parsedJson: string): string {
    const dir = this.getDocParseDir(docId, kbId)
    const parsedJsonPath = path.join(dir, 'parsed.json')
    fs.writeFileSync(parsedJsonPath, parsedJson, 'utf-8')
    return parsedJsonPath
  }

  readDocContentFromParsedJson(parsedJsonPath: string): string | null {
    if (!parsedJsonPath || !fs.existsSync(parsedJsonPath)) return null
    try {
      const raw = fs.readFileSync(parsedJsonPath, 'utf-8')
      const parsed = JSON.parse(raw)
      return parsed.fullText || null
    } catch {
      return null
    }
  }

  readDocParsedJson(parsedJsonPath: string): string | null {
    if (!parsedJsonPath || !fs.existsSync(parsedJsonPath)) return null
    try {
      return fs.readFileSync(parsedJsonPath, 'utf-8')
    } catch {
      return null
    }
  }

  private deleteDocParseDir(docId: string, kbId: string): void {
    const dir = path.join(this.getKBBasePath(kbId), '_parsed', docId)
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  }

  private getDefaultProviderId(): string | null {
    return getDefaultProviderId(this.mainDb)
  }

  async getExistingDocByHash(hash: string, kbId?: string): Promise<DBKBDocument | null> {
    if (kbId) {
      const sameKB = this.db.prepare(
        'SELECT * FROM kb_documents WHERE hash = ? AND kb_id = ? LIMIT 1'
      ).get(hash, kbId) as DBKBDocument | undefined
      if (sameKB) return sameKB
    }
    return this.db.prepare(
      'SELECT * FROM kb_documents WHERE hash = ? AND parse_status = ? LIMIT 1'
    ).get(hash, 'completed') as DBKBDocument | undefined || null
  }

  async getExistingDocByName(kbId: string, originalName: string): Promise<DBKBDocument | null> {
    return this.db.prepare(
      'SELECT * FROM kb_documents WHERE kb_id = ? AND original_name = ? LIMIT 1'
    ).get(kbId, originalName) as DBKBDocument | undefined || null
  }

  async scanFolder(folderPath: string): Promise<{
    supported: Array<{ path: string; name: string; ext: string; size: number }>;
    unsupported: Array<{ path: string; name: string; ext: string }>;
    total: number;
  }> {
    const supported: Array<{ path: string; name: string; ext: string; size: number }> = []
    const unsupported: Array<{ path: string; name: string; ext: string }> = []

    const scanDir = async (dirPath: string) => {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await scanDir(fullPath)
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase().slice(1)
          if (this.SUPPORTED_EXTENSIONS.has(ext)) {
            try {
              const stats = await fs.promises.stat(fullPath)
              supported.push({ path: fullPath, name: entry.name, ext, size: stats.size })
            } catch {}
          } else if (ext) {
            unsupported.push({ path: fullPath, name: entry.name, ext })
          }
        }
      }
    }

    await scanDir(folderPath)
    return { supported, unsupported, total: supported.length + unsupported.length }
  }

  async uploadDocuments(
    kbId: string,
    filePaths: string[],
    onProgress?: (current: number, total: number, fileName: string) => void
  ): Promise<{ imported: any[]; errors: Array<{ path: string; error: string }> }> {
    const kbBasePath = this.getKBBasePath(kbId)
    const imported: any[] = []
    const errors: Array<{ path: string; error: string }> = []
    const total = filePaths.length

    for (let i = 0; i < filePaths.length; i++) {
      const filePath = filePaths[i]
      try {
        const stats = await fs.promises.stat(filePath)
        const originalName = path.basename(filePath)
        const fileType = path.extname(filePath).toLowerCase().slice(1)
        const fileHash = await calculateFileHash(filePath)

        onProgress?.(i + 1, total, originalName)

        const existingDoc = await this.getExistingDocByHash(fileHash, kbId)
        if (existingDoc) {
          if (existingDoc.kb_id === kbId) {
            this.db.prepare(
              "UPDATE kb_documents SET is_reused = 1, updated_at = unixepoch() WHERE id = ?"
            ).run(existingDoc.id)
            imported.push({
              id: existingDoc.id,
              original_name: originalName,
              type: fileType,
              size: stats.size,
              hash: fileHash,
              parse_status: existingDoc.parse_status,
              skipped: true,
            })
            continue
          }

          const existingByName = await this.getExistingDocByName(kbId, originalName)
          if (existingByName) {
            const parsedJsonPath = existingDoc.parsed_json_path || null
            this.db.prepare(`
              UPDATE kb_documents SET hash = ?, size = ?,
                  parsed_json_path = ?,
                  parse_status = 'completed', is_reused = 1, updated_at = unixepoch()
              WHERE id = ?
            `).run(fileHash, stats.size, parsedJsonPath, existingByName.id)

            this.searchEngine.indexDocumentTitle(kbId, existingByName.id, originalName)
            if (parsedJsonPath) {
              const content = this.readDocContentFromParsedJson(parsedJsonPath)
              if (content) {
                this.searchEngine.indexContentParagraphs(kbId, existingByName.id, content, originalName)
              }
            }

            imported.push({
              id: existingByName.id,
              original_name: originalName,
              type: fileType,
              size: stats.size,
              hash: fileHash,
              parse_status: 'completed',
              reused: true,
              updated: true,
            })
            continue
          }
          const docId = generateId()
          const now = Math.floor(Date.now() / 1000)
          const parsedJsonPath = existingDoc.parsed_json_path || null
          this.db.prepare(`
            INSERT INTO kb_documents (id, kb_id, file_id, original_name, type, size, hash, parsed_json_path, parse_status, is_reused, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(docId, kbId, existingDoc.file_id, originalName, fileType, stats.size, fileHash,
            parsedJsonPath, 'completed', 1, now, now)

          this.searchEngine.indexDocumentTitle(kbId, docId, originalName)
          if (parsedJsonPath) {
            const content = this.readDocContentFromParsedJson(parsedJsonPath)
            if (content) {
              this.searchEngine.indexContentParagraphs(kbId, docId, content, originalName)
            }
          }

          imported.push({
            id: docId,
            original_name: originalName,
            type: fileType,
            size: stats.size,
            hash: fileHash,
            parse_status: 'completed',
            reused: true,
          })
          continue
        }

        const destPath = path.join(kbBasePath, originalName)
        await fs.promises.copyFile(filePath, destPath)

        const docId = generateId()
        const now = Math.floor(Date.now() / 1000)

        this.db.prepare(`
          INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, parse_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(docId, kbId, originalName, fileType, stats.size, fileHash, now, now)

        this.searchEngine.indexDocumentTitle(kbId, docId, originalName)

        imported.push({
          id: docId,
          path: destPath,
          original_name: originalName,
          type: fileType,
          size: stats.size,
          hash: fileHash,
          parse_status: 'pending',
        })
      } catch (error) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return { imported, errors }
  }

  async parseDocument(
    docId: string,
    isResume: boolean = false,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
    if (!doc) {
      return { success: false, error: 'Document not found' }
    }

    const kbBasePath = this.getKBBasePath(doc.kb_id)
    const filePath = path.join(kbBasePath, doc.original_name)

    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }

    if (isResume) {
      this.parseTaskManager.resumeOrCreateTask(docId, doc.kb_id, doc.original_name)
    } else {
      this.parseTaskManager.createTask(docId, doc.kb_id, doc.original_name)
    }

    try {
      this.parseTaskManager.updateProgress(docId, {
        stage: 'reading',
        stageLabel: 'Reading',
        progress: 5,
        detail: `Reading: ${doc.original_name}`,
      })
      onProgress?.('reading', `Reading: ${doc.original_name}`)

      if (await this.parseTaskManager.checkPaused(docId)) {
        return { success: false, error: 'Cancelled' }
      }

      this.parseTaskManager.updateProgress(docId, {
        stage: 'parsing',
        stageLabel: 'Parsing',
        progress: 10,
        detail: `Parsing: ${doc.original_name}`,
      })
      onProgress?.('parsing', `Parsing: ${doc.original_name}`)

      const parseResult = await this.fileParser.parseFilePath(filePath)

      if (await this.parseTaskManager.checkPaused(docId)) {
        return { success: false, error: 'Cancelled' }
      }

      const totalPages = parseResult.metadata?.pageCount || 0
      const totalChunks = parseResult.sections?.length || 0
      const processedPages = totalPages
      const processedChunks = totalChunks

      this.parseTaskManager.updateProgress(docId, {
        stage: 'chunking',
        stageLabel: 'Chunking',
        progress: 70,
        detail: `Identified ${totalChunks} sections/chunks`,
        processedPages,
        totalPages,
        processedChunks,
        totalChunks,
      })
      onProgress?.('chunking', `Chunking: ${totalChunks} sections`)

      if (await this.parseTaskManager.checkPaused(docId)) {
        return { success: false, error: 'Cancelled' }
      }

      this.parseTaskManager.updateProgress(docId, {
        stage: 'saving',
        stageLabel: 'Saving',
        progress: 90,
        detail: 'Saving parse results...',
      })
      onProgress?.('saving', 'Saving parse results...')

      const parsedJson = JSON.stringify(parseResult)

      const parsedJsonPath = this.saveDocParsedJson(docId, doc.kb_id, parsedJson)

      this.db.prepare(`
        UPDATE kb_documents 
        SET parse_status = 'completed',
            parsed_json_path = ?,
            parse_progress = 100, parse_stage = 'done', parse_detail = 'Parse completed',
            processed_pages = ?, total_pages = ?, processed_chunks = ?, total_chunks = ?,
            updated_at = unixepoch()
        WHERE id = ?
      `).run(parsedJsonPath, processedPages, totalPages, processedChunks, totalChunks, docId)

      this.searchEngine.indexDocumentTitle(doc.kb_id, docId, doc.original_name)
      const content = this.readDocContentFromParsedJson(parsedJsonPath)
      if (content) {
        this.searchEngine.indexContentParagraphs(doc.kb_id, docId, content, doc.original_name)
      }

      this.parseTaskManager.completeTask(docId)
      onProgress?.('done', 'Parse completed')
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.parseTaskManager.failTask(docId, errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async parseAllDocuments(
    kbId: string,
    onProgress?: (current: number, total: number, docName: string) => void
  ): Promise<{ success: number; failed: number }> {
    const docs = this.db.prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status IN ('pending', 'failed')"
    ).all(kbId) as DBKBDocument[]

    let successCount = 0
    let failedCount = 0

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      onProgress?.(i + 1, docs.length, doc.original_name)

      const kbBasePath = this.getKBBasePath(kbId)
      const filePath = path.join(kbBasePath, doc.original_name)
      if (!fs.existsSync(filePath)) {
        failedCount++
        continue
      }

      const result = await this.parseDocument(doc.id, false, (_stage, detail) => {
        onProgress?.(i + 1, docs.length, `${doc.original_name} - ${detail}`)
      })

      if (result.success) {
        successCount++
      } else {
        failedCount++
      }
    }

    return { success: successCount, failed: failedCount }
  }

  async processDocument(
    docId: string,
    providerId?: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
    if (!doc) {
      return { success: false, error: '文档不存在' }
    }

    if (doc.parse_status !== 'completed') {
      return { success: false, error: 'Document not parsed yet' }
    }

    const kbId = doc.kb_id
    const provider = providerId || this.getDefaultProviderId()
    if (!provider) {
      return { success: false, error: 'LLM provider not configured' }
    }

    const jobId = this.processor.createProcessingJob(kbId, docId, 'full_process', 4)
    const taskId = `process-${docId}`

    this.taskQueue.addTask({
      id: taskId,
      type: 'process',
      title: `Knowledge Processing: ${doc.original_name}`,
      status: 'running',
      progress: 0,
      progressText: 'Starting process...',
      createdAt: Date.now(),
      metadata: { docId, kbId, docName: doc.original_name },
    })

    try {
      this.processor.updateProcessingJob(jobId, 'running', 0, 'chapter_identify')
      onProgress?.('chapter_identify', `Identifying document structure: ${doc.original_name}`)
      this.taskQueue.updateTask(taskId, { progress: 10, progressText: `Chapter identify: ${doc.original_name}` })

      const text = this.getDocumentContent(docId) || ''
      const chapters = this.processor.identifyChapters(text)

      this.processor.updateProcessingJob(jobId, 'running', 1, 'chapter_summary')
      const chapterSummaries = []
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i]
        const progressPercent = 10 + Math.round((i + 1) / chapters.length * 40)
        onProgress?.('chapter_summary', `Generating chapter summary (${i + 1}/${chapters.length}): ${chapter.title}`)
        this.taskQueue.updateTask(taskId, { progress: progressPercent, progressText: `Chapter summary (${i + 1}/${chapters.length}): ${chapter.title}` })
        const summary = await this.processor.generateChapterSummary(
          chapter.content, chapter.title, provider, modelId, enableThinking, onProgress
        )
        chapterSummaries.push(summary)
      }

      this.processor.saveChapters(kbId, docId, chapters, chapterSummaries)

      this.processor.updateProcessingJob(jobId, 'running', 2, 'doc_summary')
      this.taskQueue.updateTask(taskId, { progress: 60, progressText: `Doc summary: ${doc.original_name}` })
      const docSummary = await this.processor.generateDocumentSummary(
        chapterSummaries, doc.original_name, provider, modelId, enableThinking, onProgress
      )
      this.processor.saveDocumentSummary(kbId, docId, docSummary)

      this.processor.updateProcessingJob(jobId, 'running', 3, 'entity_extract')
      this.taskQueue.updateTask(taskId, { progress: 80, progressText: `Entity extract: ${doc.original_name}` })
      const entityText = chapterSummaries.map(cs =>
        `## ${cs.title}\n${cs.summary}\n实体: ${cs.entities.map((e: { name: string; type: string }) => `${e.name}(${e.type})`).join(', ')}`
      ).join('\n\n')
      const extraction = await this.processor.extractEntities(
        entityText, doc.original_name, provider, modelId, enableThinking, onProgress
      )
      this.processor.saveEntities(kbId, docId, extraction)

      this.processor.updateProcessingJob(jobId, 'completed', 4, 'complete')
      onProgress?.('complete', `Document processing completed: ${doc.original_name}`)
      this.taskQueue.updateTask(taskId, { status: 'completed', progress: 100, progressText: `Processing completed: ${doc.original_name}` })

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.processor.updateProcessingJob(jobId, 'failed', undefined, undefined, errorMessage)
      this.taskQueue.updateTask(taskId, { status: 'failed', error: errorMessage, progressText: `Failed: ${errorMessage}` })
      return { success: false, error: errorMessage }
    }
  }

  async processAllDocuments(
    kbId: string,
    providerId?: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: number; failed: number; skipped: number }> {
    const docs = this.db.prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'"
    ).all(kbId) as DBKBDocument[]

    const toProcess = docs.filter(doc => !this.processor.getDocumentSummary(doc.id))
    const taskId = `process-all-${kbId}`

    if (toProcess.length > 0) {
      this.taskQueue.addTask({
        id: taskId,
        type: 'process',
        title: `Batch Knowledge Processing (${toProcess.length} docs)`,
        status: 'running',
        progress: 0,
        progressText: 'Starting batch processing...',
        createdAt: Date.now(),
        metadata: { kbId },
      })
    }

    let successCount = 0
    let failedCount = 0
    let skippedCount = docs.length - toProcess.length

    for (let i = 0; i < toProcess.length; i++) {
      const doc = toProcess[i]
      const progressPercent = Math.round((i / toProcess.length) * 100)
      onProgress?.('processing_docs', `Processing doc ${i + 1}/${toProcess.length}: ${doc.original_name}`)
      this.taskQueue.updateTask(taskId, { progress: progressPercent, progressText: `Processing (${i + 1}/${toProcess.length}): ${doc.original_name}` })

      const result = await this.processDocument(doc.id, providerId, modelId, enableThinking, onProgress)

      if (result.success) {
        successCount++
      } else {
        failedCount++
      }
    }

    if (toProcess.length > 0) {
      this.taskQueue.updateTask(taskId, { status: 'completed', progress: 100, progressText: `Batch processing complete: ${successCount} success, ${failedCount} failed` })
    }

    return { success: successCount, failed: failedCount, skipped: skippedCount }
  }

  deleteDocument(docId: string): boolean {
    const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
    if (doc) {
      this.searchEngine.deleteIndexByDocument(docId)
      this.processor.deleteKnowledgeData(doc.kb_id, docId)
      this.deleteDocParseDir(docId, doc.kb_id)
      const kbBasePath = this.getKBBasePath(doc.kb_id)
      const filePath = path.join(kbBasePath, doc.original_name)
      try { fs.unlinkSync(filePath) } catch {}
    }
    const result = this.db.prepare('DELETE FROM kb_documents WHERE id = ?').run(docId)
    return result.changes > 0
  }

  getDocumentList(kbId: string, status?: string): DBKBDocument[] {
    let query = 'SELECT * FROM kb_documents WHERE kb_id = ?'
    const params: (string | number)[] = [kbId]
    if (status) {
      query += ' AND parse_status = ?'
      params.push(status)
    }
    query += ' ORDER BY created_at DESC'
    return this.db.prepare(query).all(...params) as DBKBDocument[]
  }

  linkProject(kbId: string, projectId: string): boolean {
    const existing = this.db.prepare(
      'SELECT id FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
    ).get(kbId, projectId)

    if (existing) return true

    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.prepare(
      'INSERT INTO kb_project_links (id, kb_id, project_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, kbId, projectId, now)
    return true
  }

  unlinkProject(kbId: string, projectId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
    ).run(kbId, projectId)
    return result.changes > 0
  }

  getLinkedProjects(kbId: string): DBProject[] {
    const links = this.db.prepare(
      'SELECT project_id FROM kb_project_links WHERE kb_id = ?'
    ).all(kbId) as { project_id: string }[]
    if (links.length === 0) return []
    const projectIds = links.map(l => l.project_id)
    const placeholders = projectIds.map(() => '?').join(',')
    return this.mainDb.getDb().prepare(
      `SELECT * FROM projects WHERE id IN (${placeholders})`
    ).all(...projectIds) as DBProject[]
  }

  getKBsForProject(projectId: string): any[] {
    return this.db.prepare(`
      SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
      FROM knowledge_bases kb
      INNER JOIN kb_project_links l ON kb.id = l.kb_id
      WHERE l.project_id = ?
      ORDER BY kb.name
    `).all(projectId)
  }

  getDocumentContent(docId: string): string | null {
    const doc = this.db.prepare('SELECT parsed_json_path FROM kb_documents WHERE id = ?').get(docId) as Pick<DBKBDocument, 'parsed_json_path'> | undefined
    if (!doc?.parsed_json_path) return null
    return this.readDocContentFromParsedJson(doc.parsed_json_path)
  }

  getParsedJson(docId: string): string | null {
    const doc = this.db.prepare('SELECT parsed_json_path FROM kb_documents WHERE id = ?').get(docId) as Pick<DBKBDocument, 'parsed_json_path'> | undefined
    if (!doc?.parsed_json_path) return null
    return this.readDocParsedJson(doc.parsed_json_path)
  }

  async importOrSyncToKB(
    filePath: string,
    projectId?: string,
    options?: { contentText?: string; parsedJson?: string }
  ): Promise<{ kbDocId: string | null; reused: boolean; kbId: string }> {
    const kbId = this.ensureDefaultKBCallback()
    if (projectId) this.linkProject(kbId, projectId)

    try {
      const stats = await fs.promises.stat(filePath)
      const originalName = path.basename(filePath)
      const fileType = path.extname(filePath).toLowerCase().slice(1)
      const fileHash = options?.contentText
        ? require('crypto').createHash('sha256').update(options.contentText).digest('hex')
        : await calculateFileHash(filePath)

      const existingDoc = await this.getExistingDocByHash(fileHash, kbId)
      if (existingDoc) {
        if (existingDoc.kb_id === kbId) {
          return { kbDocId: existingDoc.id, reused: true, kbId }
        }

        const existingByName = await this.getExistingDocByName(kbId, originalName)
        if (existingByName) {
          const parsedJsonPath = existingDoc.parsed_json_path || null
          this.db.prepare(`
            UPDATE kb_documents SET hash = ?, size = ?,
                parsed_json_path = ?,
                parse_status = 'completed', updated_at = unixepoch()
            WHERE id = ?
          `).run(fileHash, stats.size, parsedJsonPath, existingByName.id)
          return { kbDocId: existingByName.id, reused: true, kbId }
        }
      }

      const destPath = path.join(this.getKBBasePath(kbId), originalName)
      if (options?.contentText) {
        fs.writeFileSync(destPath, '', 'utf-8')
      } else {
        await fs.promises.copyFile(filePath, destPath)
      }

      const docId = generateId()
      const now = Math.floor(Date.now() / 1000)
      const parseStatus = options?.contentText ? 'completed' : 'pending'

      let parsedJsonPath: string | null = null
      if (options?.contentText) {
        parsedJsonPath = this.saveDocParsedJson(docId, kbId, options.parsedJson || '{}')
      }

      this.db.prepare(`
        INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, parsed_json_path, parse_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, kbId, originalName, fileType, stats.size, fileHash,
        parsedJsonPath, parseStatus, now, now)

      this.searchEngine.indexDocumentTitle(kbId, docId, originalName)
      if (parsedJsonPath) {
        const content = this.readDocContentFromParsedJson(parsedJsonPath)
        if (content) {
          this.searchEngine.indexContentParagraphs(kbId, docId, content, originalName)
        }
      }

      return { kbDocId: docId, reused: !!options?.contentText, kbId }
    } catch (err) {
      console.error('importOrSyncToKB error:', err)
      return { kbDocId: null, reused: false, kbId }
    }
  }

  async syncForProject(projectId: string): Promise<void> {
    const kbId = this.ensureDefaultKBCallback()
    this.linkProject(kbId, projectId)
  }

  async importKBDocsToProject(
    projectId: string,
    docIds: string[]
  ): Promise<{ imported: any[]; errors: Array<{ docId: string; error: string }> }> {
    const imported: any[] = []
    const errors: Array<{ docId: string; error: string }> = []

    for (const docId of docIds) {
      try {
        const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
        if (!doc) {
          errors.push({ docId, error: 'Document not found' })
          continue
        }
        if (doc.parse_status !== 'completed') {
          errors.push({ docId, error: 'Document not parsed yet' })
          continue
        }

        const kbBasePath = this.getKBBasePath(doc.kb_id)
        const filePath = path.join(kbBasePath, doc.original_name)

        if (!fs.existsSync(filePath)) {
          errors.push({ docId, error: 'Source file not found on disk' })
          continue
        }

        const existingFile = this.mainDb.getDb().prepare(
          'SELECT id FROM files WHERE project_id = ? AND hash = ? LIMIT 1'
        ).get(projectId, doc.hash) as { id: string } | undefined

        if (existingFile) {
          imported.push({
            id: existingFile.id,
            original_name: doc.original_name,
            type: doc.type,
            size: doc.size,
            hash: doc.hash,
            status: 'completed',
            skipped: true,
          })
          continue
        }

        const FileParserService = (await import('./file-parser.service')).default
        const fileParser = FileParserService.getInstance()
        const result = await fileParser.importFile(projectId, filePath)

        imported.push({
          id: result.id,
          original_name: doc.original_name,
          type: doc.type,
          size: doc.size,
          hash: doc.hash,
          status: 'pending',
        })
      } catch (error) {
        errors.push({
          docId,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return { imported, errors }
  }

  searchChapters(kbId: string, query: string, topK: number = 5): SearchResult[] {
    return this.searchEngine.ftsSearch(kbId, query, topK, {
      sourceTypes: ['chapter']
    })
  }

  searchDocumentSummaries(kbId: string, query: string, topK: number = 5): SearchResult[] {
    return this.searchEngine.ftsSearch(kbId, query, topK, {
      sourceTypes: ['document_summary']
    })
  }

  search(kbId: string, query: string, topK: number = 10, documentIds?: string[]): SearchResult[] {
    return this.searchEngine.search(kbId, query, topK, documentIds)
  }

  async searchWithEmbedding(kbId: string, query: string, topK: number = 10, documentIds?: string[], providerId?: string): Promise<SearchResult[]> {
    const stats = this.searchEngine.getIndexStats(kbId)
    const hasEmbeddings = stats.embeddingCount > 0

    if (!hasEmbeddings) {
      return this.searchEngine.ftsSearch(kbId, query, topK, { documentIds })
    }

    let queryEmbedding: Float32Array | null = null
    try {
      const embeddingConfig = this.llmClient.getDefaultEmbeddingConfig()
      if (embeddingConfig) {
        queryEmbedding = await this.llmClient.createEmbedding(embeddingConfig.providerId, query, embeddingConfig.modelName)
      } else {
        const provider = providerId || this.getDefaultProviderId()
        if (provider) {
          queryEmbedding = await this.llmClient.createEmbedding(provider, query)
        }
      }
    } catch (err) {
      console.warn('[KB] Failed to generate query embedding, falling back to keyword search:', err)
    }

    return this.searchEngine.search(kbId, query, topK, documentIds, queryEmbedding || undefined)
  }

  advancedSearch(kbId: string, query: string, topK: number = 10, documentType?: string): SearchResult[] {
    return this.searchEngine.advancedFtsSearch(kbId, query, topK, {
      documentType
    })
  }

  getSearchIndexStats(kbId: string): any {
    return this.searchEngine.getIndexStats(kbId)
  }

  async rebuildSearchIndex(kbId: string): Promise<void> {
    this.searchEngine.rebuildIndexForKb(kbId)

    const docs = this.db.prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'"
    ).all(kbId) as DBKBDocument[]

    for (const doc of docs) {
      this.searchEngine.indexDocumentTitle(kbId, doc.id, doc.original_name)

      const content = doc.parsed_json_path ? this.readDocContentFromParsedJson(doc.parsed_json_path) : ''
      if (content) {
        this.searchEngine.indexContentParagraphs(kbId, doc.id, content, doc.original_name)
      }
    }

    const summaries = this.db.prepare(
      'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
    ).all(kbId) as DBKBDocumentSummary[]

    for (const ds of summaries) {
      this.searchEngine.indexDocumentSummary(
        kbId,
        ds.document_id,
        ds.summary,
        JSON.parse(ds.keywords_json || '[]'),
        JSON.parse(ds.main_topics_json || '[]')
      )
    }

    const chapters = this.db.prepare(
      'SELECT * FROM kb_chapters WHERE kb_id = ?'
    ).all(kbId) as DBKBChapter[]

    for (const ch of chapters) {
      this.searchEngine.indexChapter(
        kbId,
        ch.document_id,
        ch.id,
        ch.title,
        ch.summary || '',
        JSON.parse(ch.keywords_json || '[]'),
        JSON.parse(ch.entities_json || '[]'),
        ch.start_offset,
        ch.end_offset
      )
    }

    const entities = this.db.prepare(
      'SELECT * FROM kb_entities WHERE kb_id = ?'
    ).all(kbId) as DBKBEntity[]

    for (const entity of entities) {
      this.searchEngine.indexEntity(
        kbId,
        entity.id,
        entity.name,
        entity.type,
        entity.description || '',
        JSON.parse(entity.aliases_json || '[]'),
        entity.first_seen_doc_id || ''
      )
    }

    await this.rebuildEmbeddings(kbId)

    this.searchEngine.invalidateKbCache(kbId)
  }

  async rebuildEmbeddings(kbId: string): Promise<void> {
    const embeddingConfig = this.llmClient.getDefaultEmbeddingConfig()
    const provider = embeddingConfig?.providerId || this.getDefaultProviderId()
    if (!provider) return

    const modelName = embeddingConfig?.modelName

    const indexEntries = this.db.prepare(
      'SELECT id, source_type, source_id, document_id, title, content FROM kb_search_index WHERE kb_id = ?'
    ).all(kbId) as Array<{ id: string; source_type: string; source_id: string; document_id: string; title: string; content: string }>

    if (indexEntries.length === 0) return

    const texts: string[] = []
    const meta: Array<{ sourceType: string; sourceId: string; documentId: string }> = []

    for (const entry of indexEntries) {
      const text = [entry.title, entry.content].filter(Boolean).join(' ').trim()
      if (text.length > 10) {
        texts.push(text.substring(0, 2000))
        meta.push({ sourceType: entry.source_type, sourceId: entry.source_id, documentId: entry.document_id })
      }
    }

    if (texts.length === 0) return

    try {
      const embeddings = await this.llmClient.createEmbeddings(provider, texts, modelName)
      for (let i = 0; i < embeddings.length && i < meta.length; i++) {
        this.searchEngine.storeEmbedding(
          kbId,
          meta[i].sourceType,
          meta[i].sourceId,
          meta[i].documentId,
          embeddings[i],
          modelName || 'rebuild'
        )
      }
    } catch (err) {
      console.warn('[KB] Failed to rebuild embeddings:', err)
    }
  }

  pauseParse(docId: string): boolean {
    return this.parseTaskManager.pauseTask(docId)
  }

  resumeParse(docId: string): boolean {
    const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
    if (!doc) return false

    const hasActiveTask = this.parseTaskManager.hasActiveTask(docId)
    if (hasActiveTask) {
      return this.parseTaskManager.resumeTask(docId)
    }

    this.parseDocument(docId, true).catch(() => {})
    return true
  }

  retryParse(docId: string): boolean {
    const doc = this.db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as DBKBDocument | undefined
    if (!doc) return false

    this.db.prepare(
      "UPDATE kb_documents SET parse_status = 'pending', parse_error = NULL, parse_progress = 0, parse_stage = '', parse_detail = '', updated_at = unixepoch() WHERE id = ?"
    ).run(docId)

    this.parseDocument(docId).catch(() => {})
    return true
  }

  getParseProgress(docId: string) {
    return this.parseTaskManager.getProgress(docId)
  }

  getDocParseDetail(docId: string): Record<string, unknown> | null {
    const doc = this.db.prepare(
      'SELECT id, original_name, parse_status, parse_progress, parse_stage, parse_detail, processed_pages, total_pages, processed_chunks, total_chunks, parse_speed, parse_eta, parse_error FROM kb_documents WHERE id = ?'
    ).get(docId) as Record<string, unknown> | undefined

    if (doc?.parse_status === 'completed') {
      const processTaskId = `process-${docId}`
      const processTask = this.taskQueue.getTask(processTaskId)
      if (processTask) {
        return {
          ...doc,
          parse_status: processTask.status === 'running' ? 'parsing' : processTask.status === 'paused' ? 'paused' : processTask.status === 'failed' ? 'failed' : 'completed',
          parse_progress: processTask.progress,
          parse_stage: 'knowledge_process',
          parse_detail: processTask.progressText,
          parse_error: processTask.error,
        }
      }
    }

    return doc || null
  }

  pauseAllParses(): number {
    return this.parseTaskManager.pauseAllParseTasks()
  }

  resumeAllParses(): number {
    let count = 0
    const activeDocIds = this.parseTaskManager.getActiveDocIds()
    for (const docId of activeDocIds) {
      if (this.parseTaskManager.resumeTask(docId)) count++
    }
    const pausedDocs = this.db.prepare(
      "SELECT id FROM kb_documents WHERE parse_status = 'paused'"
    ).all() as Array<{ id: string }>
    for (const doc of pausedDocs) {
      if (!activeDocIds.includes(doc.id)) {
        this.parseDocument(doc.id, true).catch(() => {})
        count++
      }
    }
    return count
  }

  cancelAllParses(): number {
    return this.parseTaskManager.cancelAllParseTasks()
  }

  getPausedDocIds(): string[] {
    return this.parseTaskManager.getPausedDocIds()
  }
}

export default KBDocumentService
