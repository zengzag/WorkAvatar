import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import FileParserService from './file-parser.service'
import KnowledgeProcessorService from './knowledge-processor.service'
import ParseTaskManager from './parse-task-manager.service'
import TaskQueueService from './task-queue.service'
import { calculateFileHash, getDefaultProviderId } from './common-utils'

class KnowledgeBaseService {
  private db: DatabaseService
  private fileParser: FileParserService
  private processor: KnowledgeProcessorService
  private parseTaskManager: ParseTaskManager
  private taskQueue: TaskQueueService
  private static instance: KnowledgeBaseService
  private defaultKBId: string | null = null

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.fileParser = FileParserService.getInstance()
    this.processor = KnowledgeProcessorService.getInstance()
    this.parseTaskManager = ParseTaskManager.getInstance()
    this.taskQueue = TaskQueueService.getInstance()
  }

  static getInstance(): KnowledgeBaseService {
    if (!KnowledgeBaseService.instance) {
      KnowledgeBaseService.instance = new KnowledgeBaseService()
    }
    return KnowledgeBaseService.instance
  }

  ensureDefaultKB(): string {
    if (this.defaultKBId) return this.defaultKBId

    const existing = this.db.getDb().prepare(
      "SELECT id FROM knowledge_bases ORDER BY created_at ASC LIMIT 1"
    ).get() as any

    if (existing?.id) {
      this.defaultKBId = existing.id
      return existing.id
    }

    const kb = this.createKB('默认知识库', '系统默认知识库，所有项目自动关联') || { id: '' }
    this.defaultKBId = kb.id || ''
    return kb.id || ''
  }

  getDefaultKBId(): string {
    return this.ensureDefaultKB()
  }

  private getKBBasePath(kbId: string): string {
    const isDev = !app.isPackaged
    const basePath = isDev
      ? path.join(process.cwd(), '.workavatar-data', 'knowledge_bases', kbId)
      : path.join(app.getPath('userData'), 'knowledge_bases', kbId)
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true })
    }
    return basePath
  }

  listKBs(): any[] {
    return this.db.getDb().prepare(
      'SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count FROM knowledge_bases kb ORDER BY kb.updated_at DESC'
    ).all()
  }

  getKB(id: string): any | null {
    return this.db.getDb().prepare(
      'SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count FROM knowledge_bases kb WHERE kb.id = ?'
    ).get(id) || null
  }

  createKB(name: string, description: string = ''): any {
    const kbId = crypto.randomUUID()
    const kbPath = this.getKBBasePath(kbId)
    const now = Math.floor(Date.now() / 1000)

    this.db.getDb().prepare(`
      INSERT INTO knowledge_bases (id, name, description, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kbId, name, description, kbPath, now, now)

    return this.getKB(kbId)
  }

  updateKB(id: string, data: { name?: string; description?: string }): any | null {
    const kb = this.getKB(id)
    if (!kb) return null

    const updates: string[] = []
    const values: any[] = []

    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name) }
    if (data.description !== undefined) { updates.push('description = ?'); values.push(data.description) }

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)
      this.db.getDb().prepare(`UPDATE knowledge_bases SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getKB(id)
  }

  deleteKB(id: string): boolean {
    this.processor.deleteKnowledgeData(id)

    const docs = this.db.getDb().prepare('SELECT original_name FROM kb_documents WHERE kb_id = ?').all(id) as any[]
    const kbBasePath = this.getKBBasePath(id)
    for (const doc of docs) {
      try {
        const filePath = path.join(kbBasePath, doc.original_name)
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      } catch {}
    }

    const result = this.db.getDb().prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
    return result.changes > 0
  }

  async getExistingDocByHash(hash: string, kbId?: string): Promise<any | null> {
    if (kbId) {
      const sameKB = this.db.getDb().prepare(
        'SELECT * FROM kb_documents WHERE hash = ? AND kb_id = ? LIMIT 1'
      ).get(hash, kbId) as any
      if (sameKB) return sameKB
    }
    return this.db.getDb().prepare(
      'SELECT * FROM kb_documents WHERE hash = ? AND parse_status = ? LIMIT 1'
    ).get(hash, 'completed') || null
  }

  async getExistingDocByName(kbId: string, originalName: string): Promise<any | null> {
    return this.db.getDb().prepare(
      'SELECT * FROM kb_documents WHERE kb_id = ? AND original_name = ? LIMIT 1'
    ).get(kbId, originalName) || null
  }

  private readonly SUPPORTED_EXTENSIONS = new Set([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv',
    'txt', 'md', 'html', 'htm',
    'png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp',
  ])

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
            this.db.getDb().prepare(
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
            this.db.getDb().prepare(`
              UPDATE kb_documents SET hash = ?, size = ?, content_text = ?, parsed_json = ?, parse_status = 'completed', is_reused = 1, updated_at = unixepoch()
              WHERE id = ?
            `).run(fileHash, stats.size, existingDoc.content_text, existingDoc.parsed_json, existingByName.id)
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
          const docId = crypto.randomUUID()
          const now = Math.floor(Date.now() / 1000)
          this.db.getDb().prepare(`
            INSERT INTO kb_documents (id, kb_id, file_id, original_name, type, size, hash, content_text, parsed_json, parse_status, is_reused, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(docId, kbId, existingDoc.file_id, originalName, fileType, stats.size, fileHash,
            existingDoc.content_text, existingDoc.parsed_json, 'completed', 1, now, now)

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

        const docId = crypto.randomUUID()
        const now = Math.floor(Date.now() / 1000)

        this.db.getDb().prepare(`
          INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, content_text, parsed_json, parse_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)
        `).run(docId, kbId, originalName, fileType, stats.size, fileHash, now, now)

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
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
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
      const contentText = parseResult.fullText.substring(0, 500000)

      this.db.getDb().prepare(`
        UPDATE kb_documents 
        SET parse_status = 'completed', parsed_json = ?, content_text = ?,
            parse_progress = 100, parse_stage = 'done', parse_detail = 'Parse completed',
            processed_pages = ?, total_pages = ?, processed_chunks = ?, total_chunks = ?,
            updated_at = unixepoch()
        WHERE id = ?
      `).run(parsedJson, contentText, processedPages, totalPages, processedChunks, totalChunks, docId)

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
    const docs = this.db.getDb().prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status IN ('pending', 'failed')"
    ).all(kbId) as any[]

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
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
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

      const text = doc.content_text || ''
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
        `## ${cs.title}\n${cs.summary}\n实体: ${cs.entities.map(e => `${e.name}(${e.type})`).join(', ')}`
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
    const docs = this.db.getDb().prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'"
    ).all(kbId) as any[]

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

  async buildGlobalKnowledge(
    kbId: string,
    providerId?: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKB(kbId)
    if (!kb) {
      return { success: false, error: 'Knowledge base not found' }
    }

    const provider = providerId || this.getDefaultProviderId()
    if (!provider) {
      return { success: false, error: '未配置 LLM 提供商' }
    }

    const taskId = `build-global-${kbId}`
    this.taskQueue.addTask({
      id: taskId,
      type: 'process',
      title: `Global Knowledge Build: ${kb.name}`,
      status: 'running',
      progress: 0,
      progressText: 'Starting global knowledge build...',
      createdAt: Date.now(),
      metadata: { kbId, kbName: kb.name },
    })

    try {
      onProgress?.('global_summary', 'Generating global knowledge summary...')
      this.taskQueue.updateTask(taskId, { progress: 20, progressText: 'Generating global summary...' })

      const docSummaries = this.db.getDb().prepare(
        'SELECT ds.*, d.original_name as title FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
      ).all(kbId) as any[]

      if (docSummaries.length === 0) {
        this.taskQueue.updateTask(taskId, { status: 'failed', error: 'No processed document summaries', progressText: 'Failed: No processed document summaries' })
        return { success: false, error: 'No processed document summaries, please process documents first' }
      }

      this.taskQueue.updateTask(taskId, { progress: 50, progressText: `Aggregating ${docSummaries.length} doc summaries...` })

      const summaryInputs = docSummaries.map(ds => ({
        title: ds.title,
        summary: ds.summary,
        keyEntities: JSON.parse(ds.key_entities_json || '[]'),
        mainTopics: JSON.parse(ds.main_topics_json || '[]'),
      }))

      this.taskQueue.updateTask(taskId, { progress: 70, progressText: 'Calling LLM to generate global summary...' })

      const globalSummary = await this.processor.generateGlobalSummary(
        summaryInputs, kb.name, provider, modelId, enableThinking, onProgress
      )

      this.processor.saveGlobalSummary(kbId, globalSummary)

      onProgress?.('complete', 'Global knowledge build complete')
      this.taskQueue.updateTask(taskId, { status: 'completed', progress: 100, progressText: 'Global knowledge build complete' })
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.taskQueue.updateTask(taskId, { status: 'failed', error: errorMessage, progressText: `Failed: ${errorMessage}` })
      return { success: false, error: errorMessage }
    }
  }

  deleteDocument(docId: string): boolean {
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
    if (doc) {
      this.processor.deleteKnowledgeData(doc.kb_id, docId)
      const kbBasePath = this.getKBBasePath(doc.kb_id)
      const filePath = path.join(kbBasePath, doc.original_name)
      try { fs.unlinkSync(filePath) } catch {}
    }
    const result = this.db.getDb().prepare('DELETE FROM kb_documents WHERE id = ?').run(docId)
    return result.changes > 0
  }

  getDocumentList(kbId: string, status?: string): any[] {
    let query = 'SELECT * FROM kb_documents WHERE kb_id = ?'
    const params: any[] = [kbId]
    if (status) {
      query += ' AND parse_status = ?'
      params.push(status)
    }
    query += ' ORDER BY created_at DESC'
    return this.db.getDb().prepare(query).all(...params)
  }

  linkProject(kbId: string, projectId: string): boolean {
    const existing = this.db.getDb().prepare(
      'SELECT id FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
    ).get(kbId, projectId)

    if (existing) return true

    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      'INSERT INTO kb_project_links (id, kb_id, project_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, kbId, projectId, now)
    return true
  }

  unlinkProject(kbId: string, projectId: string): boolean {
    const result = this.db.getDb().prepare(
      'DELETE FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
    ).run(kbId, projectId)
    return result.changes > 0
  }

  getLinkedProjects(kbId: string): any[] {
    return this.db.getDb().prepare(`
      SELECT p.* FROM projects p
      INNER JOIN kb_project_links l ON p.id = l.project_id
      WHERE l.kb_id = ?
    `).all(kbId)
  }

  getKBsForProject(projectId: string): any[] {
    return this.db.getDb().prepare(`
      SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count
      FROM knowledge_bases kb
      INNER JOIN kb_project_links l ON kb.id = l.kb_id
      WHERE l.project_id = ?
      ORDER BY kb.name
    `).all(projectId)
  }

  getDocumentContent(docId: string): string | null {
    const doc = this.db.getDb().prepare('SELECT content_text FROM kb_documents WHERE id = ?').get(docId) as any
    return doc?.content_text || null
  }

  getParsedJson(docId: string): string | null {
    const doc = this.db.getDb().prepare('SELECT parsed_json FROM kb_documents WHERE id = ?').get(docId) as any
    return doc?.parsed_json || null
  }

  async importOrSyncToKB(
    filePath: string,
    projectId?: string,
    options?: { contentText?: string; parsedJson?: string }
  ): Promise<{ kbDocId: string | null; reused: boolean; kbId: string }> {
    const kbId = this.ensureDefaultKB()
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
          this.db.getDb().prepare(`
            UPDATE kb_documents SET hash = ?, size = ?, content_text = ?, parsed_json = ?, parse_status = 'completed', updated_at = unixepoch()
            WHERE id = ?
          `).run(fileHash, stats.size, existingDoc.content_text, existingDoc.parsed_json, existingByName.id)
          return { kbDocId: existingByName.id, reused: true, kbId }
        }
      }

      const destPath = path.join(this.getKBBasePath(kbId), originalName)
      if (options?.contentText) {
        fs.writeFileSync(destPath, '', 'utf-8')
      } else {
        await fs.promises.copyFile(filePath, destPath)
      }

      const docId = crypto.randomUUID()
      const now = Math.floor(Date.now() / 1000)
      const parseStatus = options?.contentText ? 'completed' : 'pending'

      this.db.getDb().prepare(`
        INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, content_text, parsed_json, parse_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(docId, kbId, originalName, fileType, stats.size, fileHash,
        options?.contentText || null, options?.parsedJson || null, parseStatus, now, now)

      return { kbDocId: docId, reused: !!options?.contentText, kbId }
    } catch (err) {
      console.error('importOrSyncToKB error:', err)
      return { kbDocId: null, reused: false, kbId }
    }
  }

  async syncForProject(projectId: string): Promise<void> {
    const kbId = this.ensureDefaultKB()
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
        const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
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

        const existingFile = this.db.getDb().prepare(
          'SELECT id FROM files WHERE project_id = ? AND hash = ? LIMIT 1'
        ).get(projectId, doc.hash) as any

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

        if (doc.content_text && doc.parsed_json) {
          fileParser.updateFileFromKB(result.id, doc.content_text, doc.parsed_json)
        }

        imported.push({
          id: result.id,
          original_name: doc.original_name,
          type: doc.type,
          size: doc.size,
          hash: doc.hash,
          status: doc.content_text ? 'completed' : 'pending',
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

  getKnowledgeStats(kbId: string): any {
    return this.processor.getKnowledgeStats(kbId)
  }

  getAllDocumentSummaries(kbId: string): any[] {
    return this.processor.getAllDocumentSummaries(kbId)
  }

  getChapters(documentId: string): any[] {
    return this.processor.getChapters(documentId)
  }

  getDocumentSummary(documentId: string): any | null {
    return this.processor.getDocumentSummary(documentId)
  }

  getGlobalSummary(kbId: string): any | null {
    return this.processor.getGlobalSummary(kbId)
  }

  getEntities(kbId: string, type?: string): any[] {
    return this.processor.getEntities(kbId, type)
  }

  getEntityByName(kbId: string, name: string): any | null {
    return this.processor.getEntityByName(kbId, name)
  }

  getEntityRelations(entityId: string, depth: number = 1): any[] {
    return this.processor.getEntityRelations(entityId, depth)
  }

  getEntityMentions(entityId: string): any[] {
    return this.processor.getEntityMentions(entityId)
  }

  searchChapters(kbId: string, query: string, topK: number = 5): any[] {
    return this.processor.searchChapters(kbId, query, topK)
  }

  searchDocumentSummaries(kbId: string, query: string, topK: number = 5): any[] {
    return this.processor.searchDocumentSummaries(kbId, query, topK)
  }

  generateTimeline(kbId: string, topic?: string): any[] {
    return this.processor.generateTimeline(kbId, topic)
  }

  getProcessingJobs(kbId: string, status?: string): any[] {
    return this.processor.getProcessingJobs(kbId, status)
  }

  pauseParse(docId: string): boolean {
    return this.parseTaskManager.pauseTask(docId)
  }

  resumeParse(docId: string): boolean {
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
    if (!doc) return false

    const hasActiveTask = this.parseTaskManager.hasActiveTask(docId)
    if (hasActiveTask) {
      return this.parseTaskManager.resumeTask(docId)
    }

    this.parseDocument(docId, true).catch(() => {})
    return true
  }

  retryParse(docId: string): boolean {
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
    if (!doc) return false

    this.db.getDb().prepare(
      "UPDATE kb_documents SET parse_status = 'pending', parse_error = NULL, parse_progress = 0, parse_stage = '', parse_detail = '', updated_at = unixepoch() WHERE id = ?"
    ).run(docId)

    this.parseDocument(docId).catch(() => {})
    return true
  }

  getParseProgress(docId: string) {
    return this.parseTaskManager.getProgress(docId)
  }

  getDocParseDetail(docId: string): any {
    const doc = this.db.getDb().prepare(
      'SELECT id, original_name, parse_status, parse_progress, parse_stage, parse_detail, processed_pages, total_pages, processed_chunks, total_chunks, parse_speed, parse_eta, parse_error FROM kb_documents WHERE id = ?'
    ).get(docId) as any
    
    // 如果文档解析完成，但有正在进行的知识处理任务，返回处理进度
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
    const pausedDocs = this.db.getDb().prepare(
      "SELECT id FROM kb_documents WHERE parse_status = 'paused'"
    ).all() as any[]
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

  private getDefaultProviderId(): string | null {
    return getDefaultProviderId(this.db)
  }

  async exportKBFull(
    kbId: string,
    exportPath: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKB(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      onProgress?.('preparing', 'Preparing export data...')

      const manifest = {
        version: '1.0.0',
        type: 'workavatar-kb-full',
        exportedAt: new Date().toISOString(),
        kb: {
          id: kb.id,
          name: kb.name,
          description: kb.description,
          docCount: kb.doc_count,
        },
      }

      const documents = this.db.getDb().prepare(
        'SELECT * FROM kb_documents WHERE kb_id = ?'
      ).all(kbId) as any[]

      const chapters = this.db.getDb().prepare(
        'SELECT * FROM kb_chapters WHERE kb_id = ?'
      ).all(kbId) as any[]

      const docSummaries = this.db.getDb().prepare(
        'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
      ).all(kbId) as any[]

      const globalSummary = this.db.getDb().prepare(
        'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
      ).get(kbId) as any

      const entities = this.db.getDb().prepare(
        'SELECT * FROM kb_entities WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityRelations = this.db.getDb().prepare(
        'SELECT * FROM kb_entity_relations WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityMentions = this.db.getDb().prepare(
        `SELECT m.* FROM kb_entity_mentions m
         INNER JOIN kb_entities e ON m.entity_id = e.id
         WHERE e.kb_id = ?`
      ).all(kbId) as any[]

      onProgress?.('collecting', `Collected ${documents.length} documents, ${entities.length} entities`)

      const knowledgeData = {
        documents: documents.map(d => ({
          id: d.id,
          original_name: d.original_name,
          type: d.type,
          size: d.size,
          hash: d.hash,
          content_text: d.content_text,
          parsed_json: d.parsed_json,
          parse_status: d.parse_status,
          created_at: d.created_at,
          updated_at: d.updated_at,
        })),
        chapters,
        docSummaries,
        globalSummary: globalSummary || null,
        entities,
        entityRelations,
        entityMentions,
      }

      const zip = new AdmZip()
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
      zip.addFile('knowledge-data.json', Buffer.from(JSON.stringify(knowledgeData, null, 2)))

      const kbBasePath = this.getKBBasePath(kbId)
      onProgress?.('adding_files', 'Adding document files...')
      let addedCount = 0
      for (const doc of documents) {
        const filePath = path.join(kbBasePath, doc.original_name)
        if (fs.existsSync(filePath)) {
          zip.addLocalFile(filePath, 'documents')
          addedCount++
          if (addedCount % 10 === 0) {
            onProgress?.('adding_files', `Added ${addedCount}/${documents.length} files...`)
          }
        }
      }

      onProgress?.('saving', 'Saving ZIP archive...')
      zip.writeZip(exportPath)
      onProgress?.('complete', `Export complete: ${documents.length} documents, ${entities.length} entities`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async exportKBSummary(
    kbId: string,
    exportPath: string,
    format: 'json-ld' | 'csv',
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKB(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      onProgress?.('preparing', 'Preparing summary export...')

      const globalSummary = this.db.getDb().prepare(
        'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
      ).get(kbId) as any

      const docSummaries = this.db.getDb().prepare(
        'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entities = this.db.getDb().prepare(
        'SELECT * FROM kb_entities WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityRelations = this.db.getDb().prepare(
        'SELECT * FROM kb_entity_relations WHERE kb_id = ?'
      ).all(kbId) as any[]

      const chapters = this.db.getDb().prepare(
        'SELECT id, kb_id, document_id, title, chapter_index, summary, keywords_json, entities_json FROM kb_chapters WHERE kb_id = ?'
      ).all(kbId) as any[]

      if (format === 'json-ld') {
        onProgress?.('generating', 'Generating JSON-LD format...')
        const context = {
          '@vocab': 'https://workavatar.ai/ontology/',
          'kb': 'https://workavatar.ai/kb/',
          'name': 'http://schema.org/name',
          'description': 'http://schema.org/description',
          'summary': 'http://schema.org/abstract',
          'type': 'http://schema.org/additionalType',
          'entity': 'https://workavatar.ai/ontology/entity',
          'relation': 'https://workavatar.ai/ontology/relation',
          'document': 'https://workavatar.ai/ontology/document',
          'chapter': 'https://workavatar.ai/ontology/chapter',
        }

        const graph: any[] = []

        graph.push({
          '@id': `kb:${kbId}`,
          '@type': 'KnowledgeBase',
          name: kb.name,
          description: kb.description,
        })

        if (globalSummary) {
          graph.push({
            '@id': `kb:${kbId}/global-summary`,
            '@type': 'GlobalSummary',
            summary: globalSummary.summary,
            keyTopics: JSON.parse(globalSummary.key_topics_json || '[]'),
            keyEntities: JSON.parse(globalSummary.key_entities_json || '[]'),
            globalTimeline: JSON.parse(globalSummary.global_timeline_json || '[]'),
          })
        }

        for (const ds of docSummaries) {
          graph.push({
            '@id': `kb:${kbId}/doc/${ds.document_id}/summary`,
            '@type': 'DocumentSummary',
            summary: ds.summary,
            keyEntities: JSON.parse(ds.key_entities_json || '[]'),
            timeline: JSON.parse(ds.timeline_json || '[]'),
            keywords: JSON.parse(ds.keywords_json || '[]'),
            mainTopics: JSON.parse(ds.main_topics_json || '[]'),
          })
        }

        for (const entity of entities) {
          graph.push({
            '@id': `kb:${kbId}/entity/${entity.id}`,
            '@type': 'Entity',
            name: entity.name,
            entityType: entity.type,
            description: entity.description,
            aliases: JSON.parse(entity.aliases_json || '[]'),
            attributes: JSON.parse(entity.attributes_json || '{}'),
            mentionCount: entity.mention_count,
          })
        }

        for (const rel of entityRelations) {
          graph.push({
            '@id': `kb:${kbId}/relation/${rel.id}`,
            '@type': 'Relation',
            source: { '@id': `kb:${kbId}/entity/${rel.source_entity_id}` },
            target: { '@id': `kb:${kbId}/entity/${rel.target_entity_id}` },
            relationType: rel.relation_type,
            description: rel.description,
            confidence: rel.confidence,
          })
        }

        for (const ch of chapters) {
          graph.push({
            '@id': `kb:${kbId}/chapter/${ch.id}`,
            '@type': 'Chapter',
            title: ch.title,
            summary: ch.summary,
            keywords: JSON.parse(ch.keywords_json || '[]'),
            entities: JSON.parse(ch.entities_json || '[]'),
          })
        }

        const jsonLd = {
          '@context': context,
          '@graph': graph,
        }

        fs.writeFileSync(exportPath, JSON.stringify(jsonLd, null, 2), 'utf-8')
      } else {
        onProgress?.('generating', 'Generating CSV format...')
        const csvLines: string[] = []

        csvLines.push('=== Global Summary ===')
        csvLines.push('summary,key_topics,key_entities')
        if (globalSummary) {
          csvLines.push(`"${(globalSummary.summary || '').replace(/"/g, '""')}","${JSON.stringify(JSON.parse(globalSummary.key_topics_json || '[]')).replace(/"/g, '""')}","${JSON.stringify(JSON.parse(globalSummary.key_entities_json || '[]')).replace(/"/g, '""')}"`)
        }
        csvLines.push('')

        csvLines.push('=== Document Summaries ===')
        csvLines.push('document_id,summary,keywords,main_topics')
        for (const ds of docSummaries) {
          csvLines.push(`"${ds.document_id}","${(ds.summary || '').replace(/"/g, '""')}","${JSON.stringify(JSON.parse(ds.keywords_json || '[]')).replace(/"/g, '""')}","${JSON.stringify(JSON.parse(ds.main_topics_json || '[]')).replace(/"/g, '""')}"`)
        }
        csvLines.push('')

        csvLines.push('=== Entities ===')
        csvLines.push('id,name,type,description,aliases,mention_count')
        for (const entity of entities) {
          csvLines.push(`"${entity.id}","${(entity.name || '').replace(/"/g, '""')}","${entity.type}","${(entity.description || '').replace(/"/g, '""')}","${JSON.stringify(JSON.parse(entity.aliases_json || '[]')).replace(/"/g, '""')}",${entity.mention_count || 0}`)
        }
        csvLines.push('')

        csvLines.push('=== Entity Relations ===')
        csvLines.push('source_entity_id,target_entity_id,relation_type,description,confidence')
        for (const rel of entityRelations) {
          csvLines.push(`"${rel.source_entity_id}","${rel.target_entity_id}","${(rel.relation_type || '').replace(/"/g, '""')}","${(rel.description || '').replace(/"/g, '""')}",${rel.confidence || ''}`)
        }
        csvLines.push('')

        csvLines.push('=== Chapters ===')
        csvLines.push('document_id,title,summary,keywords')
        for (const ch of chapters) {
          csvLines.push(`"${ch.document_id}","${(ch.title || '').replace(/"/g, '""')}","${(ch.summary || '').replace(/"/g, '""')}","${JSON.stringify(JSON.parse(ch.keywords_json || '[]')).replace(/"/g, '""')}"`)
        }

        fs.writeFileSync(exportPath, csvLines.join('\n'), 'utf-8')
      }

      onProgress?.('complete', `Summary export complete: ${entities.length} entities, ${entityRelations.length} relations`)
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async exportKBDocuments(
    kbId: string,
    exportPath: string,
    docIds?: string[],
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKB(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      let docs: any[]
      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',')
        docs = this.db.getDb().prepare(
          `SELECT * FROM kb_documents WHERE kb_id = ? AND id IN (${placeholders})`
        ).all(kbId, ...docIds) as any[]
      } else {
        docs = this.db.getDb().prepare(
          'SELECT * FROM kb_documents WHERE kb_id = ?'
        ).all(kbId) as any[]
      }

      onProgress?.('preparing', `Exporting ${docs.length} documents...`)

      const kbBasePath = this.getKBBasePath(kbId)
      const zip = new AdmZip()

      let addedCount = 0
      for (const doc of docs) {
        const filePath = path.join(kbBasePath, doc.original_name)
        if (fs.existsSync(filePath)) {
          zip.addLocalFile(filePath, 'documents')
          addedCount++
          if (addedCount % 5 === 0) {
            onProgress?.('adding_files', `Added ${addedCount}/${docs.length} files...`)
          }
        }
      }

      onProgress?.('saving', 'Saving ZIP archive...')
      zip.writeZip(exportPath)
      onProgress?.('complete', `Export complete: ${addedCount} document files`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async importKBFull(
    importPath: string,
    kbName?: string,
    _conflictStrategy: 'skip' | 'overwrite' | 'rename' = 'skip',
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string; kbId?: string }> {
    try {
      if (!fs.existsSync(importPath)) {
        return { success: false, error: 'Import file not found' }
      }

      onProgress?.('reading', 'Reading archive...')
      const zip = new AdmZip(importPath)

      const manifestEntry = zip.getEntry('manifest.json')
      if (!manifestEntry) {
        return { success: false, error: 'Invalid archive: manifest.json not found' }
      }

      const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
      if (manifest.type !== 'workavatar-kb-full') {
        return { success: false, error: 'Invalid archive: not a WorkAvatar knowledge base export' }
      }

      const dataEntry = zip.getEntry('knowledge-data.json')
      if (!dataEntry) {
        return { success: false, error: 'Invalid archive: knowledge-data.json not found' }
      }

      const knowledgeData = JSON.parse(dataEntry.getData().toString('utf-8'))

      onProgress?.('creating_kb', 'Creating knowledge base...')
      const newKBName = kbName || manifest.kb?.name || 'Imported Knowledge Base'
      const newKB = this.createKB(newKBName, manifest.kb?.description || '')
      if (!newKB) {
        return { success: false, error: 'Failed to create knowledge base' }
      }

      const newKBId = newKB.id
      const kbBasePath = this.getKBBasePath(newKBId)

      const docIdMap = new Map<string, string>()

      onProgress?.('importing_docs', `Importing ${knowledgeData.documents?.length || 0} documents...`)
      const documents = knowledgeData.documents || []
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i]
        const newDocId = crypto.randomUUID()
        docIdMap.set(doc.id, newDocId)

        const docEntry = zip.getEntry(`documents/${doc.original_name}`)
        if (docEntry) {
          const destPath = path.join(kbBasePath, doc.original_name)
          fs.writeFileSync(destPath, docEntry.getData())
        }

        const now = Math.floor(Date.now() / 1000)
        this.db.getDb().prepare(`
          INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, content_text, parsed_json, parse_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newDocId, newKBId, doc.original_name, doc.type, doc.size, doc.hash,
          doc.content_text || null, doc.parsed_json || null, doc.parse_status || 'pending',
          doc.created_at || now, doc.updated_at || now)

        if ((i + 1) % 5 === 0 || i === documents.length - 1) {
          onProgress?.('importing_docs', `Imported ${i + 1}/${documents.length} documents...`)
        }
      }

      onProgress?.('importing_chapters', `Importing ${knowledgeData.chapters?.length || 0} chapters...`)
      const chapters = knowledgeData.chapters || []
      const chapterIdMap = new Map<string, string>()
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i]
        const newDocId = docIdMap.get(ch.document_id)
        if (!newDocId) continue

        const newChapterId = crypto.randomUUID()
        chapterIdMap.set(ch.id, newChapterId)

        this.db.getDb().prepare(`
          INSERT INTO kb_chapters (id, kb_id, document_id, title, chapter_index, start_offset, end_offset, content, summary, keywords_json, entities_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(newChapterId, newKBId, newDocId, ch.title, ch.chapter_index,
          ch.start_offset, ch.end_offset, ch.content || '',
          ch.summary || null, ch.keywords_json || '[]', ch.entities_json || '[]')
      }

      onProgress?.('importing_summaries', 'Importing document summaries...')
      const docSummaries = knowledgeData.docSummaries || []
      for (const ds of docSummaries) {
        const newDocId = docIdMap.get(ds.document_id)
        if (!newDocId) continue

        const id = crypto.randomUUID()
        this.db.getDb().prepare(`
          INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, key_entities_json, timeline_json, keywords_json, main_topics_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, newKBId, newDocId, ds.summary || '',
          ds.key_entities_json || '[]', ds.timeline_json || '[]',
          ds.keywords_json || '[]', ds.main_topics_json || '[]')
      }

      if (knowledgeData.globalSummary) {
        onProgress?.('importing_global', 'Importing global summary...')
        const gs = knowledgeData.globalSummary
        const id = crypto.randomUUID()
        this.db.getDb().prepare(`
          INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, key_entities_json, global_timeline_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, newKBId, gs.summary || '',
          gs.key_topics_json || '[]', gs.key_entities_json || '[]', gs.global_timeline_json || '[]')
      }

      onProgress?.('importing_entities', `Importing ${knowledgeData.entities?.length || 0} entities...`)
      const entities = knowledgeData.entities || []
      const entityIdMap = new Map<string, string>()
      for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]
        const newEntityId = crypto.randomUUID()
        entityIdMap.set(entity.id, newEntityId)

        this.db.getDb().prepare(`
          INSERT INTO kb_entities (id, kb_id, name, type, description, aliases_json, attributes_json, mention_count, first_seen_doc_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(newEntityId, newKBId, entity.name, entity.type, entity.description,
          entity.aliases_json || '[]', entity.attributes_json || '{}',
          entity.mention_count || 0, docIdMap.get(entity.first_seen_doc_id) || null)

        if ((i + 1) % 20 === 0 || i === entities.length - 1) {
          onProgress?.('importing_entities', `Imported ${i + 1}/${entities.length} entities...`)
        }
      }

      onProgress?.('importing_relations', `Importing ${knowledgeData.entityRelations?.length || 0} relations...`)
      const relations = knowledgeData.entityRelations || []
      for (const rel of relations) {
        const newSourceId = entityIdMap.get(rel.source_entity_id)
        const newTargetId = entityIdMap.get(rel.target_entity_id)
        if (!newSourceId || !newTargetId) continue

        const id = crypto.randomUUID()
        this.db.getDb().prepare(`
          INSERT INTO kb_entity_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, source_document_id, confidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `).run(id, newKBId, newSourceId, newTargetId, rel.relation_type,
          rel.description || null, docIdMap.get(rel.source_document_id) || null,
          rel.confidence || null)
      }

      onProgress?.('importing_mentions', `Importing ${knowledgeData.entityMentions?.length || 0} entity mentions...`)
      const mentions = knowledgeData.entityMentions || []
      for (const m of mentions) {
        const newEntityId = entityIdMap.get(m.entity_id)
        const newDocId = docIdMap.get(m.document_id)
        const newChapterId = chapterIdMap.get(m.chapter_id)
        if (!newEntityId) continue

        const id = crypto.randomUUID()
        this.db.getDb().prepare(`
          INSERT INTO kb_entity_mentions (id, entity_id, document_id, chapter_id, context_text, start_offset, end_offset, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        `).run(id, newEntityId, newDocId || null, newChapterId || null,
          m.context_text || null, m.start_offset, m.end_offset)
      }

      onProgress?.('complete', `Import complete: ${documents.length} documents, ${entities.length} entities`)
      return { success: true, kbId: newKBId }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async importKBGraph(
    kbId: string,
    importPath: string,
    format: 'json-ld' | 'rdf',
    conflictStrategy: 'skip' | 'overwrite' | 'merge' = 'merge',
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string; imported?: { entities: number; relations: number } }> {
    const kb = this.getKB(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      if (!fs.existsSync(importPath)) {
        return { success: false, error: 'Import file not found' }
      }

      onProgress?.('reading', 'Reading graph data...')
      const content = fs.readFileSync(importPath, 'utf-8')

      let importedEntities: Array<{ name: string; type: string; description: string; aliases: string[]; attributes: Record<string, string> }> = []
      let importedRelations: Array<{ source: string; target: string; relationType: string; description: string }> = []

      if (format === 'json-ld') {
        const jsonLd = JSON.parse(content)
        const graph = jsonLd['@graph'] || []

        for (const node of graph) {
          if (node['@type'] === 'Entity') {
            importedEntities.push({
              name: node.name || '',
              type: node.entityType || 'other',
              description: node.description || '',
              aliases: Array.isArray(node.aliases) ? node.aliases : [],
              attributes: node.attributes && typeof node.attributes === 'object' ? node.attributes : {},
            })
          } else if (node['@type'] === 'Relation') {
            const sourceId = node.source?.['@id']?.split('/').pop() || ''
            const targetId = node.target?.['@id']?.split('/').pop() || ''
            importedRelations.push({
              source: sourceId,
              target: targetId,
              relationType: node.relationType || '',
              description: node.description || '',
            })
          }
        }
      } else {
        onProgress?.('parsing', 'Parsing RDF format...')
        const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'))
        for (const line of lines) {
          const parts = line.split(/\s+/)
          if (parts.length >= 3) {
            const predicate = parts[1].replace(/[<>]/g, '')
            const object = parts.slice(2).join(' ').replace(/[<>]/g, '').replace(/\.$/, '')

            if (predicate.includes('name') || predicate.includes('label')) {
              importedEntities.push({
                name: object,
                type: 'other',
                description: '',
                aliases: [],
                attributes: {},
              })
            }
          }
        }
      }

      onProgress?.('importing_entities', `Importing ${importedEntities.length} entities...`)

      const entityNameToId = new Map<string, string>()
      const existingEntities = this.db.getDb().prepare(
        'SELECT id, name FROM kb_entities WHERE kb_id = ?'
      ).all(kbId) as any[]
      for (const e of existingEntities) {
        entityNameToId.set(e.name.toLowerCase(), e.id)
      }

      let entityCount = 0
      for (const entity of importedEntities) {
        const existingId = entityNameToId.get(entity.name.toLowerCase())

        if (existingId) {
          if (conflictStrategy === 'overwrite') {
            this.db.getDb().prepare(`
              UPDATE kb_entities SET type = ?, description = ?, aliases_json = ?, attributes_json = ?, updated_at = unixepoch()
              WHERE id = ?
            `).run(entity.type, entity.description, JSON.stringify(entity.aliases), JSON.stringify(entity.attributes), existingId)
          } else if (conflictStrategy === 'merge') {
            const existing = this.db.getDb().prepare('SELECT * FROM kb_entities WHERE id = ?').get(existingId) as any
            if (existing) {
              const existingAliases: string[] = JSON.parse(existing.aliases_json || '[]')
              const newAliases = entity.aliases.filter(a => !existingAliases.includes(a))
              this.db.getDb().prepare(`
                UPDATE kb_entities SET aliases_json = ?, mention_count = mention_count + 1, updated_at = unixepoch()
                WHERE id = ?
              `).run(JSON.stringify([...existingAliases, ...newAliases]), existingId)
            }
          }
        } else {
          const id = crypto.randomUUID()
          this.db.getDb().prepare(`
            INSERT INTO kb_entities (id, kb_id, name, type, description, aliases_json, attributes_json, mention_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch())
          `).run(id, kbId, entity.name, entity.type, entity.description,
            JSON.stringify(entity.aliases), JSON.stringify(entity.attributes))
          entityNameToId.set(entity.name.toLowerCase(), id)
          entityCount++
        }
      }

      onProgress?.('importing_relations', `Importing ${importedRelations.length} relations...`)
      let relationCount = 0

      for (const relation of importedRelations) {
        const sourceId = entityNameToId.get(relation.source.toLowerCase())
        const targetId = entityNameToId.get(relation.target.toLowerCase())

        if (!sourceId || !targetId) {
          const sourceByName = entityNameToId.get(relation.source.toLowerCase())
          const targetByName = entityNameToId.get(relation.target.toLowerCase())
          if (!sourceByName || !targetByName) continue
        }

        const finalSourceId = sourceId || entityNameToId.get(relation.source.toLowerCase())!
        const finalTargetId = targetId || entityNameToId.get(relation.target.toLowerCase())!

        const existingRelation = this.db.getDb().prepare(
          'SELECT id FROM kb_entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?'
        ).get(finalSourceId, finalTargetId, relation.relationType) as any

        if (existingRelation) {
          if (conflictStrategy === 'overwrite') {
            this.db.getDb().prepare(`
              UPDATE kb_entity_relations SET description = ?, created_at = unixepoch()
              WHERE id = ?
            `).run(relation.description, existingRelation.id)
          }
          continue
        }

        const id = crypto.randomUUID()
        this.db.getDb().prepare(`
          INSERT INTO kb_entity_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        `).run(id, kbId, finalSourceId, finalTargetId, relation.relationType, relation.description)
        relationCount++
      }

      onProgress?.('complete', `Import complete: ${entityCount} new entities, ${relationCount} new relations`)
      return { success: true, imported: { entities: entityCount, relations: relationCount } }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }
}

export default KnowledgeBaseService
