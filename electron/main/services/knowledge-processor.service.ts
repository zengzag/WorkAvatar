import KBDatabaseService from './kb-database.service'
import { generateId } from './common-utils'
import LLMClientService from './llm-client.service'
import SearchEngineService from './search-engine.service'

interface ChapterInfo {
  title: string
  index: number
  startOffset: number
  endOffset: number
  content: string
  level: number
}

interface ChapterSummary {
  title: string
  summary: string
  keywords: string[]
  entities: Array<{
    name: string
    type: string
    description: string
  }>
}

interface DocumentSummary {
  summary: string
  keyEntities: Array<{
    name: string
    type: string
    description: string
  }>
  timeline: Array<{
    time: string
    event: string
  }>
  keywords: string[]
  mainTopics: string[]
}

interface EntityExtraction {
  entities: Array<{
    name: string
    type: string
    description: string
    aliases: string[]
    attributes: Record<string, string>
  }>
  relations: Array<{
    source: string
    target: string
    relationType: string
    description: string
  }>
}

class KnowledgeProcessorService {
  private kbDb: KBDatabaseService
  private llmClient: LLMClientService
  private searchEngine: SearchEngineService
  private static instance: KnowledgeProcessorService

  private get db() { return this.kbDb.getDb() }

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
    this.searchEngine = SearchEngineService.getInstance()
  }

  static getInstance(): KnowledgeProcessorService {
    if (!KnowledgeProcessorService.instance) {
      KnowledgeProcessorService.instance = new KnowledgeProcessorService()
    }
    return KnowledgeProcessorService.instance
  }

  identifyChapters(text: string): ChapterInfo[] {
    const chapters: ChapterInfo[] = []
    const lines = text.split('\n')
    let currentOffset = 0
    const headingPositions: Array<{ title: string; offset: number; level: number; lineIndex: number }> = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = line.match(/^(#{1,4})\s+(.+)/)
      if (match) {
        headingPositions.push({
          title: match[2].trim(),
          offset: currentOffset,
          level: match[1].length,
          lineIndex: i,
        })
      }
      currentOffset += line.length + 1
    }

    if (headingPositions.length === 0) {
      const chunkSize = 5000
      const chunks = this.splitIntoChunks(text, chunkSize, 500)
      for (let i = 0; i < chunks.length; i++) {
        const startOff = text.indexOf(chunks[i])
        chapters.push({
          title: `段落 ${i + 1}`,
          index: i,
          startOffset: startOff >= 0 ? startOff : i * (chunkSize - 500),
          endOffset: startOff >= 0 ? startOff + chunks[i].length : (i + 1) * chunkSize,
          content: chunks[i],
          level: 1,
        })
      }
      return chapters
    }

    for (let i = 0; i < headingPositions.length; i++) {
      const heading = headingPositions[i]
      const nextHeading = headingPositions[i + 1]
      const startOff = heading.offset
      const endOff = nextHeading ? nextHeading.offset : text.length
      const content = text.substring(startOff, endOff).trim()

      if (content.length > 50) {
        chapters.push({
          title: heading.title,
          index: i,
          startOffset: startOff,
          endOffset: endOff,
          content,
          level: heading.level,
        })
      }
    }

    if (chapters.length === 0) {
      chapters.push({
        title: '全文',
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        content: text,
        level: 1,
      })
    }

    return chapters
  }

  async generateChapterSummary(
    chapterContent: string,
    chapterTitle: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<ChapterSummary> {
    onProgress?.('chapter_summary', `Generating chapter summary: ${chapterTitle}`)

    const prompt = `为以下章节生成摘要，JSON格式返回�?
章节标题�?{chapterTitle}
章节内容�?${chapterContent.substring(0, 8000)}

返回字段�?- title: 章节标题
- summary: 摘要�?00-500字）
- keywords: 关键词列�?- entities: 实体列表，每个含 name、type(person/organization/location/event/concept/other)、description

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], { 
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON<ChapterSummary>(result, {
        title: chapterTitle,
        summary: '',
        keywords: [],
        entities: [],
      })
    } catch (error) {
      throw new Error(`Chapter summary generation failed (${chapterTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async generateDocumentSummary(
    chapterSummaries: ChapterSummary[],
    documentTitle: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<DocumentSummary> {
    onProgress?.('doc_summary', `Generating document summary: ${documentTitle}`)

    const summariesText = chapterSummaries.map((cs, i) =>
      `### 章节${i + 1}: ${cs.title}\n${cs.summary}\n关键�? ${cs.keywords.join(', ')}\n实体: ${cs.entities.map(e => `${e.name}(${e.type})`).join(', ')}`
    ).join('\n\n')

    const prompt = `基于章节摘要生成文档全局摘要，JSON格式返回�?
文档标题�?{documentTitle}
章节摘要�?${summariesText.substring(0, 15000)}

返回字段�?- summary: 全局摘要�?00-800字）
- keyEntities: 实体列表，每个含 name、type、description
- timeline: 事件列表，每个含 time、event
- keywords: 关键词列�?- mainTopics: 主要主题列表

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], { 
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON<DocumentSummary>(result, {
        summary: '',
        keyEntities: [],
        timeline: [],
        keywords: [],
        mainTopics: [],
      })
    } catch (error) {
      throw new Error(`Document summary generation failed (${documentTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async extractEntities(
    text: string,
    sourceTitle: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<EntityExtraction> {
    onProgress?.('entity_extract', `Extracting entities: ${sourceTitle}`)

    const prompt = `从文本中提取实体及关系，JSON格式返回�?
来源�?{sourceTitle}
文本内容�?${text.substring(0, 10000)}

返回字段�?- entities: 实体列表，每个含 name、type(person/organization/location/event/concept/tool/other)、description、aliases、attributes
- relations: 关系列表，每个含 source、target、relationType、description

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer specializing in entity extraction and relationship mapping. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], { 
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON<EntityExtraction>(result, { entities: [], relations: [] })
    } catch (error) {
      throw new Error(`Entity extraction failed (${sourceTitle}): ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async generateGlobalSummary(
    documentSummaries: Array<{ title: string; summary: string; keyEntities: any[]; mainTopics: string[] }>,
    kbName: string,
    providerId: string,
    modelId?: string,
    enableThinking?: boolean,
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<{
    summary: string
    keyTopics: string[]
    keyEntities: Array<{ name: string; type: string; description: string }>
    globalTimeline: Array<{ time: string; event: string }>
  }> {
    onProgress?.('global_summary', 'Generating global knowledge summary...')

    const docsText = documentSummaries.map((ds, i) =>
      `### 文档${i + 1}: ${ds.title}\n${ds.summary}\n主要主题: ${ds.mainTopics.join(', ')}\n关键实体: ${ds.keyEntities.map(e => `${e.name}(${e.type})`).join(', ')}`
    ).join('\n\n')

    const prompt = `基于文档摘要生成知识库全局摘要，JSON格式返回�?
知识库名称：${kbName}
文档摘要�?${docsText.substring(0, 20000)}

返回字段�?- summary: 全局摘要�?00-1500字）
- keyTopics: 核心主题列表
- keyEntities: 实体列表，每个含 name、type、description
- globalTimeline: 时间线，每个�?time、event

只返回JSON。`

    try {
      const result = await this.llmClient.chat(providerId, [
        { role: 'system', content: 'You are a professional knowledge engineer specializing in cross-document knowledge integration. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ], { 
        ...(modelId ? { model: modelId } : {}),
        enable_thinking: enableThinking,
      })

      return this.parseJSON(result, {
        summary: '',
        keyTopics: [],
        keyEntities: [],
        globalTimeline: [],
      })
    } catch (error) {
      throw new Error(`Global summary generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  saveChapters(kbId: string, documentId: string, chapters: ChapterInfo[], summaries: ChapterSummary[]): void {
    const existingChapters = this.db.prepare(
      'SELECT id FROM kb_chapters WHERE document_id = ?'
    ).all(documentId) as any[]

    if (existingChapters.length > 0) {
      this.db.prepare('DELETE FROM kb_chapters WHERE document_id = ?').run(documentId)
    }

    const insertStmt = this.db.prepare(`
      INSERT INTO kb_chapters (id, kb_id, document_id, title, chapter_index, start_offset, end_offset, content, summary, keywords_json, entities_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `)

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]
      const summary = summaries[i]
      const id = generateId()

      insertStmt.run(
        id,
        kbId,
        documentId,
        chapter.title,
        chapter.index,
        chapter.startOffset,
        chapter.endOffset,
        chapter.content,
        summary?.summary || null,
        JSON.stringify(summary?.keywords || []),
        JSON.stringify(summary?.entities || []),
      )

      this.searchEngine.indexChapter(
        kbId,
        documentId,
        id,
        chapter.title,
        summary?.summary || '',
        summary?.keywords || [],
        summary?.entities || [],
        chapter.startOffset,
        chapter.endOffset
      )
    }
  }

  saveDocumentSummary(kbId: string, documentId: string, docSummary: DocumentSummary): void {
    const existing = this.db.prepare(
      'SELECT id FROM kb_document_summaries WHERE document_id = ?'
    ).get(documentId) as any

    const data = {
      summary: docSummary.summary,
      key_entities_json: JSON.stringify(docSummary.keyEntities),
      timeline_json: JSON.stringify(docSummary.timeline),
      keywords_json: JSON.stringify(docSummary.keywords),
      main_topics_json: JSON.stringify(docSummary.mainTopics),
    }

    if (existing) {
      this.db.prepare(`
        UPDATE kb_document_summaries SET summary = ?, key_entities_json = ?, timeline_json = ?, keywords_json = ?, main_topics_json = ?, updated_at = unixepoch()
        WHERE document_id = ?
      `).run(data.summary, data.key_entities_json, data.timeline_json, data.keywords_json, data.main_topics_json, documentId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, key_entities_json, timeline_json, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, documentId, data.summary, data.key_entities_json, data.timeline_json, data.keywords_json, data.main_topics_json)
    }

    this.searchEngine.indexDocumentSummary(
      kbId,
      documentId,
      docSummary.summary,
      docSummary.keywords,
      docSummary.mainTopics
    )
  }

  saveGlobalSummary(kbId: string, globalSummary: {
    summary: string
    keyTopics: string[]
    keyEntities: any[]
    globalTimeline: any[]
  }): void {
    const existing = this.db.prepare(
      'SELECT id FROM kb_global_summaries WHERE kb_id = ?'
    ).get(kbId) as any

    const data = {
      summary: globalSummary.summary,
      key_topics_json: JSON.stringify(globalSummary.keyTopics),
      key_entities_json: JSON.stringify(globalSummary.keyEntities),
      global_timeline_json: JSON.stringify(globalSummary.globalTimeline),
    }

    if (existing) {
      this.db.prepare(`
        UPDATE kb_global_summaries SET summary = ?, key_topics_json = ?, key_entities_json = ?, global_timeline_json = ?, updated_at = unixepoch()
        WHERE kb_id = ?
      `).run(data.summary, data.key_topics_json, data.key_entities_json, data.global_timeline_json, kbId)
    } else {
      const id = generateId()
      this.db.prepare(`
        INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, key_entities_json, global_timeline_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(id, kbId, data.summary, data.key_topics_json, data.key_entities_json, data.global_timeline_json)
    }
  }

  saveEntities(kbId: string, documentId: string, extraction: EntityExtraction): void {
    const entityNameToId = new Map<string, string>()

    const existingEntities = this.db.prepare(
      'SELECT id, name FROM kb_entities WHERE kb_id = ?'
    ).all(kbId) as any[]

    for (const e of existingEntities) {
      entityNameToId.set(e.name.toLowerCase(), e.id)
    }

    for (const entity of extraction.entities) {
      const existingId = entityNameToId.get(entity.name.toLowerCase())

      if (existingId) {
        const existing = this.db.prepare('SELECT * FROM kb_entities WHERE id = ?').get(existingId) as any
        const existingAliases: string[] = JSON.parse(existing.aliases_json || '[]')
        const newAliases = entity.aliases.filter(a => !existingAliases.includes(a))

        this.db.prepare(`
          UPDATE kb_entities SET mention_count = mention_count + 1, aliases_json = ?, description = ?, updated_at = unixepoch()
          WHERE id = ?
        `).run(
          JSON.stringify([...existingAliases, ...newAliases]),
          entity.description || existing.description,
          existingId,
        )

        this.searchEngine.indexEntity(
          kbId,
          existingId,
          entity.name,
          entity.type,
          entity.description || existing.description,
          [...existingAliases, ...newAliases],
          documentId
        )
      } else {
        const id = generateId()
        this.db.prepare(`
          INSERT INTO kb_entities (id, kb_id, name, type, description, aliases_json, attributes_json, mention_count, first_seen_doc_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())
        `).run(id, kbId, entity.name, entity.type, entity.description, JSON.stringify(entity.aliases), JSON.stringify(entity.attributes), documentId)

        entityNameToId.set(entity.name.toLowerCase(), id)

        this.searchEngine.indexEntity(
          kbId,
          id,
          entity.name,
          entity.type,
          entity.description,
          entity.aliases,
          documentId
        )
      }
    }

    for (const alias of extraction.entities.flatMap(e => e.aliases)) {
      if (!entityNameToId.has(alias.toLowerCase())) {
        const parentEntity = extraction.entities.find(e => e.aliases.includes(alias))
        if (parentEntity) {
          const parentId = entityNameToId.get(parentEntity.name.toLowerCase())
          if (parentId) {
            entityNameToId.set(alias.toLowerCase(), parentId)
          }
        }
      }
    }

    for (const relation of extraction.relations) {
      const sourceId = entityNameToId.get(relation.source.toLowerCase())
      const targetId = entityNameToId.get(relation.target.toLowerCase())

      if (sourceId && targetId && sourceId !== targetId) {
        const existingRelation = this.db.prepare(
          'SELECT id FROM kb_entity_relations WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?'
        ).get(sourceId, targetId, relation.relationType) as any

        if (!existingRelation) {
          const id = generateId()
          this.db.prepare(`
            INSERT INTO kb_entity_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, source_document_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
          `).run(id, kbId, sourceId, targetId, relation.relationType, relation.description, documentId)
        }
      }
    }
  }

  getChapters(documentId: string): any[] {
    return this.db.prepare(
      'SELECT * FROM kb_chapters WHERE document_id = ? ORDER BY chapter_index'
    ).all(documentId)
  }

  getDocumentSummary(documentId: string): any | null {
    return this.db.prepare(
      'SELECT * FROM kb_document_summaries WHERE document_id = ?'
    ).get(documentId) || null
  }

  getGlobalSummary(kbId: string): any | null {
    return this.db.prepare(
      'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
    ).get(kbId) || null
  }

  getEntities(kbId: string, type?: string): any[] {
    if (type) {
      return this.db.prepare(
        'SELECT * FROM kb_entities WHERE kb_id = ? AND type = ? ORDER BY mention_count DESC'
      ).all(kbId, type)
    }
    return this.db.prepare(
      'SELECT * FROM kb_entities WHERE kb_id = ? ORDER BY mention_count DESC'
    ).all(kbId)
  }

  getEntityByName(kbId: string, name: string): any | null {
    return this.db.prepare(
      'SELECT * FROM kb_entities WHERE kb_id = ? AND name = ?'
    ).get(kbId, name) || null
  }

  getEntityRelations(entityId: string, depth: number = 1): any[] {
    const relations = this.db.prepare(`
      SELECT r.*, e1.name as source_name, e1.type as source_type, e2.name as target_name, e2.type as target_type
      FROM kb_entity_relations r
      JOIN kb_entities e1 ON r.source_entity_id = e1.id
      JOIN kb_entities e2 ON r.target_entity_id = e2.id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
    `).all(entityId, entityId)

    if (depth > 1 && relations.length > 0) {
      const visitedIds = new Set<string>([entityId])
      const allRelations = [...relations]

      const traverse = (currentEntityId: string, currentDepth: number) => {
        if (currentDepth >= depth) return
        if (visitedIds.has(currentEntityId)) return
        visitedIds.add(currentEntityId)

        const nextRelations = this.db.prepare(`
          SELECT r.*, e1.name as source_name, e1.type as source_type, e2.name as target_name, e2.type as target_type
          FROM kb_entity_relations r
          JOIN kb_entities e1 ON r.source_entity_id = e1.id
          JOIN kb_entities e2 ON r.target_entity_id = e2.id
          WHERE r.source_entity_id = ? OR r.target_entity_id = ?
        `).all(currentEntityId, currentEntityId)

        for (const rel of nextRelations as any[]) {
          if (!allRelations.some((r: any) => r.id === rel.id)) {
            allRelations.push(rel)
          }
        }

        for (const rel of nextRelations as any[]) {
          const nextId = rel.source_entity_id === currentEntityId ? rel.target_entity_id : rel.source_entity_id
          traverse(nextId, currentDepth + 1)
        }
      }

      for (const rel of relations as any[]) {
        const nextId = rel.source_entity_id === entityId ? rel.target_entity_id : rel.source_entity_id
        traverse(nextId, 1)
      }

      return allRelations
    }

    return relations
  }

  getEntityMentions(entityId: string): any[] {
    return this.db.prepare(`
      SELECT m.*, d.original_name as document_name, c.title as chapter_title
      FROM kb_entity_mentions m
      LEFT JOIN kb_documents d ON m.document_id = d.id
      LEFT JOIN kb_chapters c ON m.chapter_id = c.id
      WHERE m.entity_id = ?
      ORDER BY m.created_at DESC
    `).all(entityId)
  }

  generateTimeline(kbId: string, topic?: string): Array<{ time: string; event: string; source: string }> {
    const timeline: Array<{ time: string; event: string; source: string }> = []

    const docSummaries = this.db.prepare(
      'SELECT ds.*, d.original_name as document_name FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
    ).all(kbId) as any[]

    for (const ds of docSummaries) {
      const events: Array<{ time: string; event: string }> = JSON.parse(ds.timeline_json || '[]')
      for (const ev of events) {
        if (!topic || ev.event.toLowerCase().includes(topic.toLowerCase())) {
          timeline.push({
            time: ev.time,
            event: ev.event,
            source: ds.document_name,
          })
        }
      }
    }

    const globalSummary = this.getGlobalSummary(kbId)
    if (globalSummary) {
      const globalEvents: Array<{ time: string; event: string }> = JSON.parse(globalSummary.global_timeline_json || '[]')
      for (const ev of globalEvents) {
        if (!topic || ev.event.toLowerCase().includes(topic.toLowerCase())) {
          timeline.push({
            time: ev.time,
            event: ev.event,
            source: '全局知识',
          })
        }
      }
    }

    timeline.sort((a, b) => {
      const timeA = a.time.replace(/[^\d]/g, '')
      const timeB = b.time.replace(/[^\d]/g, '')
      return timeA.localeCompare(timeB)
    })

    return timeline
  }

  getProcessingJobs(kbId: string, status?: string): any[] {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM kb_processing_jobs WHERE kb_id = ? AND status = ? ORDER BY created_at DESC'
      ).all(kbId, status)
    }
    return this.db.prepare(
      'SELECT * FROM kb_processing_jobs WHERE kb_id = ? ORDER BY created_at DESC'
    ).all(kbId)
  }

  createProcessingJob(kbId: string, documentId: string | null, jobType: string, totalSteps: number): string {
    const id = generateId()
    this.db.prepare(`
      INSERT INTO kb_processing_jobs (id, kb_id, document_id, job_type, status, total_steps, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, unixepoch(), unixepoch())
    `).run(id, kbId, documentId, jobType, totalSteps)
    return id
  }

  updateProcessingJob(jobId: string, status: string, progress?: number, currentStep?: string, errorMessage?: string): void {
    const updates: string[] = ['status = ?', 'updated_at = unixepoch()']
    const values: any[] = [status]

    if (progress !== undefined) { updates.push('progress = ?'); values.push(progress) }
    if (currentStep !== undefined) { updates.push('current_step = ?'); values.push(currentStep) }
    if (errorMessage !== undefined) { updates.push('error_message = ?'); values.push(errorMessage) }
    if (status === 'running') { updates.push('started_at = unixepoch()') }
    if (status === 'completed' || status === 'failed') { updates.push('completed_at = unixepoch()') }

    values.push(jobId)
    this.db.prepare(`UPDATE kb_processing_jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteKnowledgeData(kbId: string, documentId?: string): void {
    if (documentId) {
      this.db.prepare('DELETE FROM kb_entity_mentions WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_entity_relations WHERE source_document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_chapters WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_document_summaries WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM kb_processing_jobs WHERE document_id = ?').run(documentId)
    } else {
      this.db.prepare('DELETE FROM kb_entity_mentions WHERE document_id IN (SELECT id FROM kb_documents WHERE kb_id = ?)').run(kbId)
      this.db.prepare('DELETE FROM kb_entity_relations WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_entity_mentions WHERE entity_id IN (SELECT id FROM kb_entities WHERE kb_id = ?)').run(kbId)
      this.db.prepare('DELETE FROM kb_entities WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_chapters WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_document_summaries WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_global_summaries WHERE kb_id = ?').run(kbId)
      this.db.prepare('DELETE FROM kb_processing_jobs WHERE kb_id = ?').run(kbId)
    }
  }

  getAllDocumentSummaries(kbId: string): any[] {
    const summaries = this.db.prepare(
      'SELECT ds.*, d.original_name as doc_name FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?'
    ).all(kbId) as any[]
    return summaries.map(s => ({ ...s, doc_id: s.document_id }))
  }

  getKnowledgeStats(kbId: string): {
    chapterCount: number
    documentSummaryCount: number
    hasGlobalSummary: boolean
    entityCount: number
    relationCount: number
    entityByType: Record<string, number>
  } {
    const chapterCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_chapters WHERE kb_id = ?').get(kbId) as any)?.count || 0
    const documentSummaryCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_document_summaries WHERE kb_id = ?').get(kbId) as any)?.count || 0
    const hasGlobalSummary = !!this.db.prepare('SELECT id FROM kb_global_summaries WHERE kb_id = ?').get(kbId)
    const entityCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_entities WHERE kb_id = ?').get(kbId) as any)?.count || 0
    const relationCount = (this.db.prepare('SELECT COUNT(*) as count FROM kb_entity_relations WHERE kb_id = ?').get(kbId) as any)?.count || 0

    const entityTypes = this.db.prepare(
      'SELECT type, COUNT(*) as count FROM kb_entities WHERE kb_id = ? GROUP BY type'
    ).all(kbId) as any[]

    const entityByType: Record<string, number> = {}
    for (const et of entityTypes) {
      entityByType[et.type] = et.count
    }

    return { chapterCount, documentSummaryCount, hasGlobalSummary, entityCount, relationCount, entityByType }
  }

  private splitIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
    if (text.length <= chunkSize) return [text]
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length)
      chunks.push(text.substring(start, end))
      if (end >= text.length) break
      start = end - overlap
    }
    return chunks.filter(c => c.length > 50)
  }

  private parseJSON<T>(raw: string, fallback: T): T {
    try {
      let jsonStr = raw.trim()
      const fenceMatch = jsonStr.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m)
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim()
      } else {
        const firstBrace = jsonStr.indexOf('{')
        const lastBrace = jsonStr.lastIndexOf('}')
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
        }
      }
      return JSON.parse(jsonStr) as T
    } catch {
      try {
        const repaired = this.repairJSON(raw)
        return JSON.parse(repaired) as T
      } catch {
        return fallback
      }
    }
  }

  private repairJSON(raw: string): string {
    let result = ''
    let inString = false
    let escaped = false

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (escaped) { result += ch; escaped = false; continue }
      if (ch === '\\') { result += ch; escaped = true; continue }
      if (ch === '"') { inString = !inString; result += ch; continue }
      if (inString) {
        if (ch === '\n') result += '\\n'
        else if (ch === '\r') result += '\\r'
        else if (ch === '\t') result += '\\t'
        else result += ch
      } else {
        result += ch
      }
    }

    return result
  }
}

export default KnowledgeProcessorService
