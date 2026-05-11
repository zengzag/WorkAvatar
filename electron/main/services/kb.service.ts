import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import DatabaseService from './database.service'
import FileParserService from './file-parser.service'
import KnowledgeProcessorService from './knowledge-processor.service'
import { calculateFileHash, getDefaultProviderId } from './common-utils'

class KnowledgeBaseService {
  private db: DatabaseService
  private fileParser: FileParserService
  private processor: KnowledgeProcessorService
  private static instance: KnowledgeBaseService
  private defaultKBId: string | null = null

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.fileParser = FileParserService.getInstance()
    this.processor = KnowledgeProcessorService.getInstance()
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
              UPDATE kb_documents SET hash = ?, size = ?, content_text = ?, parsed_json = ?, parse_status = 'completed', updated_at = unixepoch()
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
            INSERT INTO kb_documents (id, kb_id, file_id, original_name, type, size, hash, content_text, parsed_json, parse_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(docId, kbId, existingDoc.file_id, originalName, fileType, stats.size, fileHash,
            existingDoc.content_text, existingDoc.parsed_json, 'completed', now, now)

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
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
    if (!doc) {
      return { success: false, error: '文档不存在' }
    }

    const kbBasePath = this.getKBBasePath(doc.kb_id)
    const filePath = path.join(kbBasePath, doc.original_name)

    if (!fs.existsSync(filePath)) {
      return { success: false, error: '文件不存在' }
    }

    try {
      onProgress?.('parsing', `正在解析: ${doc.original_name}`)
      this.db.getDb().prepare("UPDATE kb_documents SET parse_status = 'parsing', updated_at = unixepoch() WHERE id = ?").run(docId)

      const parseResult = await this.fileParser.parseFilePath(filePath)
      onProgress?.('saving', `正在保存解析结果...`)

      const parsedJson = JSON.stringify(parseResult)
      const contentText = parseResult.fullText.substring(0, 500000)

      this.db.getDb().prepare(`
        UPDATE kb_documents 
        SET parse_status = 'completed', parsed_json = ?, content_text = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(parsedJson, contentText, docId)

      onProgress?.('done', '解析完成')
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.db.getDb().prepare(`
        UPDATE kb_documents 
        SET parse_status = 'failed', parse_error = ?, updated_at = unixepoch()
        WHERE id = ?
      `).run(errorMessage, docId)
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

      try {
        this.db.getDb().prepare("UPDATE kb_documents SET parse_status = 'parsing', updated_at = unixepoch() WHERE id = ?").run(doc.id)

        const parseResult = await this.fileParser.parseFilePath(filePath)
        const parsedJson = JSON.stringify(parseResult)
        const contentText = parseResult.fullText.substring(0, 500000)

        this.db.getDb().prepare(`
          UPDATE kb_documents 
          SET parse_status = 'completed', parsed_json = ?, content_text = ?, updated_at = unixepoch()
          WHERE id = ?
        `).run(parsedJson, contentText, doc.id)
        successCount++
      } catch {
        this.db.getDb().prepare(`
          UPDATE kb_documents SET parse_status = 'failed', parse_error = '解析失败', updated_at = unixepoch()
          WHERE id = ?
        `).run(doc.id)
        failedCount++
      }
    }

    return { success: successCount, failed: failedCount }
  }

  async processDocument(
    docId: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const doc = this.db.getDb().prepare('SELECT * FROM kb_documents WHERE id = ?').get(docId) as any
    if (!doc) {
      return { success: false, error: '文档不存在' }
    }

    if (doc.parse_status !== 'completed') {
      return { success: false, error: '文档尚未解析完成' }
    }

    const kbId = doc.kb_id
    const provider = providerId || this.getDefaultProviderId()
    if (!provider) {
      return { success: false, error: '未配置 LLM 提供商' }
    }

    const jobId = this.processor.createProcessingJob(kbId, docId, 'full_process', 4)

    try {
      this.processor.updateProcessingJob(jobId, 'running', 0, '章节识别')
      onProgress?.('章节识别', `正在识别文档结构: ${doc.original_name}`)

      const text = doc.content_text || ''
      const chapters = this.processor.identifyChapters(text)

      this.processor.updateProcessingJob(jobId, 'running', 1, '章节摘要生成')
      const chapterSummaries = []
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i]
        onProgress?.('章节摘要', `正在生成章节摘要 (${i + 1}/${chapters.length}): ${chapter.title}`)
        const summary = await this.processor.generateChapterSummary(
          chapter.content, chapter.title, provider, modelId, onProgress
        )
        chapterSummaries.push(summary)
      }

      this.processor.saveChapters(kbId, docId, chapters, chapterSummaries)

      this.processor.updateProcessingJob(jobId, 'running', 2, '文档摘要生成')
      const docSummary = await this.processor.generateDocumentSummary(
        chapterSummaries, doc.original_name, provider, modelId, onProgress
      )
      this.processor.saveDocumentSummary(kbId, docId, docSummary)

      this.processor.updateProcessingJob(jobId, 'running', 3, '实体识别')
      const entityText = chapterSummaries.map(cs =>
        `## ${cs.title}\n${cs.summary}\n实体: ${cs.entities.map(e => `${e.name}(${e.type})`).join(', ')}`
      ).join('\n\n')
      const extraction = await this.processor.extractEntities(
        entityText, doc.original_name, provider, modelId, onProgress
      )
      this.processor.saveEntities(kbId, docId, extraction)

      this.processor.updateProcessingJob(jobId, 'completed', 4, '完成')
      onProgress?.('完成', `文档处理完成: ${doc.original_name}`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      this.processor.updateProcessingJob(jobId, 'failed', undefined, undefined, errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async processAllDocuments(
    kbId: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: number; failed: number; skipped: number }> {
    const docs = this.db.getDb().prepare(
      "SELECT * FROM kb_documents WHERE kb_id = ? AND parse_status = 'completed'"
    ).all(kbId) as any[]

    let successCount = 0
    let failedCount = 0
    let skippedCount = 0

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]

      const existingSummary = this.processor.getDocumentSummary(doc.id)
      if (existingSummary) {
        skippedCount++
        continue
      }

      onProgress?.('处理文档', `正在处理第 ${i + 1}/${docs.length} 个文档: ${doc.original_name}`)
      const result = await this.processDocument(doc.id, providerId, modelId, onProgress)

      if (result.success) {
        successCount++
      } else {
        failedCount++
      }
    }

    return { success: successCount, failed: failedCount, skipped: skippedCount }
  }

  async buildGlobalKnowledge(
    kbId: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKB(kbId)
    if (!kb) {
      return { success: false, error: '知识库不存在' }
    }

    const provider = providerId || this.getDefaultProviderId()
    if (!provider) {
      return { success: false, error: '未配置 LLM 提供商' }
    }

    try {
      onProgress?.('全局摘要', '正在生成全局知识摘要...')

      const docSummaries = this.db.getDb().prepare(
        'SELECT ds.*, d.original_name as title FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
      ).all(kbId) as any[]

      if (docSummaries.length === 0) {
        return { success: false, error: '没有已处理的文档摘要，请先处理文档' }
      }

      const summaryInputs = docSummaries.map(ds => ({
        title: ds.title,
        summary: ds.summary,
        keyEntities: JSON.parse(ds.key_entities_json || '[]'),
        mainTopics: JSON.parse(ds.main_topics_json || '[]'),
      }))

      const globalSummary = await this.processor.generateGlobalSummary(
        summaryInputs, kb.name, provider, modelId, onProgress
      )

      this.processor.saveGlobalSummary(kbId, globalSummary)

      onProgress?.('完成', '全局知识构建完成')
      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
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
          errors.push({ docId, error: '文档不存在' })
          continue
        }
        if (doc.parse_status !== 'completed') {
          errors.push({ docId, error: '文档尚未解析完成' })
          continue
        }

        const kbBasePath = this.getKBBasePath(doc.kb_id)
        const filePath = path.join(kbBasePath, doc.original_name)

        if (!fs.existsSync(filePath)) {
          errors.push({ docId, error: '源文件不存在于磁盘' })
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

  private getDefaultProviderId(): string | null {
    return getDefaultProviderId(this.db)
  }
}

export default KnowledgeBaseService
