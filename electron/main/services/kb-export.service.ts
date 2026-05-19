import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import KBDatabaseService from './kb-database.service'
import PathService from './path.service'
import { generateId } from './common-utils'
import type Database from 'better-sqlite3'
import type KBDocumentService from './kb-document.service'

export interface KBExportServiceDeps {
  db: Database.Database
  kbDb: KBDatabaseService
  getKB: (id: string) => any | null
  createKB: (name: string, description?: string) => any | null
}

class KBExportService {
  private db: Database.Database
  private getKBCallback: (id: string) => any | null
  private createKBCallback: (name: string, description?: string) => any | null
  private documentService: KBDocumentService | null = null

  private safeJsonParse(json: string | null | undefined, fallback: any = []): any {
    if (!json) return fallback
    try {
      return JSON.parse(json)
    } catch {
      return fallback
    }
  }

  constructor(deps: KBExportServiceDeps) {
    this.db = deps.db
    this.getKBCallback = deps.getKB
    this.createKBCallback = deps.createKB
  }

  setDocumentService(documentService: KBDocumentService): void {
    this.documentService = documentService
  }

  private getKBBasePath(kbId: string): string {
    return PathService.getInstance().getKBBasePath(kbId)
  }

  private readDocParsedJson(parsedJsonPath: string): string | null {
    if (!parsedJsonPath || !fs.existsSync(parsedJsonPath)) return null
    try {
      return fs.readFileSync(parsedJsonPath, 'utf-8')
    } catch {
      return null
    }
  }

  private saveDocParsedJson(docId: string, kbId: string, parsedJson: string): string {
    const dir = path.join(this.getKBBasePath(kbId), '_parsed', docId)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const parsedJsonPath = path.join(dir, 'parsed.json')
    fs.writeFileSync(parsedJsonPath, parsedJson, 'utf-8')
    return parsedJsonPath
  }

  async exportKBFull(
    kbId: string,
    exportPath: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const kb = this.getKBCallback(kbId)
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

      const documents = this.db.prepare(
        'SELECT * FROM kb_documents WHERE kb_id = ?'
      ).all(kbId) as any[]

      const paragraphs = this.db.prepare(
        'SELECT * FROM kb_paragraphs WHERE kb_id = ?'
      ).all(kbId) as any[]

      const docSummaries = this.db.prepare(
        'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
      ).all(kbId) as any[]

      const globalSummary = this.db.prepare(
        'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
      ).get(kbId) as any

      onProgress?.('collecting', `Collected ${documents.length} documents, ${paragraphs.length} paragraphs`)

      const knowledgeData = {
        documents: documents.map(d => ({
          id: d.id,
          original_name: d.original_name,
          type: d.type,
          size: d.size,
          hash: d.hash,
          parsed_json: d.parsed_json_path ? this.readDocParsedJson(d.parsed_json_path) : null,
          parse_status: d.parse_status,
          created_at: d.created_at,
          updated_at: d.updated_at,
        })),
        paragraphs,
        docSummaries,
        globalSummary: globalSummary || null,
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
      onProgress?.('complete', `Export complete: ${documents.length} documents, ${paragraphs.length} paragraphs`)

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
    const kb = this.getKBCallback(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      onProgress?.('preparing', 'Preparing summary export...')

      const globalSummary = this.db.prepare(
        'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
      ).get(kbId) as any

      const docSummaries = this.db.prepare(
        'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
      ).all(kbId) as any[]

      const paragraphs = this.db.prepare(
        'SELECT id, kb_id, document_id, title, title_path, level, paragraph_index, summary, keywords_json FROM kb_paragraphs WHERE kb_id = ?'
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
          'document': 'https://workavatar.ai/ontology/document',
          'paragraph': 'https://workavatar.ai/ontology/paragraph',
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
            keyTopics: this.safeJsonParse(globalSummary.key_topics_json),
          })
        }

        for (const ds of docSummaries) {
          graph.push({
            '@id': `kb:${kbId}/doc/${ds.document_id}/summary`,
            '@type': 'DocumentSummary',
            summary: ds.summary,
            toc: this.safeJsonParse(ds.toc_json),
            keywords: this.safeJsonParse(ds.keywords_json),
            mainTopics: this.safeJsonParse(ds.main_topics_json),
          })
        }

        for (const p of paragraphs) {
          graph.push({
            '@id': `kb:${kbId}/paragraph/${p.id}`,
            '@type': 'Paragraph',
            title: p.title,
            titlePath: p.title_path,
            level: p.level,
            summary: p.summary,
            keywords: this.safeJsonParse(p.keywords_json),
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
        csvLines.push('summary,key_topics')
        if (globalSummary) {
          csvLines.push(`"${(globalSummary.summary || '').replace(/"/g, '""')}","${JSON.stringify(this.safeJsonParse(globalSummary.key_topics_json)).replace(/"/g, '""')}"`)
        }
        csvLines.push('')

        csvLines.push('=== Document Summaries ===')
        csvLines.push('document_id,summary,keywords,main_topics')
        for (const ds of docSummaries) {
          csvLines.push(`"${ds.document_id}","${(ds.summary || '').replace(/"/g, '""')}","${JSON.stringify(this.safeJsonParse(ds.keywords_json)).replace(/"/g, '""')}","${JSON.stringify(this.safeJsonParse(ds.main_topics_json)).replace(/"/g, '""')}"`)
        }
        csvLines.push('')

        csvLines.push('=== Paragraphs ===')
        csvLines.push('document_id,title,title_path,level,summary,keywords')
        for (const p of paragraphs) {
          csvLines.push(`"${p.document_id}","${(p.title || '').replace(/"/g, '""')}","${(p.title_path || '').replace(/"/g, '""')}",${p.level},"${(p.summary || '').replace(/"/g, '""')}","${JSON.stringify(this.safeJsonParse(p.keywords_json)).replace(/"/g, '""')}"`)
        }

        fs.writeFileSync(exportPath, csvLines.join('\n'), 'utf-8')
      }

      onProgress?.('complete', `Summary export complete: ${docSummaries.length} document summaries, ${paragraphs.length} paragraphs`)
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
    const kb = this.getKBCallback(kbId)
    if (!kb) return { success: false, error: 'Knowledge base not found' }

    try {
      let docs: any[]
      if (docIds && docIds.length > 0) {
        const placeholders = docIds.map(() => '?').join(',')
        docs = this.db.prepare(
          `SELECT * FROM kb_documents WHERE kb_id = ? AND id IN (${placeholders})`
        ).all(kbId, ...docIds) as any[]
      } else {
        docs = this.db.prepare(
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

      let manifest: any
      try {
        manifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
      } catch (e) {
        return { success: false, error: `Invalid manifest.json: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (manifest.type !== 'workavatar-kb-full') {
        return { success: false, error: 'Invalid archive: not a WorkAvatar knowledge base export' }
      }

      const dataEntry = zip.getEntry('knowledge-data.json')
      if (!dataEntry) {
        return { success: false, error: 'Invalid archive: knowledge-data.json not found' }
      }

      let knowledgeData: any
      try {
        knowledgeData = JSON.parse(dataEntry.getData().toString('utf-8'))
      } catch (e) {
        return { success: false, error: `Invalid knowledge-data.json: ${e instanceof Error ? e.message : String(e)}` }
      }

      onProgress?.('creating_kb', 'Creating knowledge base...')
      const newKBName = kbName || manifest.kb?.name || 'Imported Knowledge Base'
      const newKB = this.createKBCallback(newKBName, manifest.kb?.description || '')
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
        const newDocId = generateId()
        docIdMap.set(doc.id, newDocId)

        const docEntry = zip.getEntry(`documents/${doc.original_name}`)
        if (docEntry) {
          const destPath = path.join(kbBasePath, doc.original_name)
          fs.writeFileSync(destPath, docEntry.getData())
        }

        const now = Math.floor(Date.now() / 1000)
        let parsedJsonPath: string | null = null
        if (doc.parsed_json) {
          parsedJsonPath = this.saveDocParsedJson(newDocId, newKBId, doc.parsed_json)
        }

        this.db.prepare(`
          INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, parsed_json_path, parse_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newDocId, newKBId, doc.original_name, doc.type, doc.size, doc.hash,
          parsedJsonPath, doc.parse_status || 'pending',
          doc.created_at || now, doc.updated_at || now)

        if ((i + 1) % 5 === 0 || i === documents.length - 1) {
          onProgress?.('importing_docs', `Imported ${i + 1}/${documents.length} documents...`)
        }
      }

      onProgress?.('importing_paragraphs', `Importing ${knowledgeData.paragraphs?.length || 0} paragraphs...`)
      const paragraphs = knowledgeData.paragraphs || []
      for (let i = 0; i < paragraphs.length; i++) {
        const p = paragraphs[i]
        const newDocId = docIdMap.get(p.document_id)
        if (!newDocId) continue

        const newParagraphId = generateId()

        this.db.prepare(`
          INSERT INTO kb_paragraphs (id, kb_id, document_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, summary, keywords_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(newParagraphId, newKBId, newDocId, p.title, p.title_path || '',
          p.level || 1, p.paragraph_index,
          p.start_offset, p.end_offset, p.content || '',
          p.summary || null, p.keywords_json || '[]')

        if ((i + 1) % 20 === 0 || i === paragraphs.length - 1) {
          onProgress?.('importing_paragraphs', `Imported ${i + 1}/${paragraphs.length} paragraphs...`)
        }
      }

      onProgress?.('importing_summaries', 'Importing document summaries...')
      const docSummaries = knowledgeData.docSummaries || []
      for (const ds of docSummaries) {
        const newDocId = docIdMap.get(ds.document_id)
        if (!newDocId) continue

        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, toc_json, keywords_json, main_topics_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, newKBId, newDocId, ds.summary || '',
          ds.toc_json || '[]', ds.keywords_json || '[]', ds.main_topics_json || '[]')
      }

      if (knowledgeData.globalSummary) {
        onProgress?.('importing_global', 'Importing global summary...')
        const gs = knowledgeData.globalSummary
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, newKBId, gs.summary || '', gs.key_topics_json || '[]')
      }

      onProgress?.('building_index', 'Building search index...')
      if (this.documentService) {
        await this.documentService.rebuildSearchIndex(newKBId)
      }

      onProgress?.('complete', `Import complete: ${documents.length} documents, ${paragraphs.length} paragraphs`)
      return { success: true, kbId: newKBId }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }
}

export default KBExportService
