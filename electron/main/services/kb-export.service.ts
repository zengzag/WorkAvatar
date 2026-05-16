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

      const chapters = this.db.prepare(
        'SELECT * FROM kb_chapters WHERE kb_id = ?'
      ).all(kbId) as any[]

      const docSummaries = this.db.prepare(
        'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
      ).all(kbId) as any[]

      const globalSummary = this.db.prepare(
        'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
      ).get(kbId) as any

      const entities = this.db.prepare(
        'SELECT * FROM kb_entities WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityRelations = this.db.prepare(
        'SELECT * FROM kb_entity_relations WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityMentions = this.db.prepare(
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
          parsed_json: d.parsed_json_path ? this.readDocParsedJson(d.parsed_json_path) : null,
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

      const entities = this.db.prepare(
        'SELECT * FROM kb_entities WHERE kb_id = ?'
      ).all(kbId) as any[]

      const entityRelations = this.db.prepare(
        'SELECT * FROM kb_entity_relations WHERE kb_id = ?'
      ).all(kbId) as any[]

      const chapters = this.db.prepare(
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

      onProgress?.('importing_chapters', `Importing ${knowledgeData.chapters?.length || 0} chapters...`)
      const chapters = knowledgeData.chapters || []
      const chapterIdMap = new Map<string, string>()
      for (let i = 0; i < chapters.length; i++) {
        const ch = chapters[i]
        const newDocId = docIdMap.get(ch.document_id)
        if (!newDocId) continue

        const newChapterId = generateId()
        chapterIdMap.set(ch.id, newChapterId)

        this.db.prepare(`
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

        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, key_entities_json, timeline_json, keywords_json, main_topics_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
        `).run(id, newKBId, newDocId, ds.summary || '',
          ds.key_entities_json || '[]', ds.timeline_json || '[]',
          ds.keywords_json || '[]', ds.main_topics_json || '[]')
      }

      if (knowledgeData.globalSummary) {
        onProgress?.('importing_global', 'Importing global summary...')
        const gs = knowledgeData.globalSummary
        const id = generateId()
        this.db.prepare(`
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
        const newEntityId = generateId()
        entityIdMap.set(entity.id, newEntityId)

        this.db.prepare(`
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

        const id = generateId()
        this.db.prepare(`
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

        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_entity_mentions (id, entity_id, document_id, chapter_id, context_text, start_offset, end_offset, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
        `).run(id, newEntityId, newDocId || null, newChapterId || null,
          m.context_text || null, m.start_offset, m.end_offset)
      }

      onProgress?.('building_index', 'Building search index...')
      if (this.documentService) {
        await this.documentService.rebuildSearchIndex(newKBId)
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
    const kb = this.getKBCallback(kbId)
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
        const lines = content.split('\n').filter((l: string) => l.trim() && !l.startsWith('#'))
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
      const existingEntities = this.db.prepare(
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
            this.db.prepare(`
              UPDATE kb_entities SET type = ?, description = ?, aliases_json = ?, attributes_json = ?, updated_at = unixepoch()
              WHERE id = ?
            `).run(entity.type, entity.description, JSON.stringify(entity.aliases), JSON.stringify(entity.attributes), existingId)
          } else if (conflictStrategy === 'merge') {
            const existing = this.db.prepare('SELECT * FROM kb_entities WHERE id = ?').get(existingId) as any
            if (existing) {
              const existingAliases: string[] = JSON.parse(existing.aliases_json || '[]')
              const newAliases = entity.aliases.filter(a => !existingAliases.includes(a))
              this.db.prepare(`
                UPDATE kb_entities SET aliases_json = ?, mention_count = mention_count + 1, updated_at = unixepoch()
                WHERE id = ?
              `).run(JSON.stringify([...existingAliases, ...newAliases]), existingId)
            }
          }
        } else {
          const id = generateId()
          this.db.prepare(`
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

        if (!sourceId || !targetId) continue

        const existingRelation = this.db.prepare(
          'SELECT id FROM kb_entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?'
        ).get(sourceId, targetId, relation.relationType) as any

        if (existingRelation) {
          if (conflictStrategy === 'overwrite') {
            this.db.prepare(`
              UPDATE kb_entity_relations SET description = ?, created_at = unixepoch()
              WHERE id = ?
            `).run(relation.description, existingRelation.id)
          }
          continue
        }

        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_entity_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, created_at)
          VALUES (?, ?, ?, ?, ?, ?, unixepoch())
        `).run(id, kbId, sourceId, targetId, relation.relationType, relation.description)
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

export default KBExportService
