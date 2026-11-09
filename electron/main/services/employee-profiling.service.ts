import DatabaseService from './database.service'
import KMSDatabaseService from './kms/kms-database.service'
import { createPiProvider } from './agent/llm/pi-provider-factory'
import type { LLMMessage } from './agent/llm/types'
import SkillRegistryService from './skill-registry.service'
import { getDefaultProviderId } from './common-utils'
import { allBuiltinTools } from './agent/tools'
import { createLogger } from './logger'

const logger = createLogger('EmployeeProfiling')

export interface EmployeeProfile {
  roleName: string
  roleDescription: string
  /** 简短描述：目标 ≤150 字；生成接口最多截断到 300 字符，analyze 结果原样返回 */
  description: string
  suggestedSkills: SuggestedSkill[]
  suggestedTools: string[]
}

export interface SuggestedSkill {
  type: string
  name: string
  description: string
  promptTemplate: string
  rules: Array<{
    description: string
    condition?: string
    action?: string
  }>
  testCases: Array<{
    input: string
    expectedOutput: string
  }>
  sourceFiles: string[]
  enabled: boolean
}

interface CollectionContent {
  collectionId: string
  collectionName: string
  collectionDescription: string
  globalSummary: string
  keyTopics: string[]
  documentSummaries: Array<{
    docName: string
    summary: string
    mainTopics: string[]
  }>
  paragraphSamples: Array<{
    docName: string
    title: string
    titlePath: string
    content: string
  }>
}

export interface ContextFile {
  name: string
  content: string
}

class EmployeeProfilingService {
  private db: DatabaseService
  private static instance: EmployeeProfilingService

  private constructor() {
    // KMS 库（1GB+）按需打开：启动时打开会额外耗时数百 ms
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): EmployeeProfilingService {
    if (!EmployeeProfilingService.instance) {
      EmployeeProfilingService.instance = new EmployeeProfilingService()
    }
    return EmployeeProfilingService.instance
  }

  async analyzeForEmployee(
    _employeeId: string,
    collectionIds: string[],
    providerId?: string,
    modelId?: string,
    additionalContext?: string,
    contextFile?: ContextFile,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; analysisMethod: 'llm' | 'heuristic' | 'default'; error?: string; messages?: Array<{ role: string; content: string }> }> {
    const collectionContents = this.loadCollectionContents(collectionIds)
    const defaultProvider = providerId || this.getDefaultProviderId()

    if (!defaultProvider) {
      if (contextFile) {
        return { profile: this.getFileHeuristicProfile(contextFile), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，请先在设置中配置 LLM 提供商' }
      }
      if (collectionContents.length > 0) {
        return { profile: this.getHeuristicProfile(collectionContents), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，请先在设置中配置 LLM 提供商' }
      }
      if (additionalContext?.trim()) {
        return { profile: this.getBriefHeuristicProfile(additionalContext), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，已将你的需求直接作为系统提示词' }
      }
      return { profile: this.getDefaultProfile(), analysisMethod: 'default' }
    }

    try {
      const prepareDetail = contextFile
        ? `准备分析提示词文件 ${contextFile.name}...`
        : collectionContents.length > 0
          ? `准备分析 ${collectionContents.length} 个合集...`
          : '准备分析业务描述...'
      onProgress?.({ stage: 'preparing', detail: prepareDetail })
      const { profile, messages } = await this.analyzeWithLLM(collectionContents, defaultProvider, modelId, additionalContext, contextFile, onProgress)
      onProgress?.({ stage: 'done', detail: '分析完成' })
      return { profile, analysisMethod: 'llm', messages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      logger.error('LLM profiling failed, falling back to heuristic:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      if (contextFile) {
        return { profile: this.getFileHeuristicProfile(contextFile), analysisMethod: 'heuristic', error: `LLM 调用失败: ${errorMsg}` }
      }
      if (collectionContents.length > 0) {
        return { profile: this.getHeuristicProfile(collectionContents), analysisMethod: 'heuristic', error: `LLM 调用失败: ${errorMsg}` }
      }
      if (additionalContext?.trim()) {
        return { profile: this.getBriefHeuristicProfile(additionalContext), analysisMethod: 'heuristic', error: `LLM 调用失败，已将你的需求直接作为系统提示词: ${errorMsg}` }
      }
      return { profile: this.getDefaultProfile(), analysisMethod: 'default', error: `LLM 调用失败: ${errorMsg}` }
    }
  }

  async refineProfileForEmployee(
    previousMessages: Array<{ role: string; content: string }>,
    previousProfile: EmployeeProfile,
    feedback: string,
    providerId: string,
    modelId?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; messages: Array<{ role: string; content: string }>; error?: string }> {
    try {
      const profileJson = JSON.stringify({
        roleName: previousProfile.roleName,
        roleDescription: previousProfile.roleDescription,
        description: previousProfile.description,
        suggestedTools: previousProfile.suggestedTools,
      }, null, 2)

      const refinePrompt = `Revise the digital-employee profile below using the user's feedback. Return JSON only.

Current result (authoritative; it may differ from earlier messages because the user edited it):
\`\`\`json
${profileJson}
\`\`\`

User feedback:
${feedback}

Available system tools (suggestedTools may only use a name from this list):
${this.getSystemToolsList().map(t => `- ${t.name} (${t.title})`).join('\n')}

Output fields:
- roleName: concise professional job title
- roleDescription: a ready-to-use system prompt written in the second person ("You are ..."); it must be detailed and structured, covering role and positioning, core responsibilities, standard workflow, output format and quality bar, constraints and boundaries, and communication style, with short section headings and bullet points; it is used directly as the employee's system prompt
- description: capability summary of at most 150 characters, explaining what this employee can do so users and other employees can decide whether to delegate; plain text, not a list
- suggestedTools: tool names to enable, taken only from the list above

Write every field in the language of the user's feedback, and keep every rule that the feedback does not contradict.`

      onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 优化分析结果...' })

      // 已有分析历史时直接追加反馈，避免出现连续两条 assistant 消息被部分模型拒绝
      const messages = previousMessages.length > 0
        ? [...previousMessages, { role: 'user', content: refinePrompt }]
        : [
            { role: 'system', content: 'You revise digital-employee plans. Return JSON only. roleDescription must be a complete, detailed, ready-to-use system prompt; description at most 150 characters; suggestedTools only from the provided list.' },
            { role: 'user', content: refinePrompt },
          ]

      const fullResponse = await this.streamLLMWithProgress(providerId, messages, modelId, 'profiling_refine', onProgress)

      onProgress?.({ stage: 'parsing', detail: '正在解析优化结果...' })

      const cleaned = this.extractJsonFromResponse(fullResponse)
      if (!cleaned) {
        throw new Error('No JSON found in LLM response')
      }

      let result: any
      try {
        result = JSON.parse(cleaned)
      } catch (e) {
        throw new Error(`优化结果 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
      }

      const profile: EmployeeProfile = {
        roleName: result.roleName || previousProfile.roleName,
        roleDescription: result.roleDescription || previousProfile.roleDescription,
        description: result.description || previousProfile.description || '',
        suggestedSkills: previousProfile.suggestedSkills,
        suggestedTools: Array.isArray(result.suggestedTools) ? result.suggestedTools : previousProfile.suggestedTools,
      }

      onProgress?.({ stage: 'done', detail: '优化完成' })
      const updatedMessages = [...messages, { role: 'assistant', content: fullResponse }]
      return { profile, messages: updatedMessages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      logger.error('LLM refine profiling failed:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      return { profile: previousProfile, messages: previousMessages, error: `LLM 调用失败: ${errorMsg}` }
    }
  }

  private loadCollectionContents(collectionIds: string[]): CollectionContent[] {
    const results: CollectionContent[] = []
    const db = KMSDatabaseService.getInstance().getDb()

    for (const collectionId of collectionIds) {
      const collection = db.prepare('SELECT * FROM kms_collections WHERE id = ?').get(collectionId) as any
      if (!collection) continue

      const content: CollectionContent = {
        collectionId: collection.id,
        collectionName: collection.name,
        collectionDescription: collection.description || '',
        globalSummary: '',
        keyTopics: [],
        documentSummaries: [],
        paragraphSamples: [],
      }

      const collectionSummary = db.prepare('SELECT * FROM kms_collection_summaries WHERE collection_id = ?').get(collectionId) as any
      if (collectionSummary) {
        content.globalSummary = collectionSummary.summary || ''
        try { content.keyTopics = JSON.parse(collectionSummary.key_topics_json || '[]') } catch (err: any) {
          logger.debug(`Failed to parse key_topics_json for collection ${collectionId}:`, err?.message || err)
        }
      }

      const fileSummaries = db.prepare(`
        SELECT s.summary, s.main_topics_json, f.file_name
        FROM kms_file_collections fc
        JOIN kms_files f ON fc.file_id = f.id
        LEFT JOIN kms_file_summaries s ON s.file_id = f.id
        WHERE fc.collection_id = ?
      `).all(collectionId) as any[]
      for (const fs of fileSummaries) {
        const docSummary: CollectionContent['documentSummaries'][0] = {
          docName: fs.file_name,
          summary: fs.summary || '',
          mainTopics: [],
        }
        try { docSummary.mainTopics = JSON.parse(fs.main_topics_json || '[]') } catch (err: any) {
          logger.debug(`Failed to parse main_topics_json for file ${fs.file_name}:`, err?.message || err)
        }
        content.documentSummaries.push(docSummary)
      }

      const paragraphs = db.prepare(`
        SELECT p.title, p.title_path, p.content, f.file_name
        FROM kms_paragraphs p
        JOIN kms_file_collections fc ON p.file_id = fc.file_id
        JOIN kms_files f ON p.file_id = f.id
        WHERE fc.collection_id = ?
        ORDER BY p.paragraph_index
        LIMIT 30
      `).all(collectionId) as any[]
      for (const p of paragraphs) {
        content.paragraphSamples.push({
          docName: p.file_name,
          title: p.title,
          titlePath: p.title_path || '',
          content: (p.content || '').substring(0, 500),
        })
      }

      results.push(content)
    }

    return results
  }

  private getDefaultProviderId(): string | null {
    return getDefaultProviderId(this.db)
  }

  private getSystemToolsList(): Array<{ name: string; title: string; description: string }> {
    return allBuiltinTools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description }))
  }

  private async analyzeWithLLM(
    collectionContents: CollectionContent[],
    providerId: string,
    modelId?: string,
    additionalContext?: string,
    contextFile?: ContextFile,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; messages: Array<{ role: string; content: string }> }> {
    const hasCollection = collectionContents.length > 0
    const hasFile = !!contextFile
    const combinedText = hasCollection ? this.buildCombinedCollectionDocument(collectionContents) : ''
    const maxLength = 12000
    const truncatedText = combinedText.length > maxLength
      ? combinedText.substring(0, maxLength) + '\n...[truncated; total ' + combinedText.length + ' characters]'
      : combinedText

    const userGuidance = additionalContext
      ? `\n\n## Additional user context\n${additionalContext}\n\nPrioritize this context when designing the role.`
      : ''

    const allTools = this.getSystemToolsList()
    const toolsListText = allTools.map(t => `- ${t.name} (${t.title}): ${t.description}`).join('\n')

    let prompt: string
    const toolsSection = `\nAvailable system tools (suggestedTools may only use a name from this list):\n${toolsListText}\n\nOutput fields (JSON only):\n- roleName: concise professional job title\n- roleDescription: a ready-to-use system prompt written in the second person ("You are ..."); it must be detailed and structured, covering role and positioning, core responsibilities, standard workflow, output format and quality bar, constraints and boundaries, and communication style, with short section headings and bullet points; it is used directly as the employee's system prompt\n- description: capability summary of at most 150 characters, explaining what this employee can do and is good at so users and other employees can decide whether to delegate; plain text, not a list\n- suggestedTools: tool names to enable, taken only from the list above (e.g. "file", "date_time")`
    if (hasFile && contextFile) {
      const fileMaxLength = 20000
      const fileContent = contextFile.content.length > fileMaxLength
        ? contextFile.content.substring(0, fileMaxLength) + '\n...[truncated; total ' + contextFile.content.length + ' characters]'
        : contextFile.content
      prompt = `Design a digital-employee role from the provided prompt file. Return JSON only.

Prompt file (${contextFile.name}):
${fileContent}${userGuidance}

Requirements:
1. The file is a prepared role prompt or rule set (for example AGENTS.md or CLAUDE.md).
2. Preserve its duties, workflow, cautions, constraints, tool-usage rules, output format, and interaction rules in roleDescription; do not drop rules.
3. Choose an appropriate roleName from the content.

Write every field in the language of the prompt file.
${toolsSection}`
    } else if (hasCollection) {
      prompt = `Design a digital-employee role from the knowledge-base collection below. Return JSON only.

Collection material:
${truncatedText}${userGuidance}

Requirements:
1. Determine the business domain from the collection's subject matter, document types, and key topics.
2. Choose roleName and the role's position from that domain.
3. Derive the duties the employee should own (answering related questions, handling corresponding business requests).
4. Define the workflow, output format, constraints, and cautions from the business characteristics, and write them into a detailed, ready-to-use system prompt.

Write every field in the language of the collection material.
${toolsSection}`
    } else {
      prompt = `Design a digital employee from the user's brief. Return JSON only.

User brief:
${additionalContext || '(empty; design a general-purpose digital employee)'}

Requirements:
1. Infer the domain, the recurring work, expected deliverables, and audience from the brief. Do not invent company-specific facts, tools, or policies that the brief does not mention.
2. roleName: a concise professional job title (2-8 words).
3. roleDescription: write a complete, production-ready system prompt that is specific to this brief rather than generic filler; it must cover role and positioning, core responsibilities, standard workflow, output format and quality bar, constraints and boundaries (including when to ask the user for clarification), and communication style.
4. description: summarize the capability in one plain-text paragraph of at most 150 characters.

Write every field in the language of the user's brief.
${toolsSection}`
    }

    onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 进行智能分析...' })

    const llmMessages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: hasFile
          ? 'Design a digital-employee role from the provided prompt file. Return JSON only. Preserve every rule from the file in roleDescription; description at most 150 characters; suggestedTools only from the provided list.'
          : 'Design a digital employee from the knowledge-base collection or the user brief. Return JSON only. roleDescription is a detailed, ready-to-use system prompt (role, responsibilities, workflow, output format, constraints, style); description at most 150 characters; suggestedTools only from the provided list.'
      },
      { role: 'user', content: prompt },
    ]

    const fullResponse = await this.streamLLMWithProgress(providerId, llmMessages, modelId, 'profiling_analyze', onProgress)

    onProgress?.({ stage: 'parsing', detail: '正在解析分析结果...' })

    const cleaned = this.extractJsonFromResponse(fullResponse)
    if (!cleaned) {
      throw new Error('No JSON found in LLM response')
    }

    let result: any
    try {
      result = JSON.parse(cleaned)
    } catch (e) {
      throw new Error(`分析结果 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
    }

    const profile: EmployeeProfile = {
      roleName: result.roleName || '数字员工',
      roleDescription: result.roleDescription || (hasFile ? '基于提示词文件自动创建的数字员工' : hasCollection ? '基于资料库合集自动创建的数字员工' : '基于业务描述自动创建的数字员工'),
      description: typeof result.description === 'string' ? result.description.trim() : '',
      suggestedSkills: [],
      suggestedTools: Array.isArray(result.suggestedTools) ? result.suggestedTools : [],
    }

    const messages = [...llmMessages, { role: 'assistant', content: fullResponse }]
    return { profile, messages }
  }

  private extractJsonFromResponse(text: string): string | null {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (codeBlockMatch) {
      const inner = codeBlockMatch[1].trim()
      const jsonMatch = inner.match(/\{[\s\S]*\}/)
      if (jsonMatch) return jsonMatch[0]
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) return jsonMatch[0]
    return null
  }

  private async streamLLMWithProgress(
    providerId: string,
    messages: Array<{ role: string; content: string }>,
    modelId: string | undefined,
    logSource: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<string> {
    const provider = await createPiProvider(providerId, modelId)
    if (!provider) throw new Error('LLM Provider not found')

    const response = await provider.chatStream(
      messages as LLMMessage[],
      [],
      {
        onChunk: (chunk: string) => {
          onProgress?.({ stage: 'streaming', chunk })
        },
        onThought: (thoughtChunk: string) => {
          onProgress?.({ stage: 'thinking', chunk: thoughtChunk })
        },
        onToolCall: () => { /* 画像分析不使用工具 */ },
      },
      undefined,
      { temperature: 0.7, maxTokens: 8192, logSource },
    )

    if (!response.content) throw new Error('LLM 流式响应未正常完成')

    return response.content
  }

  private buildCombinedCollectionDocument(collectionContents: CollectionContent[]): string {
    const parts: string[] = []

    for (const col of collectionContents) {
      parts.push(`\n=== Collection: ${col.collectionName} ===`)
      if (col.collectionDescription) {
        parts.push(`Description: ${col.collectionDescription}`)
      }

      if (col.globalSummary) {
        parts.push(`\n[Global Summary]\n${col.globalSummary}`)
      }

      if (col.keyTopics.length > 0) {
        parts.push(`\n[Key Topics] ${col.keyTopics.join(', ')}`)
      }

      if (col.documentSummaries.length > 0) {
        parts.push('\n[Document Summaries]')
        for (const doc of col.documentSummaries) {
          parts.push(`\n--- Document: ${doc.docName} ---`)
          if (doc.summary) parts.push(doc.summary)
          if (doc.mainTopics.length > 0) parts.push(`Topics: ${doc.mainTopics.join(', ')}`)
        }
      }

      if (col.paragraphSamples.length > 0) {
        parts.push('\n[Paragraph Samples]')
        for (const p of col.paragraphSamples.slice(0, 10)) {
          parts.push(`\n--- ${p.docName} / ${p.titlePath || p.title} ---`)
          parts.push(p.content)
        }
      }
    }

    return parts.join('\n')
  }

  private getHeuristicProfile(collectionContents: CollectionContent[]): EmployeeProfile {
    const collectionNames = collectionContents.map((c) => c.collectionName)
    const allText = collectionContents.map((c) => [c.globalSummary, ...c.documentSummaries.map(d => d.summary)].join(' ')).join(' ').toLowerCase()

    const skills: SuggestedSkill[] = []

    if (allText.includes('合同') || allText.includes('协议') || allText.includes('条款')) {
      skills.push({
        type: 'extraction',
        name: '合同审核',
        description: '审核合同条款，识别风险点和缺失项',
        promptTemplate: `You are a contract review specialist. Review contract clauses, identify risks, and flag missing terms.

Review points:
1. Completeness of the parties' information
2. Payment amount, schedule, and method are explicit
3. Liability for breach is balanced between both parties
4. Dispute resolution
5. Confidentiality and intellectual property

Output: a summary of basic information, a risk list (with severity and suggested revision), missing-clause reminders, and an overall assessment.`,
        rules: [
          { description: '付款条款必须明确金额、时间和方式', condition: '遇到付款相关条款', action: '详细审核并标注风险' },
          { description: '违约责任必须对等', condition: '遇到违约责任条款', action: '检查双方责任是否平衡' },
        ],
        testCases: [
          { input: '请审核这份采购合同', expectedOutput: '包含风险点列表和评估意见的审核报告' },
        ],
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    if (allText.includes('faq') || allText.includes('问答') || allText.includes('常见问题')) {
      skills.push({
        type: 'qa',
        name: '知识问答',
        description: '基于资料库合集回答用户问题',
        promptTemplate: `You are a knowledge advisor. Answer strictly from the knowledge-base collection.

Rules:
1. Never invent answers outside the collection.
2. State clearly when no relevant information exists.
3. Cite the source file and paragraph.
Keep answers professional, concise, and accurate.`,
        rules: [
          { description: '必须引用知识来源', condition: '回答问题时', action: '标注信息来源文件' },
          { description: '不确定时明确告知', condition: '资料库中无相关信息', action: '说明无法回答，不编造' },
        ],
        testCases: [
          { input: '这个产品的保修期是多久？', expectedOutput: '基于资料库给出准确答案并引用来源' },
        ],
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    if (allText.includes('报表') || allText.includes('数据') || allText.includes('统计')) {
      skills.push({
        type: 'query',
        name: '数据分析',
        description: '查询和分析数据，生成统计结果',
        promptTemplate: `You are a data analyst.

Steps: understand the request → define dimensions → aggregate and compute → draw conclusions.

Output: query conditions, statistics, key findings, and recommendations.`,
        rules: [
          { description: '数据必须准确', condition: '涉及数值计算', action: '仔细核对计算过程' },
        ],
        testCases: [
          { input: '统计上个月的销售额', expectedOutput: '包含具体数字的分析报告' },
        ],
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    if (skills.length === 0) {
      skills.push({
        type: 'qa',
        name: '通用问答',
        description: '基于资料库合集回答各类问题',
        promptTemplate: `Answer user questions from the knowledge-base collection.

Rules: use only collection content; state clearly when evidence is missing; cite sources.`,
        rules: [],
        testCases: [
          { input: '请介绍一下相关内容', expectedOutput: '基于资料库的概括性回答' },
        ],
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    return {
      roleName: '数字员工',
      roleDescription: '基于资料库合集自动创建的数字员工，提供专业知识服务。负责回答用户咨询、处理业务请求、提供专业建议。专业耐心，风格严谨细致。',
      description: '基于资料库合集提供专业知识服务的数字员工，可解答咨询、处理业务请求并提供专业建议。',
      suggestedSkills: skills,
      suggestedTools: [],
    }
  }

  private getDefaultProfile(): EmployeeProfile {
    return {
      roleName: '通用数字员工',
      roleDescription: '一个通用的数字员工，可以回答各类问题和提供信息查询。友好专业，准确回答用户问题。',
      description: '通用数字员工，可回答各类问题并提供信息查询。',
      suggestedSkills: [{
        type: 'qa',
        name: '通用问答',
        description: '回答用户的各类问题',
        promptTemplate: 'Answer user questions professionally and accurately.',
        rules: [],
        testCases: [],
        sourceFiles: [],
        enabled: true,
      }],
      suggestedTools: [],
    }
  }

  /** 无 LLM 时基于提示词文件直接生成画像：完整保留文件内容到描述，避免丢失规则 */
  private getFileHeuristicProfile(contextFile: ContextFile): EmployeeProfile {
    const name = (contextFile.name || '').replace(/\.(md|markdown|txt)$/i, '')
    return {
      roleName: name || '数字员工',
      roleDescription: contextFile.content.trim() || '基于提示词文件自动创建的数字员工',
      description: `基于提示词文件「${name || contextFile.name}」创建的数字员工。`,
      suggestedSkills: [],
      suggestedTools: [],
    }
  }

  /** 无 LLM 时把用户需求原文作为系统提示词，保证需求不丢失 */
  private getBriefHeuristicProfile(brief: string): EmployeeProfile {
    const text = brief.trim()
    const summary = text.replace(/\s+/g, ' ')
    return {
      roleName: '数字员工',
      roleDescription: text,
      description: summary.length > 150 ? summary.slice(0, 150) : summary,
      suggestedSkills: [],
      suggestedTools: [],
    }
  }

  /** 解析描述生成用 LLM：creation 场景默认模型 > 默认提供商 > 任意可用提供商 */
  private resolveDescriptionLLM(): { provider_id: string; model_id?: string } | null {
    const db = this.db.getDb()
    const setting = db.prepare(
      "SELECT value FROM settings WHERE key = 'default_model_creation'"
    ).get() as { value: string } | undefined
    if (setting?.value) {
      try {
        const parsed = JSON.parse(setting.value) as { provider_id?: string; model_id?: string }
        const exists = parsed.provider_id
          && db.prepare('SELECT 1 FROM llm_providers WHERE id = ?').get(parsed.provider_id)
        if (parsed.provider_id && exists) {
          return { provider_id: parsed.provider_id, model_id: parsed.model_id?.trim() || undefined }
        }
      } catch { /* ignore invalid JSON */ }
    }
    const row = db.prepare(
      'SELECT id FROM llm_providers ORDER BY is_default DESC LIMIT 1'
    ).get() as { id: string } | undefined
    return row?.id ? { provider_id: row.id } : null
  }

  /**
   * 根据员工名称、规则（系统提示词）、可用工具与技能，用 LLM 生成简短描述（≤150字）。
   * 生成结果不直接落库，由前端填入表单供用户确认后保存。
   */
  async generateEmployeeDescription(params: {
    employee_id: string
    provider_id?: string
    model_id?: string
    /** 未保存的表单值优先于 DB */
    name?: string
    rules?: string
  }): Promise<{ success: boolean; description?: string; error?: string }> {
    try {
      const db = this.db.getDb()
      const emp = db.prepare('SELECT id, name, rules, profile_json FROM employees WHERE id = ?').get(params.employee_id) as
        | { id: string; name: string; rules?: string | null; profile_json?: string | null }
        | undefined
      if (!emp) {
        return { success: false, error: '员工不存在' }
      }

      const resolved = this.resolveDescriptionLLM()
      const providerId = params.provider_id || resolved?.provider_id
      if (!providerId) {
        return { success: false, error: 'NO_LLM_PROVIDER' }
      }
      const modelId = params.model_id || resolved?.model_id

      const name = params.name?.trim() || emp.name

      // 提示词来源：表单 rules > DB rules > profile_json.roleDescription
      let promptText = params.rules?.trim() || emp.rules?.trim() || ''
      if (!promptText && emp.profile_json) {
        try {
          const profile = JSON.parse(emp.profile_json)
          promptText = profile?.roleDescription || ''
        } catch { /* ignore */ }
      }
      const truncatedPrompt = promptText.length > 4000
        ? promptText.substring(0, 4000) + '\n...[已截断]'
        : promptText

      // 已启用工具（title）：未显式关闭的内置工具视为可用（与 agent 默认行为一致）
      const toolRows = db.prepare(
        'SELECT tool_id, tool_mode FROM employee_tools WHERE employee_id = ?'
      ).all(params.employee_id) as Array<{ tool_id: string; tool_mode?: string }>
      const modeMap = new Map<string, string>()
      for (const r of toolRows) {
        if (r.tool_mode === 'on' || r.tool_mode === 'on_demand' || r.tool_mode === 'off') {
          modeMap.set(r.tool_id, r.tool_mode)
        }
      }
      const enabledTools = allBuiltinTools
        .filter(t => modeMap.get(t.id) !== 'off')
        .map(t => t.title)

      // 已启用技能
      let enabledSkills: string[] = []
      try {
        enabledSkills = SkillRegistryService.getInstance()
          .getEmployeeSkills(params.employee_id)
          .enabled.map(s => s.name)
      } catch { /* ignore */ }

      const prompt = `Generate a capability description for the digital employee below.

Name: ${name}
${promptText ? `Rules / system prompt:\n${truncatedPrompt}` : '(no rules yet; treat as a general digital employee)'}
Enabled tools: ${enabledTools.join(', ') || '(none)'}
Enabled skills: ${enabledSkills.join(', ') || '(none)'}

Requirements:
1. Explain what this employee can do and is good at, so users and other employees can decide whether to delegate.
2. At most 150 characters, one plain-text paragraph, no list, heading, or Markdown.
3. Output only the description, with no prefix, quotes, or explanation.

Write in the same language as the employee name and rules.`

      const fullResponse = await this.streamLLMWithProgress(
        providerId,
        [
          { role: 'system', content: 'You write concise, objective capability descriptions for digital employees.' },
          { role: 'user', content: prompt },
        ],
        modelId,
        'employee_description_gen'
      )

      const description = fullResponse
        .trim()
        .replace(/^["'「『]+/, '')
        .replace(/["'」』]+$/, '')
        .trim()
        .slice(0, 300)
      if (!description) {
        return { success: false, error: '生成结果为空' }
      }
      return { success: true, description }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      logger.error('Generate employee description failed:', error)
      return { success: false, error: errorMsg }
    }
  }
}

export default EmployeeProfilingService
