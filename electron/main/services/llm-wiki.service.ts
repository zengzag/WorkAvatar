import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'

interface WikiPage {
  id: string
  title: string
  type: 'concept' | 'entity' | 'summary'
  entity_type?: 'person' | 'tool' | 'paper' | 'organization'
  content: string
  tags: string[]
  sources: string[]
  created_at: number
  updated_at: number
  path: string
}

interface WikiSearchResult {
  page: WikiPage
  relevance: number
  matched_sections: string[]
}

interface CompileResult {
  success: boolean
  pages_created: number
  pages_updated: number
  skipped: number
  errors: string[]
}

interface CleanSourceResult {
  removed: number
  summary_removed: boolean
  pages_removed: string[]
}

function repairLLMJson(raw: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (escaped) {
      result += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      result += ch
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      result += ch
      continue
    }

    if (inString) {
      if (ch === '\n') {
        result += '\\n'
      } else if (ch === '\r') {
        result += '\\r'
      } else if (ch === '\t') {
        result += '\\t'
      } else {
        result += ch
      }
    } else {
      result += ch
    }
  }

  return result
}

interface LintResult {
  dead_links: Array<{ source: string; link: string }>
  orphan_pages: string[]
  missing_index: string[]
  total_issues: number
}

interface AuditEntry {
  id: string
  target: string
  target_lines: [number, number]
  anchor_before: string
  anchor_text: string
  anchor_after: string
  severity: 'info' | 'suggest' | 'warn' | 'error'
  author: string
  source: 'obsidian-plugin' | 'web-viewer' | 'manual'
  created: string
  status: 'open' | 'resolved'
  comment: string
  resolution?: string
}

const generateCLAUDEMD = (topicTitle: string): string => `# ${topicTitle} Knowledge Base

> Schema document — read at the start of every session together with wiki/index.md.
> Update after every major compile, ingest batch, or structural change.

## Scope

What this wiki covers:
- Knowledge and information related to ${topicTitle}

What this wiki deliberately excludes:
- General knowledge outside the scope of this project

## Operations

This wiki follows the llm-wiki skill's five operations: \`compile\`, \`ingest\`, \`query\`, \`lint\`, \`audit\`.
Every operation appends an entry to \`log/YYYYMMDD.md\`.

## Naming conventions

- **Concept pages** (\`wiki/concepts/\`): Title Case noun phrases.
- **Folder-split concepts** (\`wiki/concepts/<topic>/\`): used when a topic exceeds ~1200 words. Contains \`index.md\` + one file per aspect.
- **Entity pages** (\`wiki/entities/\`): Proper names.
- **Summary pages** (\`wiki/summaries/\`): kebab-case source slug.

All pages require YAML frontmatter: \`title\`, \`type\`, \`created\`, \`updated\`, \`sources\`, \`tags\`.

### Wikilinks
- Always use \`[[Page Title]]\` — exact page title, case-sensitive.
- For folder-split pages, link to the index: \`[[concepts/Foo/index|Foo]]\`.
- Link the first mention of every entity or concept. Do not link the same page more than twice per article.

### Diagrams and formulas
- All diagrams are **mermaid**. No ASCII art.
- All formulas are **KaTeX** (inline \`$...$\` or block \`$$...$$\`).

### Raw file policy
- Small text sources → copy into \`raw/<subfolder>/\`.
- Large binaries → create a pointer file at \`raw/refs/<slug>.md\` with \`kind: ref\` and \`external_path\` fields. Do not copy the binary.

## Current articles

*None yet — update this list after every compile.*

### Concepts
*(none)*

### Entities
*(none)*

### Summaries
*(none)*

## Open research questions

- What do you want to understand better?

## Research gaps

Sources to ingest:
- [ ] Add relevant sources here

## Audit backlog

*(none — run audit review to refresh)*

## Notes for the LLM

- Language: zh
- Tone: neutral
- Depth: deep technical
- Handling contradictions: state both, cite each, add to Open Research Questions.
`

const generateWikiIndexMD = (topicTitle: string): string => `# Index — ${topicTitle}

> One-sentence scope of the wiki.

## 🔖 Navigation
- [[#Concepts]] · [[#Entities]] · [[#Summaries]] · [[#Open Questions]]

## Concepts

*(none yet)*

## Entities

*(none yet)*

## Summaries (chronological)

*(none yet)*

## Open Questions

- First research question
`

class LLMWikiService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: LLMWikiService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): LLMWikiService {
    if (!LLMWikiService.instance) {
      LLMWikiService.instance = new LLMWikiService()
    }
    return LLMWikiService.instance
  }

  private getProjectWikiPath(projectId: string): string {
    const isDev = !app.isPackaged
    const basePath = isDev
      ? path.join(process.cwd(), '.workavatar-data', 'wiki', projectId)
      : path.join(app.getPath('userData'), 'wiki', projectId)
    return basePath
  }

  private ensureWikiStructure(projectId: string): {
    basePath: string
    rawPath: string
    rawArticlesPath: string
    rawPapersPath: string
    rawNotesPath: string
    rawRefsPath: string
    wikiPath: string
    wikiConceptsPath: string
    wikiEntitiesPath: string
    wikiSummariesPath: string
    logPath: string
    auditPath: string
    auditResolvedPath: string
    outputsPath: string
    outputsQueriesPath: string
    claudePath: string
    wikiIndexPath: string
  } {
    const basePath = this.getProjectWikiPath(projectId)
    const rawPath = path.join(basePath, 'raw')
    const rawArticlesPath = path.join(rawPath, 'articles')
    const rawPapersPath = path.join(rawPath, 'papers')
    const rawNotesPath = path.join(rawPath, 'notes')
    const rawRefsPath = path.join(rawPath, 'refs')
    const wikiPath = path.join(basePath, 'wiki')
    const wikiConceptsPath = path.join(wikiPath, 'concepts')
    const wikiEntitiesPath = path.join(wikiPath, 'entities')
    const wikiSummariesPath = path.join(wikiPath, 'summaries')
    const logPath = path.join(basePath, 'log')
    const auditPath = path.join(basePath, 'audit')
    const auditResolvedPath = path.join(auditPath, 'resolved')
    const outputsPath = path.join(basePath, 'outputs')
    const outputsQueriesPath = path.join(outputsPath, 'queries')
    const claudePath = path.join(basePath, 'CLAUDE.md')
    const wikiIndexPath = path.join(wikiPath, 'index.md')

    const dirs = [
      rawArticlesPath,
      rawPapersPath,
      rawNotesPath,
      rawRefsPath,
      wikiConceptsPath,
      wikiEntitiesPath,
      wikiSummariesPath,
      logPath,
      auditPath,
      auditResolvedPath,
      outputsQueriesPath,
    ]

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }

    return {
      basePath,
      rawPath,
      rawArticlesPath,
      rawPapersPath,
      rawNotesPath,
      rawRefsPath,
      wikiPath,
      wikiConceptsPath,
      wikiEntitiesPath,
      wikiSummariesPath,
      logPath,
      auditPath,
      auditResolvedPath,
      outputsPath,
      outputsQueriesPath,
      claudePath,
      wikiIndexPath,
    }
  }

  async initializeWiki(projectId: string): Promise<{ success: boolean; message: string }> {
    try {
      const project = this.db.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any
      if (!project) {
        return { success: false, message: '项目不存在' }
      }

      const paths = this.ensureWikiStructure(projectId)

      if (!fs.existsSync(paths.claudePath)) {
        fs.writeFileSync(paths.claudePath, generateCLAUDEMD(project.name || 'Project'), 'utf-8')
      }

      if (!fs.existsSync(paths.wikiIndexPath)) {
        fs.writeFileSync(paths.wikiIndexPath, generateWikiIndexMD(project.name || 'Project'), 'utf-8')
      }

      const today = new Date()
      const todayCompact = today.toISOString().slice(0, 10).replace(/-/g, '')
      const logPath = path.join(paths.logPath, `${todayCompact}.md`)

      if (!fs.existsSync(logPath)) {
        const nowHm = today.toTimeString().slice(0, 5)
        const logContent = `# ${today.toISOString().slice(0, 10)}

## [${nowHm}] scaffold | Initialized ${project.name || 'Project'} knowledge base
- Created directory tree (raw/, wiki/, log/, audit/, outputs/)
- Created CLAUDE.md schema template
- Created wiki/index.md category skeleton
`
        fs.writeFileSync(logPath, logContent, 'utf-8')
      }

      const files = this.db.getDb().prepare(
        'SELECT * FROM files WHERE project_id = ? AND status = ?'
      ).all(projectId, 'completed') as any[]

      for (const file of files) {
        await this.syncRawFile(projectId, file)
      }

      return {
        success: true,
        message: `Wiki 知识库初始化完成。已同步 ${files.length} 个原始文件到 raw/ 目录。`,
      }
    } catch (err: any) {
      console.error('Initialize wiki error:', err)
      return { success: false, message: err.message }
    }
  }

  async syncRawFile(projectId: string, file: any): Promise<void> {
    const paths = this.ensureWikiStructure(projectId)
    const parsed = file.parsed_json ? JSON.parse(file.parsed_json) : null
    const content = parsed?.fullText || file.thumbnail_text || ''
    const slug = this.sanitizeFileName(file.original_name.replace(/\.[^/.]+$/, ''))
    const now = new Date().toISOString()

    let rawDir = paths.rawNotesPath
    if (file.type?.includes('pdf') || file.original_name.toLowerCase().includes('paper')) {
      rawDir = paths.rawPapersPath
    } else if (file.original_name.toLowerCase().includes('article')) {
      rawDir = paths.rawArticlesPath
    }

    const rawFilePath = path.join(rawDir, `${slug}.md`)

    const rawContent = `---
id: "${file.id}"
original_name: "${file.original_name}"
type: "${file.type || 'note'}"
size: ${file.size}
ingested: "${now}"
source_type: "${file.type?.includes('pdf') ? 'paper' : 'note'}"
---

# ${file.original_name}

${content}
`

    fs.writeFileSync(rawFilePath, rawContent, 'utf-8')
  }

  private appendLogEntry(projectId: string, operation: string, description: string, details?: string[]): void {
    const paths = this.ensureWikiStructure(projectId)
    const today = new Date()
    const todayCompact = today.toISOString().slice(0, 10).replace(/-/g, '')
    const logPath = path.join(paths.logPath, `${todayCompact}.md`)
    const nowHm = today.toTimeString().slice(0, 5)

    let entry = `## [${nowHm}] ${operation} | ${description}\n`
    if (details && details.length > 0) {
      entry += details.map(d => `- ${d}`).join('\n') + '\n'
    }
    entry += '\n'

    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, entry, 'utf-8')
    } else {
      const logContent = `# ${today.toISOString().slice(0, 10)}\n\n${entry}`
      fs.writeFileSync(logPath, logContent, 'utf-8')
    }
  }

  async ingestSource(
    projectId: string,
    rawFilePath: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void,
    onLLMChunk?: (chunk: string) => void,
    onThought?: (thought: string) => void
  ): Promise<{ success: boolean; pages_created: number; errors: string[] }> {
    const paths = this.ensureWikiStructure(projectId)

    try {
      onProgress?.('读取', '正在读取原始资料...')

      if (!fs.existsSync(rawFilePath)) {
        return { success: false, pages_created: 0, errors: ['原始文件不存在'] }
      }

      const rawContent = fs.readFileSync(rawFilePath, 'utf-8')
      const { frontmatter, body } = this.parseMarkdown(rawContent)
      const sourceSlug = path.basename(rawFilePath, '.md')

      onProgress?.('分析', '正在分析资料内容...')

      const provider = providerId || this.getDefaultProviderId()
      if (!provider) {
        return { success: false, pages_created: 0, errors: ['未配置 LLM 提供商'] }
      }

      const claudeContent = fs.readFileSync(paths.claudePath, 'utf-8')

      const analysisPrompt = `${claudeContent}

---

## Source to ingest

\`\`\`
${rawContent.substring(0, 20000)}
\`\`\`

## Task

Please analyze this source and generate:
1. A summary page (200-400 words)
2. Relevant concept pages (400-1200 words each)
3. Relevant entity pages (200-500 words each)

Return JSON with this structure:
{
  "summary": {
    "title": "source-slug",
    "key_takeaways": ["point 1", "point 2"],
    "core_claims": "brief summary of main argument",
    "notable_quotes": ["quote 1"],
    "tags": ["tag1", "tag2"]
  },
  "concepts": [
    {
      "title": "Concept Title",
      "summary": "one-sentence definition",
      "content": "full content (400-1200 words)",
      "how_it_works": "explanation",
      "key_properties": ["prop1"],
      "related_concepts": ["Related Concept"],
      "tags": ["tag1"]
    }
  ],
  "entities": [
    {
      "name": "Entity Name",
      "entity_type": "person|tool|paper|organization",
      "description": "one-sentence",
      "key_contributions": ["contribution1"],
      "related_concepts": ["Concept"],
      "tags": ["tag1"]
    }
  ]
}

Important:
- Concept pages should be 400-1200 words
- Entity pages should be 200-500 words
- Use wikilinks [[Page Title]] for cross-references
- All diagrams must be mermaid
- All formulas must be KaTeX
`

      let analysisResult: string

      if (onLLMChunk || onThought) {
        analysisResult = ''
        let streamingDone = false
        let streamingError: Error | null = null

        await this.llmClient.chatStream(
          provider,
          [
            { role: 'system', content: 'You are a professional knowledge engineer. Follow the llm-wiki conventions strictly. Return only valid JSON.' },
            { role: 'user', content: analysisPrompt },
          ],
          (chunk: string) => {
            analysisResult += chunk
            onLLMChunk?.(chunk)
          },
          () => {
            streamingDone = true
          },
          (error: Error) => {
            streamingError = error
          },
          modelId ? { model: modelId } : undefined,
          undefined,
          (thoughtChunk: string) => {
            onThought?.(thoughtChunk)
          },
        )

        if (streamingError) {
          throw streamingError
        }
        if (!streamingDone) {
          throw new Error('LLM streaming did not complete')
        }
      } else {
        analysisResult = await this.llmClient.chat(provider, [
          { role: 'system', content: 'You are a professional knowledge engineer. Follow the llm-wiki conventions strictly. Return only valid JSON.' },
          { role: 'user', content: analysisPrompt },
        ], modelId ? { model: modelId } : undefined)
      }

      let analysis: any
      let parseError: string | null = null
      let jsonStr = ''
      const repairSteps: string[] = []
      try {
        const fenceMatch = analysisResult.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m)
        if (fenceMatch) {
          jsonStr = fenceMatch[1].trim()
        } else {
          const firstBrace = analysisResult.indexOf('{')
          const lastBrace = analysisResult.lastIndexOf('}')
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            jsonStr = analysisResult.substring(firstBrace, lastBrace + 1)
          } else {
            jsonStr = analysisResult.trim()
          }
        }
        analysis = JSON.parse(jsonStr)
      } catch (firstErr: any) {
        repairSteps.push(`第1次解析失败: ${firstErr.message}`)
        console.warn('Wiki JSON parse failed, retrying with repair. First error:', firstErr.message)
        try {
          if (!jsonStr || jsonStr === analysisResult.trim()) {
            const firstBrace = analysisResult.indexOf('{')
            const lastBrace = analysisResult.lastIndexOf('}')
            if (firstBrace !== -1 && lastBrace > firstBrace) {
              jsonStr = analysisResult.substring(firstBrace, lastBrace + 1)
            }
          }
          const repaired = repairLLMJson(jsonStr)
          analysis = JSON.parse(repaired)
          parseError = null
        } catch (secondErr: any) {
          repairSteps.push(`修复后解析仍失败: ${secondErr.message}`)
          parseError = repairSteps.join('; ')
          console.error('Wiki JSON parse failed after repair. Length:', analysisResult.length, 'chars. Error:', secondErr.message)
          analysis = { summary: null, concepts: [], entities: [] }
        }
      }

      onProgress?.('生成', '正在生成 Wiki 页面...')

      let pagesCreated = 0
      const errors: string[] = []

      if (parseError) {
        const previewLen = analysisResult.length
        const preview = analysisResult.substring(0, 800)
        const tail = previewLen > 800 ? analysisResult.substring(previewLen - 200) : ''
        errors.push(
          `LLM 返回内容 JSON 解析失败: ${parseError}`,
          `返回总长度: ${previewLen} 字符`,
          `内容预览(头800字符):`,
          preview,
        )
        if (tail) {
          errors.push(`内容尾部:`, tail)
        }
      }
      const now = new Date().toISOString()
      const nowDate = now.slice(0, 10)

      if (analysis.summary) {
        try {
          const summaryPage = `---
title: "${sourceSlug}"
type: summary
source_url: ""
source_type: "${frontmatter.source_type || 'note'}"
date: "${nowDate}"
ingested: "${nowDate}"
tags: [${(analysis.summary.tags || []).map((t: string) => `"${t}"`).join(', ')}]
sources: ["${sourceSlug}"]
created: "${now}"
updated: "${now}"
---

# ${frontmatter.original_name || sourceSlug}

**Source**: ${frontmatter.original_name || sourceSlug} · ${nowDate}

## Key takeaways

${(analysis.summary.key_takeaways || []).map((t: string) => `- ${t}`).join('\n')}

## Core claims

${analysis.summary.core_claims || ''}

## Notable quotes

${(analysis.summary.notable_quotes || []).map((q: string) => `> ${q}`).join('\n\n')}

## Concepts introduced / referenced

${(analysis.concepts || []).map((c: any) => `- [[${c.title}]]`).join('\n')}
${(analysis.entities || []).map((e: any) => `- [[${e.name}]]`).join('\n')}
`
          fs.writeFileSync(path.join(paths.wikiSummariesPath, `${sourceSlug}.md`), summaryPage, 'utf-8')
          pagesCreated++
        } catch (err: any) {
          errors.push(`生成 summary 页面失败: ${err.message}`)
        }
      }

      for (const concept of analysis.concepts || []) {
        try {
          // 计算内容总长度，判断是否需要拆分
          const totalContentLength = (concept.content?.length || 0) + 
                                     (concept.how_it_works?.length || 0) +
                                     (concept.key_properties?.join('')?.length || 0) +
                                     (concept.related_concepts?.join('')?.length || 0)
          
          if (totalContentLength > 1200) {
            // 内容超过1200字，拆分成子目录
            const splitPagesCount = this.splitConceptPage(projectId, concept, sourceSlug, now)
            pagesCreated += splitPagesCount
          } else {
            // 内容较短，生成单页面
            const fileName = this.sanitizeFileName(concept.title) + '.md'
            const conceptPage = `---
title: "${concept.title}"
type: concept
created: "${now}"
updated: "${now}"
sources: ["${sourceSlug}"]
tags: [${(concept.tags || []).map((t: string) => `"${t}"`).join(', ')}]
---

# ${concept.title}

${concept.summary || ''}

## What it is

${concept.content || ''}

## How it works

${concept.how_it_works || ''}

## Key properties / tradeoffs

${(concept.key_properties || []).map((p: string) => `- ${p}`).join('\n')}

## Relationship to other concepts

${(concept.related_concepts || []).map((c: string) => `- [[${c}]]`).join('\n')}

## Open questions

*(add here as needed)*

## Sources

- [[summaries/${sourceSlug}]]
`
            fs.writeFileSync(path.join(paths.wikiConceptsPath, fileName), conceptPage, 'utf-8')
            pagesCreated++
          }
        } catch (err: any) {
          errors.push(`生成概念页面 "${concept.title}" 失败: ${err.message}`)
        }
      }

      for (const entity of analysis.entities || []) {
        try {
          const fileName = this.sanitizeFileName(entity.name) + '.md'
          const entityPage = `---
title: "${entity.name}"
type: entity
entity_type: "${entity.entity_type || 'tool'}"
created: "${now}"
updated: "${now}"
sources: ["${sourceSlug}"]
tags: [${(entity.tags || []).map((t: string) => `"${t}"`).join(', ')}]
---

# ${entity.name}

${entity.description || ''}

## Key contributions / features

${(entity.key_contributions || []).map((c: string) => `- ${c}`).join('\n')}

## Related concepts

${(entity.related_concepts || []).map((c: string) => `- [[${c}]]`).join('\n')}

## Sources

- [[summaries/${sourceSlug}]]
`
          fs.writeFileSync(path.join(paths.wikiEntitiesPath, fileName), entityPage, 'utf-8')
          pagesCreated++
        } catch (err: any) {
          errors.push(`生成实体页面 "${entity.name}" 失败: ${err.message}`)
        }
      }

      await this.updateWikiIndex(projectId)

      this.appendLogEntry(projectId, 'ingest', sourceSlug, [
        `Source: ${rawFilePath}`,
        `Touched: ${pagesCreated} wiki pages`
      ])

      onProgress?.('完成', `Ingest 完成。新建 ${pagesCreated} 页。`)

      return { success: true, pages_created: pagesCreated, errors }
    } catch (err: any) {
      console.error('Ingest source error:', err)
      return { success: false, pages_created: 0, errors: [err.message] }
    }
  }

  async compileWiki(
    projectId: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void,
    onLLMChunk?: (chunk: string) => void,
    onThought?: (thought: string) => void,
    force: boolean = false
  ): Promise<CompileResult> {
    const paths = this.ensureWikiStructure(projectId)

    try {
      onProgress?.('读取', '正在读取原始资料...')

      const rawFiles: string[] = []
      const rawDirs = [paths.rawArticlesPath, paths.rawPapersPath, paths.rawNotesPath]

      for (const dir of rawDirs) {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
          rawFiles.push(...files.map((f) => path.join(dir, f)))
        }
      }

      if (rawFiles.length === 0) {
        return { success: true, pages_created: 0, pages_updated: 0, skipped: 0, errors: ['raw/ 目录为空，没有可编译的资料'] }
      }

      const toProcess: Array<{ filePath: string; isReprocess: boolean }> = []
      let skipped = 0

      for (const rawFile of rawFiles) {
        if (this.isSourceIngested(projectId, rawFile)) {
          if (force) {
            toProcess.push({ filePath: rawFile, isReprocess: true })
          } else {
            skipped++
          }
        } else {
          toProcess.push({ filePath: rawFile, isReprocess: false })
        }
      }

      if (toProcess.length === 0) {
        onProgress?.('完成', `所有 ${skipped} 个文件已解析，无需重新编译`)
        return { success: true, pages_created: 0, pages_updated: 0, skipped, errors: [] }
      }

      let pagesCreated = 0
      let pagesUpdated = 0
      const errors: string[] = []
      const totalFiles = toProcess.length

      for (let i = 0; i < totalFiles; i++) {
        const { filePath, isReprocess } = toProcess[i]
        const fileName = path.basename(filePath)

        if (isReprocess) {
          const sourceSlug = path.basename(filePath, '.md')
          const cleanResult = this.cleanSourcePages(projectId, sourceSlug)
          if (cleanResult.removed > 0) {
            onProgress?.('清理', `正在清理 ${fileName} 的旧页面...`)
            pagesUpdated += cleanResult.removed
          }
        }

        onProgress?.('编译', `正在编译第 ${i + 1}/${totalFiles} 个文件${isReprocess ? ' (重新解析)' : ''}: ${fileName}`)
        const result = await this.ingestSource(projectId, filePath, providerId, modelId, onProgress, onLLMChunk, onThought)
        if (result.success) {
          pagesCreated += result.pages_created
        } else {
          errors.push(...result.errors)
        }
      }

      await this.updateWikiIndex(projectId)

      this.appendLogEntry(projectId, 'compile', `Compiled ${toProcess.length} sources (${skipped} skipped)`, [
        `Pages created: ${pagesCreated}`,
        `Pages updated: ${pagesUpdated}`,
        `Skipped: ${skipped}`
      ])

      onProgress?.('完成', `编译完成。新建 ${pagesCreated} 页，更新 ${pagesUpdated} 页，跳过 ${skipped} 个已解析。`)

      return { success: true, pages_created: pagesCreated, pages_updated: pagesUpdated, skipped, errors }
    } catch (err: any) {
      console.error('Compile wiki error:', err)
      return { success: false, pages_created: 0, pages_updated: 0, skipped: 0, errors: [err.message] }
    }
  }

  async searchWiki(
    projectId: string,
    query: string,
    topK: number = 5
  ): Promise<WikiSearchResult[]> {
    this.ensureWikiStructure(projectId)

    try {
      const allPages = this.getAllWikiPages(projectId)
      const results: WikiSearchResult[] = []

      const queryLower = query.toLowerCase()
      const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 1)

      for (const page of allPages) {
        let score = 0
        const matchedSections: string[] = []

        const titleLower = page.title.toLowerCase()
        const contentLower = page.content.toLowerCase()

        if (titleLower.includes(queryLower)) {
          score += 10
          matchedSections.push('标题匹配')
        }

        for (const word of queryWords) {
          if (titleLower.includes(word)) score += 3
          if (contentLower.includes(word)) score += 1
        }

        const tagMatches = page.tags.filter((t) => queryLower.includes(t.toLowerCase()) || t.toLowerCase().includes(queryLower))
        score += tagMatches.length * 2

        if (score > 0) {
          results.push({
            page,
            relevance: Math.min(score / 20, 1),
            matched_sections: matchedSections.length > 0 ? matchedSections : ['内容匹配'],
          })
        }
      }

      results.sort((a, b) => b.relevance - a.relevance)
      return results.slice(0, topK)
    } catch (err: any) {
      console.error('Wiki search error:', err)
      return []
    }
  }

  async queryWiki(
    projectId: string,
    query: string,
    providerId?: string,
    modelId?: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ answer: string; sources: WikiSearchResult[] }> {
    const paths = this.ensureWikiStructure(projectId)

    try {
      onProgress?.('搜索', '正在搜索 Wiki 知识库...')

      const searchResults = await this.searchWiki(projectId, query, 10)

      if (searchResults.length === 0) {
        return { answer: 'Wiki 知识库中没有找到相关信息。', sources: [] }
      }

      onProgress?.('生成', '正在生成回答...')

      const provider = providerId || this.getDefaultProviderId()
      if (!provider) {
        return { answer: '未配置 LLM 提供商', sources: searchResults }
      }

      const contextText = searchResults.map(r => `# ${r.page.title}\n${r.page.content}`).join('\n\n---\n\n')

      const queryPrompt = `${fs.readFileSync(paths.claudePath, 'utf-8')}

---

## User question

${query}

## Relevant wiki pages

\`\`\`
${contextText.substring(0, 30000)}
\`\`\`

## Task

Answer the user's question using ONLY the information from the wiki pages provided.
Cite sources with [[Page Title]] wikilinks.
If the wiki doesn't have enough information, say so and suggest what to ingest next.

## Requirements

- Answer in Chinese
- Cite sources using [[Page Title]]
- Be comprehensive but concise
- If information is insufficient, suggest what to ingest
`

      const answer = await this.llmClient.chat(provider, [
        { role: 'system', content: 'You are a helpful research assistant. Answer only from the provided wiki content.' },
        { role: 'user', content: queryPrompt },
      ], modelId ? { model: modelId } : undefined)

      const now = new Date()
      const querySlug = this.sanitizeFileName(query.substring(0, 50))
      const queryFileName = `${now.toISOString().slice(0, 10)}-${querySlug}.md`
      const queryPath = path.join(paths.outputsQueriesPath, queryFileName)

      const queryOutput = `---
question: "${query.replace(/"/g, '\\"')}"
date: "${now.toISOString().slice(0, 10)}"
sources: [${searchResults.map(r => `"${r.page.title}"`).join(', ')}]
---

# Question

${query}

# Answer

${answer}

# Sources

${searchResults.map(r => `- [[${r.page.title}]]`).join('\n')}
`

      fs.writeFileSync(queryPath, queryOutput, 'utf-8')

      this.appendLogEntry(projectId, 'query', querySlug)

      onProgress?.('完成', '回答生成完成')

      return { answer, sources: searchResults }
    } catch (err: any) {
      console.error('Query wiki error:', err)
      return { answer: `查询失败: ${err.message}`, sources: [] }
    }
  }

  async lintWiki(projectId: string): Promise<LintResult> {
    const paths = this.ensureWikiStructure(projectId)
    const allPages = this.getAllWikiPages(projectId)
    const pagesByTitle = new Map(allPages.map(p => [p.title, p]))

    const deadLinks: Array<{ source: string; link: string }> = []
    const inboundLinks = new Map<string, string[]>()

    for (const page of allPages) {
      const links = this.extractWikilinks(page.content)
      for (const link of links) {
        const targetPage = pagesByTitle.get(link)
        if (!targetPage) {
          deadLinks.push({ source: page.title, link })
        } else {
          const existing = inboundLinks.get(link) || []
          existing.push(page.title)
          inboundLinks.set(link, existing)
        }
      }
    }

    const orphanPages = allPages
      .filter(p => !inboundLinks.has(p.title) && p.type !== 'summary')
      .map(p => p.title)

    let indexContent = ''
    let missingIndex: string[] = []

    if (fs.existsSync(paths.wikiIndexPath)) {
      indexContent = fs.readFileSync(paths.wikiIndexPath, 'utf-8')
      missingIndex = allPages
        .filter(p => !indexContent.includes(`[[${p.title}]]`))
        .map(p => p.title)
    }

    this.appendLogEntry(projectId, 'lint', `${deadLinks.length + orphanPages.length + missingIndex.length} issues found`)

    return {
      dead_links: deadLinks,
      orphan_pages: orphanPages,
      missing_index: missingIndex,
      total_issues: deadLinks.length + orphanPages.length + missingIndex.length,
    }
  }

  async auditWiki(projectId: string): Promise<{ open: AuditEntry[]; resolved: AuditEntry[] }> {
    const paths = this.ensureWikiStructure(projectId)
    const open: AuditEntry[] = []
    const resolved: AuditEntry[] = []

    if (fs.existsSync(paths.auditPath)) {
      const auditFiles = fs.readdirSync(paths.auditPath).filter((f) => f.endsWith('.md'))
      for (const f of auditFiles) {
        const entry = this.parseAuditFile(path.join(paths.auditPath, f))
        if (entry) open.push(entry)
      }
    }

    if (fs.existsSync(paths.auditResolvedPath)) {
      const resolvedFiles = fs.readdirSync(paths.auditResolvedPath).filter((f) => f.endsWith('.md'))
      for (const f of resolvedFiles) {
        const entry = this.parseAuditFile(path.join(paths.auditResolvedPath, f))
        if (entry) resolved.push(entry)
      }
    }

    return { open, resolved }
  }

  getWikiPageList(projectId: string): Array<{
    id: string
    title: string
    type: 'concept' | 'entity' | 'summary'
    path: string
    tags: string[]
    summary: string
  }> {
    const paths = this.ensureWikiStructure(projectId)
    const pages: any[] = []

    const dirs = [
      { dir: paths.wikiConceptsPath, type: 'concept' as const },
      { dir: paths.wikiEntitiesPath, type: 'entity' as const },
      { dir: paths.wikiSummariesPath, type: 'summary' as const },
    ]

    // 递归读取目录下的所有md文件
    const readMdFilesRecursive = (dir: string, basePath: string): Array<{ filePath: string, relativePath: string }> => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const files: Array<{ filePath: string, relativePath: string }> = []
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          files.push(...readMdFilesRecursive(fullPath, `${basePath}${entry.name}/`))
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push({
            filePath: fullPath,
            relativePath: `${basePath}${entry.name}`
          })
        }
      }
      
      return files
    }

    for (const { dir, type } of dirs) {
      if (!fs.existsSync(dir)) continue

      const files = readMdFilesRecursive(dir, '')
      for (const { filePath, relativePath } of files) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          const { frontmatter, body } = this.parseMarkdown(content)
          const fileName = path.basename(filePath)

          const summaryMatch = body.match(/^[^\n#]+/m)
          pages.push({
            id: frontmatter.title || fileName.replace('.md', ''),
            title: frontmatter.title || fileName.replace('.md', ''),
            type: frontmatter.type || type,
            path: `${type}s/${relativePath}`,
            tags: frontmatter.tags || [],
            summary: summaryMatch?.[0]?.trim() || '',
          })
        } catch {
          console.error(`Failed to read wiki page: ${filePath}`)
        }
      }
    }

    return pages
  }

  getWikiPage(projectId: string, pagePath: string): WikiPage | null {
    const paths = this.ensureWikiStructure(projectId)
    let fullPath = path.join(paths.wikiPath, pagePath)

    if (!fs.existsSync(fullPath)) {
      const altPath = path.join(paths.wikiConceptsPath, pagePath)
      if (fs.existsSync(altPath)) fullPath = altPath
    }

    if (!fs.existsSync(fullPath)) return null

    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      const { frontmatter, body } = this.parseMarkdown(content)

      const linkMatches = body.match(/\[\[([^\]]+)\]\]/g) || []
      const links = linkMatches.map((m) => m.replace(/\[\[|\]\]/g, ''))

      return {
        id: frontmatter.title || '',
        title: frontmatter.title || '',
        type: frontmatter.type || 'concept',
        entity_type: frontmatter.entity_type,
        content: body,
        tags: frontmatter.tags || [],
        sources: frontmatter.sources || [],
        created_at: new Date(frontmatter.created || 0).getTime(),
        updated_at: new Date(frontmatter.updated || 0).getTime(),
        path: pagePath,
      }
    } catch {
      return null
    }
  }

  getAllWikiPages(projectId: string): WikiPage[] {
    const pages: WikiPage[] = []
    const list = this.getWikiPageList(projectId)

    for (const item of list) {
      const page = this.getWikiPage(projectId, item.path)
      if (page) pages.push(page)
    }

    return pages
  }

  getRawFiles(projectId: string): Array<{ path: string; name: string; type: string; parsed: boolean }> {
    const paths = this.ensureWikiStructure(projectId)
    const files: Array<{ path: string; name: string; type: string; parsed: boolean }> = []

    const dirs = [
      { dir: paths.rawArticlesPath, type: 'article' },
      { dir: paths.rawPapersPath, type: 'paper' },
      { dir: paths.rawNotesPath, type: 'note' },
    ]

    for (const { dir, type } of dirs) {
      if (!fs.existsSync(dir)) continue

      const dirFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
      for (const file of dirFiles) {
        const filePath = path.join(dir, file)
        files.push({
          path: filePath,
          name: file,
          type,
          parsed: this.isSourceIngested(projectId, filePath),
        })
      }
    }

    return files
  }

  getWikiStatus(projectId: string): {
    initialized: boolean
    raw_count: number
    wiki_page_count: number
    concept_count: number
    entity_count: number
    summary_count: number
    open_audits: number
    last_operation_at: number
  } {
    const paths = this.ensureWikiStructure(projectId)

    const rawCount = this.getRawFiles(projectId).length
    const pages = this.getWikiPageList(projectId)
    const conceptCount = pages.filter(p => p.type === 'concept').length
    const entityCount = pages.filter(p => p.type === 'entity').length
    const summaryCount = pages.filter(p => p.type === 'summary').length

    let openAudits = 0
    if (fs.existsSync(paths.auditPath)) {
      openAudits = fs.readdirSync(paths.auditPath).filter((f) => f.endsWith('.md')).length
    }

    let lastOperationAt = 0
    if (fs.existsSync(paths.logPath)) {
      const logFiles = fs.readdirSync(paths.logPath)
        .filter((f) => /^\d{8}\.md$/.test(f))
        .sort()
        .reverse()

      if (logFiles.length > 0) {
        const latestLog = path.join(paths.logPath, logFiles[0])
        const stat = fs.statSync(latestLog)
        lastOperationAt = stat.mtime.getTime()
      }
    }

    return {
      initialized: fs.existsSync(paths.claudePath) && fs.existsSync(paths.wikiIndexPath),
      raw_count: rawCount,
      wiki_page_count: pages.length,
      concept_count: conceptCount,
      entity_count: entityCount,
      summary_count: summaryCount,
      open_audits: openAudits,
      last_operation_at: lastOperationAt,
    }
  }

  private async updateWikiIndex(projectId: string): Promise<void> {
    const paths = this.ensureWikiStructure(projectId)
    const pages = this.getWikiPageList(projectId)

    const concepts = pages.filter(p => p.type === 'concept')
    const entities = pages.filter(p => p.type === 'entity')
    const summaries = pages.filter(p => p.type === 'summary')

    let projectName = 'Project'
    try {
      const project = this.db.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any
      projectName = project?.name || 'Project'
    } catch {}

    const indexContent = `# Index — ${projectName}

> Knowledge base for ${projectName}

## 🔖 Navigation
- [[#Concepts]] · [[#Entities]] · [[#Summaries]] · [[#Open Questions]]

## Concepts

${concepts.map(c => `- [[${c.title}]] — ${c.summary.substring(0, 80)}${c.summary.length > 80 ? '...' : ''}`).join('\n') || '*(none yet)*'}

## Entities

${entities.map(e => `- [[${e.title}]] — ${e.summary.substring(0, 80)}${e.summary.length > 80 ? '...' : ''}`).join('\n') || '*(none yet)*'}

## Summaries (chronological)

${summaries.map(s => `- [[summaries/${s.title}]]`).join('\n') || '*(none yet)*'}

## Open Questions

- Add research questions here
`

    fs.writeFileSync(paths.wikiIndexPath, indexContent, 'utf-8')
  }

  private parseMarkdown(content: string): { frontmatter: Record<string, any>; body: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
    if (!match) {
      return { frontmatter: {}, body: content }
    }

    const frontmatter: Record<string, any> = {}
    const lines = match[1].split('\n')
    for (const line of lines) {
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim()
        const value = line.substring(colonIdx + 1).trim()
        try {
          frontmatter[key] = JSON.parse(value)
        } catch {
          frontmatter[key] = value.replace(/^"|"$/g, '')
        }
      }
    }

    return { frontmatter, body: match[2] }
  }

  private extractWikilinks(content: string): string[] {
    const matches = content.match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g) || []
    return matches.map(m => {
      const link = m.replace(/\[\[|\]\]/g, '')
      const pipeIdx = link.indexOf('|')
      return pipeIdx > 0 ? link.substring(0, pipeIdx) : link
    })
  }

  private parseAuditFile(filePath: string): AuditEntry | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const { frontmatter, body } = this.parseMarkdown(content)
      const commentMatch = body.match(/# Comment\s*\n([\s\S]*?)(?:\n#|$)/)
      const resolutionMatch = body.match(/# Resolution\s*\n([\s\S]*)$/)

      return {
        id: frontmatter.id,
        target: frontmatter.target,
        target_lines: frontmatter.target_lines,
        anchor_before: frontmatter.anchor_before,
        anchor_text: frontmatter.anchor_text,
        anchor_after: frontmatter.anchor_after,
        severity: frontmatter.severity,
        author: frontmatter.author,
        source: frontmatter.source,
        created: frontmatter.created,
        status: frontmatter.status,
        comment: commentMatch?.[1]?.trim() || '',
        resolution: resolutionMatch?.[1]?.trim(),
      }
    } catch {
      return null
    }
  }

  private sanitizeFileName(name: string): string {
    return name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .substring(0, 100)
  }

  private getDefaultProviderId(): string | null {
    const row = this.db.getDb().prepare(
      "SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1"
    ).get() as any
    return row?.id || null
  }

  private isSourceIngested(projectId: string, rawFilePath: string): boolean {
    const paths = this.ensureWikiStructure(projectId)
    const sourceSlug = path.basename(rawFilePath, '.md')
    return fs.existsSync(path.join(paths.wikiSummariesPath, `${sourceSlug}.md`))
  }

  private getWikiPagesBySource(projectId: string, sourceSlug: string): Array<{ pagePath: string; title: string; type: string }> {
    const paths = this.ensureWikiStructure(projectId)
    const result: Array<{ pagePath: string; title: string; type: string }> = []

    const summaryFile = path.join(paths.wikiSummariesPath, `${sourceSlug}.md`)
    if (fs.existsSync(summaryFile)) {
      result.push({ pagePath: summaryFile, title: sourceSlug, type: 'summary' })
    }

    const pageDirs = [
      { dir: paths.wikiConceptsPath, type: 'concept' },
      { dir: paths.wikiEntitiesPath, type: 'entity' },
    ]

    for (const { dir, type } of pageDirs) {
      if (!fs.existsSync(dir)) continue
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8')
          const { frontmatter } = this.parseMarkdown(content)
          const sources: string[] = frontmatter.sources || []
          if (sources.includes(sourceSlug)) {
            result.push({ pagePath: path.join(dir, file), title: frontmatter.title || file, type })
          }
        } catch {}
      }
    }

    return result
  }

  private splitConceptPage(projectId: string, concept: any, sourceSlug: string, now: string): number {
    const paths = this.ensureWikiStructure(projectId)
    const conceptSlug = this.sanitizeFileName(concept.title)
    const conceptDir = path.join(paths.wikiConceptsPath, conceptSlug)
    
    // 创建概念子目录
    if (!fs.existsSync(conceptDir)) {
      fs.mkdirSync(conceptDir, { recursive: true })
    }

    let pagesCreated = 0

    // 生成index.md入口文件
    let indexPage = `---
title: "${concept.title}"
type: concept
is_folder_index: true
created: "${now}"
updated: "${now}"
sources: ["${sourceSlug}"]
tags: [${(concept.tags || []).map((t: string) => `"${t}"`).join(', ')}]
---

# ${concept.title}

${concept.summary || ''}

## 子页面
`

    // 拆分章节
    const sections = [
      { title: 'What it is', content: concept.content || '' },
      { title: 'How it works', content: concept.how_it_works || '' },
      { title: 'Key properties / tradeoffs', content: (concept.key_properties || []).map((p: string) => `- ${p}`).join('\n') },
      { title: 'Relationship to other concepts', content: (concept.related_concepts || []).map((c: string) => `- [[${c}]]`).join('\n') }
    ]

    const subPages: Array<{ title: string, slug: string, content: string }> = []

    for (const section of sections) {
      if (!section.content.trim()) continue
      
      const sectionSlug = this.sanitizeFileName(section.title)
      const subPageTitle = `${concept.title} - ${section.title}`
      
      subPages.push({
        title: subPageTitle,
        slug: sectionSlug,
        content: section.content
      })

      // 添加到index.md的子页面列表
      indexPage += `- [[${subPageTitle}]]\n`
    }

    // 写入index.md
    fs.writeFileSync(path.join(conceptDir, 'index.md'), indexPage, 'utf-8')
    pagesCreated++

    // 写入各个子页面
    for (const subPage of subPages) {
      const subPageContent = `---
title: "${subPage.title}"
type: concept
parent_concept: "${concept.title}"
created: "${now}"
updated: "${now}"
sources: ["${sourceSlug}"]
tags: [${(concept.tags || []).map((t: string) => `"${t}"`).join(', ')}]
---

# ${subPage.title}

${subPage.content}

## 来源
- [[summaries/${sourceSlug}]]
`
      fs.writeFileSync(path.join(conceptDir, `${subPage.slug}.md`), subPageContent, 'utf-8')
      pagesCreated++
    }

    this.appendLogEntry(projectId, 'split', `拆分概念页面 "${concept.title}" 到子目录`, [
      `创建 ${pagesCreated} 个页面`
    ])

    return pagesCreated
  }

  private cleanSourcePages(projectId: string, sourceSlug: string): CleanSourceResult {
    const pages = this.getWikiPagesBySource(projectId, sourceSlug)
    const pagesRemoved: string[] = []
    let summaryRemoved = false

    for (const p of pages) {
      try {
        fs.unlinkSync(p.pagePath)
        pagesRemoved.push(p.pagePath)
        if (p.type === 'summary') summaryRemoved = true
      } catch (err: any) {
        console.warn(`Failed to remove wiki page: ${p.pagePath}`, err.message)
      }
    }

    // 清理可能存在的空目录
    const paths = this.ensureWikiStructure(projectId)
    const conceptDirs = fs.readdirSync(paths.wikiConceptsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
    
    for (const dir of conceptDirs) {
      const fullDirPath = path.join(paths.wikiConceptsPath, dir)
      const files = fs.readdirSync(fullDirPath)
      if (files.length === 0) {
        fs.rmdirSync(fullDirPath)
      }
    }

    return { removed: pagesRemoved.length, summary_removed: summaryRemoved, pages_removed: pagesRemoved }
  }

  removeSourcePages(projectId: string, sourceSlug: string): CleanSourceResult {
    const result = this.cleanSourcePages(projectId, sourceSlug)
    this.updateWikiIndex(projectId)
    return result
  }

  async resolveAudit(
    projectId: string,
    auditId: string,
    resolution: string,
    newContent?: string
  ): Promise<{ success: boolean, message: string }> {
    const paths = this.ensureWikiStructure(projectId)
    
    try {
      // 查找对应的审核文件
      let auditFilePath = ''
      const auditFiles = fs.readdirSync(paths.auditPath).filter(f => f.startsWith(auditId.split('-')[0]) && f.endsWith('.md'))
      
      if (auditFiles.length === 0) {
        return { success: false, message: '未找到对应的审核文件' }
      }
      
      auditFilePath = path.join(paths.auditPath, auditFiles[0])
      
      // 读取审核文件
      const content = fs.readFileSync(auditFilePath, 'utf-8')
      const { frontmatter, body } = this.parseMarkdown(content)
      
      // 如果有新内容，更新对应的wiki页面
      if (newContent && frontmatter.target) {
        const targetPath = path.join(paths.wikiPath, frontmatter.target)
        if (fs.existsSync(targetPath)) {
          // 读取原页面内容，保留frontmatter，替换body
          const targetContent = fs.readFileSync(targetPath, 'utf-8')
          const targetMatch = targetContent.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
          
          if (targetMatch) {
            const updatedContent = `---
${targetMatch[1]}
---

${newContent}
`
            fs.writeFileSync(targetPath, updatedContent, 'utf-8')
            
            // 更新页面的updated时间
            const pageContent = fs.readFileSync(targetPath, 'utf-8')
            const { frontmatter: pageFrontmatter, body: pageBody } = this.parseMarkdown(pageContent)
            pageFrontmatter.updated = new Date().toISOString()
            
            // 重新写入带更新时间的内容
            const frontmatterStr = Object.entries(pageFrontmatter)
              .map(([key, value]) => {
                if (Array.isArray(value)) {
                  return `${key}: [${value.map(v => typeof v === 'string' ? `"${v}"` : v).join(', ')}]`
                } else if (typeof value === 'string') {
                  return `${key}: "${value}"`
                } else {
                  return `${key}: ${value}`
                }
              })
              .join('\n')
            
            const finalContent = `---
${frontmatterStr}
---

${pageBody}
`
            fs.writeFileSync(targetPath, finalContent, 'utf-8')
          }
        }
      }
      
      // 更新审核文件，添加resolution部分，修改status为resolved
      const updatedAuditContent = content.replace(/status: open/, 'status: resolved') + `

# Resolution

${new Date().toISOString().slice(0, 10)}
${resolution}
`
      
      fs.writeFileSync(auditFilePath, updatedAuditContent, 'utf-8')
      
      // 移动到resolved目录
      const resolvedFilePath = path.join(paths.auditResolvedPath, path.basename(auditFilePath))
      fs.renameSync(auditFilePath, resolvedFilePath)
      
      // 记录日志
      this.appendLogEntry(projectId, 'audit', `处理审核 ${auditId}`, [
        `状态：已解决`
      ])
      
      // 更新wiki索引
      await this.updateWikiIndex(projectId)
      
      return { success: true, message: '审核处理完成' }
    } catch (err: any) {
      console.error('处理审核失败:', err)
      return { success: false, message: `处理审核失败: ${err.message}` }
    }
  }

  async getWikiContextForQuery(projectId: string, query: string, maxChars: number = 6000): Promise<string> {
    const results = await this.searchWiki(projectId, query, 5)
    if (results.length === 0) return ''

    let context = '\n\n【Wiki 知识库参考】\n\n'
    let usedChars = context.length

    for (const result of results) {
      const pageText = `# ${result.page.title}\n${result.page.content}\n\n`
      if (usedChars + pageText.length > maxChars) break
      context += pageText
      usedChars += pageText.length
    }

    return context
  }
}

export default LLMWikiService
