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
import { generateId } from './common-utils'
import KBDocumentService from './kb-document.service'
import KBParagraphService from './kb-paragraph.service'
import KBSummaryService from './kb-summary.service'
import KBExportService from './kb-export.service'
import type { SearchResult } from './search-engine.service'

class KnowledgeBaseService {
  private mainDb: DatabaseService
  private kbDb: KBDatabaseService
  private searchEngine: SearchEngineService
  private processor: KnowledgeProcessorService
  private static instance: KnowledgeBaseService
  private defaultKBId: string | null = null

  private documentService: KBDocumentService
  private paragraphService: KBParagraphService
  private summaryService: KBSummaryService
  private exportService: KBExportService

  private constructor() {
    this.mainDb = DatabaseService.getInstance()
    this.kbDb = KBDatabaseService.getInstance()
    this.searchEngine = SearchEngineService.getInstance()
    this.processor = KnowledgeProcessorService.getInstance()

    const db = this.kbDb.getDb()
    const fileParser = FileParserService.getInstance()
    const parseTaskManager = ParseTaskManager.getInstance()
    const taskQueue = TaskQueueService.getInstance()

    this.documentService = new KBDocumentService({
      db,
      mainDb: this.mainDb,
      kbDb: this.kbDb,
      fileParser,
      processor: this.processor,
      parseTaskManager,
      taskQueue,
      searchEngine: this.searchEngine,
      llmClient: LLMClientService.getInstance(),
      ensureDefaultKB: () => this.ensureDefaultKB(),
    })

    this.paragraphService = new KBParagraphService(this.processor)

    this.summaryService = new KBSummaryService({
      db,
      mainDb: this.mainDb,
      processor: this.processor,
      taskQueue,
    })

    this.exportService = new KBExportService({
      db,
      kbDb: this.kbDb,
      getKB: (id: string) => this.getKB(id),
      createKB: (name: string, description?: string) => this.createKB(name, description),
    })
    this.exportService.setDocumentService(this.documentService)
  }

  static getInstance(): KnowledgeBaseService {
    if (!KnowledgeBaseService.instance) {
      KnowledgeBaseService.instance = new KnowledgeBaseService()
    }
    return KnowledgeBaseService.instance
  }

  private get db() {
    return this.kbDb.getDb()
  }

  ensureDefaultKB(): string {
    if (this.defaultKBId) return this.defaultKBId

    const existing = this.db.prepare(
      "SELECT id FROM knowledge_bases ORDER BY created_at ASC LIMIT 1"
    ).get() as { id: string } | undefined

    if (existing?.id) {
      this.defaultKBId = existing.id
      return existing.id
    }

    const kb = this.createKB('默认知识库', '系统默认知识库，新员工可自动关联')
    this.defaultKBId = kb?.id || ''
    return kb?.id || ''
  }

  getDefaultKBId(): string {
    return this.ensureDefaultKB()
  }

  listKBs(): any[] {
    return this.db.prepare(
      'SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count FROM knowledge_bases kb ORDER BY kb.updated_at DESC'
    ).all()
  }

  getKB(id: string): any | null {
    return this.db.prepare(
      'SELECT kb.*, (SELECT COUNT(*) FROM kb_documents WHERE kb_id = kb.id) as doc_count FROM knowledge_bases kb WHERE kb.id = ?'
    ).get(id) || null
  }

  createKB(name: string, description: string = ''): any | null {
    const kbId = generateId()
    const kbPath = PathService.getInstance().getKBBasePath(kbId)
    const now = Math.floor(Date.now() / 1000)

    this.db.prepare(`
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
      this.db.prepare(`UPDATE knowledge_bases SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    }

    return this.getKB(id)
  }

  deleteKB(id: string): boolean {
    this.searchEngine.deleteIndexByKb(id)
    this.processor.deleteKnowledgeData(id)

    const docs = this.db.prepare('SELECT id, original_name FROM kb_documents WHERE kb_id = ?').all(id) as any[]
    const kbBasePath = PathService.getInstance().getKBBasePath(id)
    for (const doc of docs) {
      const parseDir = path.join(kbBasePath, '_parsed', doc.id)
      if (fs.existsSync(parseDir)) {
        try { fs.rmSync(parseDir, { recursive: true, force: true }) } catch {}
      }
      try {
        const filePath = path.join(kbBasePath, doc.original_name)
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      } catch {}
    }

    const parsedDir = path.join(kbBasePath, '_parsed')
    if (fs.existsSync(parsedDir)) {
      try { fs.rmSync(parsedDir, { recursive: true, force: true }) } catch {}
    }

    if (fs.existsSync(kbBasePath)) {
      try { fs.rmSync(kbBasePath, { recursive: true, force: true }) } catch {}
    }

    const result = this.db.prepare('DELETE FROM knowledge_bases WHERE id = ?').run(id)
    return result.changes > 0
  }

  async getExistingDocByHash(hash: string, kbId?: string) { return this.documentService.getExistingDocByHash(hash, kbId) }
  async getExistingDocByName(kbId: string, originalName: string) { return this.documentService.getExistingDocByName(kbId, originalName) }
  async scanFolder(folderPath: string) { return this.documentService.scanFolder(folderPath) }
  async uploadDocuments(kbId: string, filePaths: string[], onProgress?: (current: number, total: number, fileName: string) => void) { return this.documentService.uploadDocuments(kbId, filePaths, onProgress) }
  async parseDocument(docId: string, isResume: boolean = false) { return this.documentService.parseDocument(docId, isResume) }
  async parseAllDocuments(kbId: string) { return this.documentService.parseAllDocuments(kbId) }
  async processDocument(docId: string, providerId?: string, modelId?: string, enableThinking?: boolean) { return this.documentService.processDocument(docId, providerId, modelId, enableThinking) }
  async processAllDocuments(kbId: string, providerId?: string, modelId?: string, enableThinking?: boolean) { return this.documentService.processAllDocuments(kbId, providerId, modelId, enableThinking) }
  deleteDocument(docId: string) { return this.documentService.deleteDocument(docId) }
  getDocumentList(kbId: string, status?: string) { return this.documentService.getDocumentList(kbId, status) }
  getDocumentContent(docId: string) { return this.documentService.getDocumentContent(docId) }
  getParsedJson(docId: string) { return this.documentService.getParsedJson(docId) }
  async importOrSyncToKB(filePath: string, options?: { contentText?: string; parsedJson?: string }) { return this.documentService.importOrSyncToKB(filePath, options) }
  searchParagraphs(kbId: string, query: string, topK: number = 5): SearchResult[] { return this.documentService.searchParagraphs(kbId, query, topK) }
  searchDocumentSummaries(kbId: string, query: string, topK: number = 5): SearchResult[] { return this.documentService.searchDocumentSummaries(kbId, query, topK) }
  search(kbId: string, query: string, topK: number = 10, documentIds?: string[], sourceTypes?: string[]): SearchResult[] { return this.documentService.search(kbId, query, topK, documentIds, sourceTypes) }
  async searchWithEmbedding(kbId: string, query: string, topK: number = 10, documentIds?: string[], providerId?: string) { return this.documentService.searchWithEmbedding(kbId, query, topK, documentIds, providerId) }

  getSearchIndexStats(kbId: string) { return this.documentService.getSearchIndexStats(kbId) }
  async rebuildSearchIndex(kbId: string) { return this.documentService.rebuildSearchIndex(kbId) }
  async rebuildEmbeddings(kbId: string) { return this.documentService.rebuildEmbeddings(kbId) }
  pauseParse(docId: string) { return this.documentService.pauseParse(docId) }
  resumeParse(docId: string) { return this.documentService.resumeParse(docId) }
  retryParse(docId: string) { return this.documentService.retryParse(docId) }
  getParseProgress(docId: string) { return this.documentService.getParseProgress(docId) }
  pauseAllParses() { return this.documentService.pauseAllParses() }
  resumeAllParses() { return this.documentService.resumeAllParses() }
  cancelAllParses() { return this.documentService.cancelAllParses() }
  getPausedDocIds() { return this.documentService.getPausedDocIds() }

  getParagraphs(documentId: string) { return this.paragraphService.getParagraphs(documentId) }
  getParagraphsByKb(kbId: string) { return this.processor.getParagraphsByKb(kbId) }
  updateParagraph(paragraphId: string, updates: { summary?: string; keywords_json?: string; content?: string; title?: string }) { return this.processor.updateParagraph(paragraphId, updates) }
  updateDocumentSummary(documentId: string, updates: { summary?: string; keywords_json?: string; main_topics_json?: string }) { return this.processor.updateDocumentSummary(documentId, updates) }

  getKnowledgeStats(kbId: string) { return this.summaryService.getKnowledgeStats(kbId) }
  getDocumentSummary(documentId: string) { return this.summaryService.getDocumentSummary(documentId) }
  getGlobalSummary(kbId: string) { return this.summaryService.getGlobalSummary(kbId) }
  getProcessingJobs(kbId: string, status?: string) { return this.summaryService.getProcessingJobs(kbId, status) }
  async buildGlobalKnowledge(kbId: string, providerId?: string, modelId?: string, enableThinking?: boolean) {
    const kb = this.getKB(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }
    return this.summaryService.buildGlobalKnowledge(kbId, kb.name, providerId, modelId, enableThinking)
  }

  async exportKBFull(kbId: string, exportPath: string, onProgress?: (stage: string, detail: string) => void) { return this.exportService.exportKBFull(kbId, exportPath, onProgress) }
  async exportKBSummary(kbId: string, exportPath: string, format: 'json-ld' | 'csv', onProgress?: (stage: string, detail: string) => void) { return this.exportService.exportKBSummary(kbId, exportPath, format, onProgress) }
  async exportKBDocuments(kbId: string, exportPath: string, docIds?: string[], onProgress?: (stage: string, detail: string) => void) { return this.exportService.exportKBDocuments(kbId, exportPath, docIds, onProgress) }
  async importKBFull(importPath: string, kbName?: string, conflictStrategy?: 'skip' | 'overwrite' | 'rename', onProgress?: (stage: string, detail: string) => void) { return this.exportService.importKBFull(importPath, kbName, conflictStrategy, onProgress) }
}

export default KnowledgeBaseService
