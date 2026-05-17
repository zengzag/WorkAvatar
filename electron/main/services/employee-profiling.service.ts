import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'
import LLMClientService from './llm-client.service'
import { getDefaultProviderId } from './common-utils'

export interface EmployeeProfile {
  roleName: string
  roleDescription: string
  responsibilities: string[]
  suggestedSkills: SuggestedSkill[]
  personalityTraits: string[]
  workingStyle: string
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
  inputSchema?: Record<string, any>
  outputSchema?: Record<string, any>
  sourceFiles: string[]
  enabled: boolean
}

interface KBContent {
  kbId: string
  kbName: string
  kbDescription: string
  globalSummary: string
  keyTopics: string[]
  keyEntities: Array<{ name: string; type: string; description: string }>
  documentSummaries: Array<{
    docName: string
    summary: string
    mainTopics: string[]
  }>
  chapterSamples: Array<{
    docName: string
    title: string
    content: string
  }>
}

class EmployeeProfilingService {
  private kbDb: KBDatabaseService
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: EmployeeProfilingService

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): EmployeeProfilingService {
    if (!EmployeeProfilingService.instance) {
      EmployeeProfilingService.instance = new EmployeeProfilingService()
    }
    return EmployeeProfilingService.instance
  }

  async analyzeForEmployee(
    _employeeId: string,
    kbIds: string[],
    providerId?: string,
    modelId?: string,
    additionalContext?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; analysisMethod: 'llm' | 'heuristic' | 'default'; error?: string; messages?: Array<{ role: string; content: string }> }> {
    const kbContents = this.loadKBContents(kbIds)
    const defaultProvider = providerId || this.getDefaultProviderId()

    if (kbContents.length === 0 && !additionalContext) {
      if (!defaultProvider) {
        return { profile: this.getDefaultProfile(), analysisMethod: 'default' }
      }
    }

    if (!defaultProvider) {
      if (kbContents.length > 0) {
        return { profile: this.getHeuristicProfile(kbContents), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，请先在设置中配置 LLM 提供商' }
      }
      return { profile: this.getDefaultProfile(), analysisMethod: 'default' }
    }

    try {
      onProgress?.({ stage: 'preparing', detail: kbContents.length > 0 ? `准备分析 ${kbContents.length} 个知识库...` : '准备分析业务描述...' })
      const { profile, messages } = await this.analyzeWithLLM(kbContents, defaultProvider, modelId, additionalContext, onProgress)
      onProgress?.({ stage: 'done', detail: '分析完成' })
      return { profile, analysisMethod: 'llm', messages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      console.error('LLM profiling failed, falling back to heuristic:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      if (kbContents.length > 0) {
        return { profile: this.getHeuristicProfile(kbContents), analysisMethod: 'heuristic', error: `LLM 调用失败: ${errorMsg}` }
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
        responsibilities: previousProfile.responsibilities,
        personalityTraits: previousProfile.personalityTraits,
        workingStyle: previousProfile.workingStyle,
        suggestedTools: previousProfile.suggestedTools,
      }, null, 2)

      const refinePrompt = `基于以下分析结果和用户反馈进行调整，JSON格式输出。

当前结果：
\`\`\`json
${profileJson}
\`\`\`

用户反馈：
${feedback}

输出字段：roleName、roleDescription、responsibilities、personalityTraits、workingStyle、suggestedTools

只输出JSON。`

      onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 优化分析结果...' })

      const messages = [
        ...previousMessages,
        { role: 'assistant', content: profileJson },
        { role: 'user', content: refinePrompt },
      ]

      let fullResponse = ''
      let streamDone = false
      let streamError: Error | null = null

      await this.llmClient.chatStream(
        providerId,
        messages,
        (chunk: string) => {
          fullResponse += chunk
          onProgress?.({ stage: 'streaming', chunk })
        },
        () => {
          streamDone = true
        },
        (error: Error) => {
          streamError = error
        },
        { temperature: 0.2, max_tokens: 8192, ...(modelId ? { model: modelId } : {}) },
        undefined,
        (thoughtChunk: string) => {
          onProgress?.({ stage: 'thinking', chunk: thoughtChunk })
        }
      )

      if (streamError) {
        throw streamError
      }
      if (!streamDone) {
        throw new Error('LLM 流式响应未正常完成')
      }

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
        responsibilities: Array.isArray(result.responsibilities) ? result.responsibilities : previousProfile.responsibilities,
        suggestedSkills: this.normalizeSkills(result.suggestedSkills, []),
        personalityTraits: Array.isArray(result.personalityTraits) ? result.personalityTraits : previousProfile.personalityTraits,
        workingStyle: result.workingStyle || previousProfile.workingStyle,
        suggestedTools: Array.isArray(result.suggestedTools) ? result.suggestedTools : previousProfile.suggestedTools,
      }

      onProgress?.({ stage: 'done', detail: '优化完成' })
      const updatedMessages = [...messages, { role: 'assistant', content: fullResponse }]
      return { profile, messages: updatedMessages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      console.error('LLM refine profiling failed:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      return { profile: previousProfile, messages: previousMessages, error: `LLM 调用失败: ${errorMsg}` }
    }
  }

  private loadKBContents(kbIds: string[]): KBContent[] {
    const results: KBContent[] = []

    for (const kbId of kbIds) {
      const kb = this.kbDb.getDb().prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbId) as any
      if (!kb) continue

      const content: KBContent = {
        kbId: kb.id,
        kbName: kb.name,
        kbDescription: kb.description || '',
        globalSummary: '',
        keyTopics: [],
        keyEntities: [],
        documentSummaries: [],
        chapterSamples: [],
      }

      const globalSummary = this.kbDb.getDb().prepare('SELECT * FROM kb_global_summaries WHERE kb_id = ?').get(kbId) as any
      if (globalSummary) {
        content.globalSummary = globalSummary.summary || ''
        try { content.keyTopics = JSON.parse(globalSummary.key_topics_json || '[]') } catch {}
        try {
          const entities = JSON.parse(globalSummary.key_entities_json || '[]')
          content.keyEntities = entities.slice(0, 20).map((e: any) => ({
            name: e.name || e,
            type: e.type || 'other',
            description: e.description || '',
          }))
        } catch {}
      }

      const docSummaries = this.kbDb.getDb().prepare('SELECT ds.*, d.original_name FROM kb_document_summaries ds JOIN kb_documents d ON ds.document_id = d.id WHERE ds.kb_id = ?').all(kbId) as any[]
      for (const ds of docSummaries) {
        const docSummary: KBContent['documentSummaries'][0] = {
          docName: ds.original_name,
          summary: ds.summary || '',
          mainTopics: [],
        }
        try { docSummary.mainTopics = JSON.parse(ds.main_topics_json || '[]') } catch {}
        content.documentSummaries.push(docSummary)
      }

      const chapters = this.kbDb.getDb().prepare('SELECT c.*, d.original_name FROM kb_chapters c JOIN kb_documents d ON c.document_id = d.id WHERE c.kb_id = ? ORDER BY c.chapter_index LIMIT 30').all(kbId) as any[]
      for (const ch of chapters) {
        content.chapterSamples.push({
          docName: ch.original_name,
          title: ch.title,
          content: (ch.content || '').substring(0, 500),
        })
      }

      results.push(content)
    }

    return results
  }

  private getDefaultProviderId(): string | null {
    return getDefaultProviderId(this.db)
  }

  private async analyzeWithLLM(
    kbContents: KBContent[],
    providerId: string,
    modelId?: string,
    additionalContext?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; messages: Array<{ role: string; content: string }> }> {
    const hasKB = kbContents.length > 0
    const combinedText = hasKB ? this.buildCombinedKBDocument(kbContents) : ''
    const maxLength = 12000
    const truncatedText = combinedText.length > maxLength
      ? combinedText.substring(0, maxLength) + '\n...[内容已截断，共' + combinedText.length + '字符]'
      : combinedText

    const userGuidance = additionalContext
      ? `\n\n## 用户补充说明\n${additionalContext}\n\n请在设计数字员工角色时，优先考虑以上用户的补充说明和期望。`
      : ''

    let prompt: string
    if (hasKB) {
      prompt = `分析知识库内容，设计数字员工角色，JSON格式输出。

知识库资料：
${truncatedText}${userGuidance}

分析维度：
1. 业务场景：领域和工作流程
2. 角色定位：如合同审核专员、客服顾问
3. 职责：具体承担的任务
4. 工作风格：严谨型、亲和型等
5. 工具需求：计算器、知识库检索等

输出字段：
- roleName: 角色名称
- roleDescription: 角色描述（100字左右）
- responsibilities: 职责列表
- personalityTraits: 特质列表
- workingStyle: 工作风格
- suggestedTools: 工具列表

只输出JSON。`
    } else {
      prompt = `根据业务描述设计数字员工角色，JSON格式输出。

${userGuidance}

分析维度：
1. 业务场景：领域和工作流程
2. 角色定位：如合同审核专员、客服顾问
3. 职责：具体承担的任务
4. 工作风格：严谨型、亲和型等
5. 工具需求：计算器、知识库检索等

输出字段：
- roleName: 角色名称
- roleDescription: 角色描述（100字左右）
- responsibilities: 职责列表
- personalityTraits: 特质列表
- workingStyle: 工作风格
- suggestedTools: 工具列表

只输出JSON。`
    }

    onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 进行智能分析...' })

    const llmMessages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: '根据知识库或业务描述设计数字员工角色，JSON格式输出。'
      },
      { role: 'user', content: prompt },
    ]

    let fullResponse = ''
    let streamDone = false
    let streamError: Error | null = null

    await this.llmClient.chatStream(
      providerId,
      llmMessages,
      (chunk: string) => {
        fullResponse += chunk
        onProgress?.({ stage: 'streaming', chunk })
      },
      () => {
        streamDone = true
      },
      (error: Error) => {
        streamError = error
      },
      { temperature: 0.2, max_tokens: 8192, ...(modelId ? { model: modelId } : {}) },
      undefined,
      (thoughtChunk: string) => {
        onProgress?.({ stage: 'thinking', chunk: thoughtChunk })
      }
    )

    if (streamError) {
      throw streamError
    }
    if (!streamDone) {
      throw new Error('LLM 流式响应未正常完成')
    }

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
      roleDescription: result.roleDescription || (hasKB ? '基于知识库自动创建的数字员工' : '基于业务描述自动创建的数字员工'),
      responsibilities: Array.isArray(result.responsibilities) ? result.responsibilities : [],
      suggestedSkills: this.normalizeSkills(result.suggestedSkills, kbContents),
      personalityTraits: Array.isArray(result.personalityTraits) ? result.personalityTraits : ['专业', '高效'],
      workingStyle: result.workingStyle || '专业严谨',
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

  private buildCombinedKBDocument(kbContents: KBContent[]): string {
    const parts: string[] = []

    for (const kb of kbContents) {
      parts.push(`\n=== 知识库: ${kb.kbName} ===`)
      if (kb.kbDescription) {
        parts.push(`描述: ${kb.kbDescription}`)
      }

      if (kb.globalSummary) {
        parts.push(`\n[全局摘要]\n${kb.globalSummary}`)
      }

      if (kb.keyTopics.length > 0) {
        parts.push(`\n[核心主题] ${kb.keyTopics.join(', ')}`)
      }

      if (kb.keyEntities.length > 0) {
        parts.push('\n[关键实体]')
        for (const entity of kb.keyEntities) {
          parts.push(`- ${entity.name} (${entity.type})${entity.description ? ': ' + entity.description : ''}`)
        }
      }

      if (kb.documentSummaries.length > 0) {
        parts.push('\n[文档摘要]')
        for (const doc of kb.documentSummaries) {
          parts.push(`\n--- 文档: ${doc.docName} ---`)
          if (doc.summary) parts.push(doc.summary)
          if (doc.mainTopics.length > 0) parts.push(`主题: ${doc.mainTopics.join(', ')}`)
        }
      }

      if (kb.chapterSamples.length > 0) {
        parts.push('\n[章节内容示例]')
        for (const ch of kb.chapterSamples.slice(0, 10)) {
          parts.push(`\n--- ${ch.docName} / ${ch.title} ---`)
          parts.push(ch.content)
        }
      }
    }

    return parts.join('\n')
  }

  private normalizeSkills(rawSkills: any[], kbContents: KBContent[]): SuggestedSkill[] {
    if (!Array.isArray(rawSkills)) return []

    const kbNames = kbContents.map((kb) => kb.kbName)

    return rawSkills.map((skill, index) => ({
      type: this.normalizeSkillType(skill.type),
      name: skill.name || `技能 ${index + 1}`,
      description: skill.description || '',
      promptTemplate: skill.promptTemplate || this.buildDefaultPrompt(skill.name, skill.description),
      rules: Array.isArray(skill.rules) ? skill.rules : [],
      testCases: Array.isArray(skill.testCases) ? skill.testCases : [],
      inputSchema: skill.inputSchema || undefined,
      outputSchema: skill.outputSchema || undefined,
      sourceFiles: Array.isArray(skill.sourceFiles) && skill.sourceFiles.length > 0
        ? skill.sourceFiles
        : kbNames,
      enabled: skill.enabled !== false,
    }))
  }

  private normalizeSkillType(type: string): string {
    const validTypes = ['extraction', 'qa', 'generation', 'classification', 'query', 'calculation', 'custom']
    const normalized = (type || '').toLowerCase().trim()
    if (validTypes.includes(normalized)) return normalized

    const typeMap: Record<string, string> = {
      '提取': 'extraction',
      '审核': 'extraction',
      '问答': 'qa',
      '咨询': 'qa',
      '生成': 'generation',
      '写作': 'generation',
      '分类': 'classification',
      '路由': 'classification',
      '查询': 'query',
      '数据': 'query',
      '计算': 'calculation',
      '推导': 'calculation',
      '自定义': 'custom',
    }

    for (const [key, value] of Object.entries(typeMap)) {
      if (normalized.includes(key)) return value
    }

    return 'custom'
  }

  private buildDefaultPrompt(skillName: string, description: string): string {
    return `你是${skillName}专家。

${description || '根据用户需求提供专业服务'}

原则：
1. 分析需求，理解意图
2. 基于专业知识处理
3. 输出准确、完整、有条理
4. 不确定时明确说明`
  }

  private getHeuristicProfile(kbContents: KBContent[]): EmployeeProfile {
    const kbNames = kbContents.map((kb) => kb.kbName)
    const allText = kbContents.map((kb) => [kb.globalSummary, ...kb.documentSummaries.map(d => d.summary)].join(' ')).join(' ').toLowerCase()

    const skills: SuggestedSkill[] = []

    if (allText.includes('合同') || allText.includes('协议') || allText.includes('条款')) {
      skills.push({
        type: 'extraction',
        name: '合同审核',
        description: '审核合同条款，识别风险点和缺失项',
        promptTemplate: `你是合同审核专员。

审核要点：
1. 主体信息完整性
2. 付款条款合理性
3. 违约责任和争议解决
4. 保密条款和知识产权
5. 风险等级标注（高/中/低）

输出：基本信息摘要、风险点列表（含等级和建议）、缺失条款提醒、总体评估。`,
        rules: [
          { description: '付款条款必须明确金额、时间和方式', condition: '遇到付款相关条款', action: '详细审核并标注风险' },
          { description: '违约责任必须对等', condition: '遇到违约责任条款', action: '检查双方责任是否平衡' },
        ],
        testCases: [
          { input: '请审核这份采购合同', expectedOutput: '包含风险点列表和评估意见的审核报告' },
        ],
        sourceFiles: kbNames,
        enabled: true,
      })
    }

    if (allText.includes('faq') || allText.includes('问答') || allText.includes('常见问题')) {
      skills.push({
        type: 'qa',
        name: '知识问答',
        description: '基于知识库回答用户问题',
        promptTemplate: `你是知识顾问，基于知识库回答问题。

原则：
1. 只基于知识库回答，不编造
2. 无相关信息时明确说明
3. 引用来源文件和章节
4. 专业、简洁、准确`,
        rules: [
          { description: '必须引用知识来源', condition: '回答问题时', action: '标注信息来源文件' },
          { description: '不确定时明确告知', condition: '知识库中无相关信息', action: '说明无法回答，不编造' },
        ],
        testCases: [
          { input: '这个产品的保修期是多久？', expectedOutput: '基于知识库给出准确答案并引用来源' },
        ],
        sourceFiles: kbNames,
        enabled: true,
      })
    }

    if (allText.includes('报表') || allText.includes('数据') || allText.includes('统计')) {
      skills.push({
        type: 'query',
        name: '数据分析',
        description: '查询和分析数据，生成统计结果',
        promptTemplate: `你是数据分析师。

步骤：
1. 理解分析需求
2. 确定数据维度
3. 汇总计算
4. 生成分析结果

输出：查询条件、统计结果、关键发现和建议。`,
        rules: [
          { description: '数据必须准确', condition: '涉及数值计算', action: '仔细核对计算过程' },
        ],
        testCases: [
          { input: '统计上个月的销售额', expectedOutput: '包含具体数字的分析报告' },
        ],
        sourceFiles: kbNames,
        enabled: true,
      })
    }

    if (skills.length === 0) {
      skills.push({
        type: 'qa',
        name: '通用问答',
        description: '基于知识库回答各类问题',
        promptTemplate: `基于知识库回答用户问题。

原则：
1. 基于知识库内容
2. 专业、准确
3. 引用来源
4. 不确定时明确说明`,
        rules: [],
        testCases: [
          { input: '请介绍一下相关内容', expectedOutput: '基于知识库的概括性回答' },
        ],
        sourceFiles: kbNames,
        enabled: true,
      })
    }

    return {
      roleName: '数字员工',
      roleDescription: '基于知识库自动创建的数字员工，提供专业知识服务',
      responsibilities: ['回答用户咨询', '处理业务请求', '提供专业建议'],
      suggestedSkills: skills,
      personalityTraits: ['专业', '耐心', '准确'],
      workingStyle: '严谨细致，基于知识库提供专业回答',
      suggestedTools: [],
    }
  }

  private getDefaultProfile(): EmployeeProfile {
    return {
      roleName: '通用数字员工',
      roleDescription: '一个通用的数字员工，可以回答各类问题',
      responsibilities: ['回答用户问题', '提供信息查询'],
      suggestedSkills: [{
        type: 'qa',
        name: '通用问答',
        description: '回答用户的各类问题',
        promptTemplate: '专业、准确地回答用户问题。',
        rules: [],
        testCases: [],
        sourceFiles: [],
        enabled: true,
      }],
      personalityTraits: ['友好', '专业'],
      workingStyle: '友好专业，准确回答',
      suggestedTools: [],
    }
  }
}

export default EmployeeProfilingService
