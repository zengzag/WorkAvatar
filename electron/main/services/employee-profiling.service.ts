import DatabaseService from './database.service'
import KMSDatabaseService from './kms/kms-database.service'
import LLMClientService from './llm-client.service'
import { getDefaultProviderId } from './common-utils'
import { allBuiltinTools } from './agent/tools'
import { createLogger } from './logger'

const logger = createLogger('EmployeeProfiling')

export interface EmployeeProfile {
  roleName: string
  roleDescription: string
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
  inputSchema?: Record<string, any>
  outputSchema?: Record<string, any>
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

class EmployeeProfilingService {
  private kmsDb: KMSDatabaseService
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: EmployeeProfilingService

  private constructor() {
    this.kmsDb = KMSDatabaseService.getInstance()
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
    collectionIds: string[],
    providerId?: string,
    modelId?: string,
    additionalContext?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; analysisMethod: 'llm' | 'heuristic' | 'default'; error?: string; messages?: Array<{ role: string; content: string }> }> {
    const collectionContents = this.loadCollectionContents(collectionIds)
    const defaultProvider = providerId || this.getDefaultProviderId()

    if (!defaultProvider) {
      if (collectionContents.length > 0) {
        return { profile: this.getHeuristicProfile(collectionContents), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，请先在设置中配置 LLM 提供商' }
      }
      return { profile: this.getDefaultProfile(), analysisMethod: 'default' }
    }

    try {
      onProgress?.({ stage: 'preparing', detail: collectionContents.length > 0 ? `准备分析 ${collectionContents.length} 个合集...` : '准备分析业务描述...' })
      const { profile, messages } = await this.analyzeWithLLM(collectionContents, defaultProvider, modelId, additionalContext, onProgress)
      onProgress?.({ stage: 'done', detail: '分析完成' })
      return { profile, analysisMethod: 'llm', messages }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      logger.error('LLM profiling failed, falling back to heuristic:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      if (collectionContents.length > 0) {
        return { profile: this.getHeuristicProfile(collectionContents), analysisMethod: 'heuristic', error: `LLM 调用失败: ${errorMsg}` }
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
        suggestedTools: previousProfile.suggestedTools,
      }, null, 2)

      const refinePrompt = `基于以下分析结果和用户反馈进行调整，JSON格式输出。

当前结果：
\`\`\`json
${profileJson}
\`\`\`

用户反馈：
${feedback}

可用的系统工具列表（suggestedTools 必须从以下列表中选取，使用 name 字段的值）：
${this.getSystemToolsList().map(t => `- ${t.name}：${t.title}`).join('\n')}

输出字段（只输出JSON）：
- roleName: 角色名称
- roleDescription: 角色描述（包含职责、注意事项和工作流程等完整描述）
- suggestedTools: 建议启用的工具名称列表，必须从上述工具列表的 name 字段中选取`

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
        { temperature: 0.2, max_tokens: 8192, ...(modelId ? { model: modelId } : {}), logSource: 'profiling_refine' },
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
    const db = this.kmsDb.getDb()

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

      // 合集摘要（全局摘要）
      const collectionSummary = db.prepare('SELECT * FROM kms_collection_summaries WHERE collection_id = ?').get(collectionId) as any
      if (collectionSummary) {
        content.globalSummary = collectionSummary.summary || ''
        try { content.keyTopics = JSON.parse(collectionSummary.key_topics_json || '[]') } catch {}
      }

      // 文件摘要（通过 kms_file_collections 关联合集中的文件）
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
        try { docSummary.mainTopics = JSON.parse(fs.main_topics_json || '[]') } catch {}
        content.documentSummaries.push(docSummary)
      }

      // 段落样本（通过 kms_file_collections 关联合集中的文件段落）
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
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; messages: Array<{ role: string; content: string }> }> {
    const hasCollection = collectionContents.length > 0
    const combinedText = hasCollection ? this.buildCombinedCollectionDocument(collectionContents) : ''
    const maxLength = 12000
    const truncatedText = combinedText.length > maxLength
      ? combinedText.substring(0, maxLength) + '\n...[内容已截断，共' + combinedText.length + '字符]'
      : combinedText

    const userGuidance = additionalContext
      ? `\n\n## 用户补充说明\n${additionalContext}\n\n请在设计数字员工角色时，优先考虑以上用户的补充说明和期望。`
      : ''

    const allTools = this.getSystemToolsList()
    const toolsListText = allTools.map(t => `- ${t.name}：${t.title}（${t.description}）`).join('\n')

    let prompt: string
    if (hasCollection) {
      prompt = `分析资料库合集内容，设计数字员工角色，JSON格式输出。

资料库合集资料：
${truncatedText}${userGuidance}

分析要求：
1. 分析合集中的业务领域、文档类型和核心主题，确定该合集的业务场景
2. 根据业务场景确定数字员工的角色定位（根据实际分析结果给出恰当的员工角色名称）
3. 基于合集内容推导员工应承担的职责（如解答相关咨询、处理对应业务请求等）
4. 根据业务特性确定工作流程和注意事项

可用的系统工具列表（suggestedTools 必须从以下列表中选取，使用 name 字段的值）：
${toolsListText}

输出字段（只输出JSON）：
- roleName: 角色名称（简洁明了）
- roleDescription: 角色描述（需融合职责说明、注意事项和工作流程）
- suggestedTools: 建议启用的工具名称列表，必须从上述工具列表的 name 字段中选取（如"read_file"、"calculator"等）`
    } else {
      prompt = `根据业务描述设计数字员工角色，JSON格式输出。

${userGuidance}

分析要求：
1. 分析业务描述中的领域信息、业务类型和工作内容，确定业务场景
2. 根据业务场景确定数字员工的角色定位（根据实际分析结果给出恰当的员工角色名称）
3. 基于业务描述推导员工应承担的职责
4. 根据业务特性确定工作流程和注意事项

可用的系统工具列表（suggestedTools 必须从以下列表中选取，使用 name 字段的值）：
${toolsListText}

输出字段（只输出JSON）：
- roleName: 角色名称（简洁明了）
- roleDescription: 角色描述（需融合职责说明、注意事项和工作流程）
- suggestedTools: 建议启用的工具名称列表，必须从上述工具列表的 name 字段中选取（如"read_file"、"calculator"等）`
    }

    onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 进行智能分析...' })

    const llmMessages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: '根据资料库合集内容或业务描述分析设计数字员工角色，输出JSON格式结果。suggestedTools 必须从提供的工具列表中选取。'
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
      { temperature: 0.2, max_tokens: 8192, ...(modelId ? { model: modelId } : {}), logSource: 'profiling_analyze' },
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
      roleDescription: result.roleDescription || (hasCollection ? '基于资料库合集自动创建的数字员工' : '基于业务描述自动创建的数字员工'),
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

  private buildCombinedCollectionDocument(collectionContents: CollectionContent[]): string {
    const parts: string[] = []

    for (const col of collectionContents) {
      parts.push(`\n=== 合集: ${col.collectionName} ===`)
      if (col.collectionDescription) {
        parts.push(`描述: ${col.collectionDescription}`)
      }

      if (col.globalSummary) {
        parts.push(`\n[全局摘要]\n${col.globalSummary}`)
      }

      if (col.keyTopics.length > 0) {
        parts.push(`\n[核心主题] ${col.keyTopics.join(', ')}`)
      }

      if (col.documentSummaries.length > 0) {
        parts.push('\n[文档摘要]')
        for (const doc of col.documentSummaries) {
          parts.push(`\n--- 文档: ${doc.docName} ---`)
          if (doc.summary) parts.push(doc.summary)
          if (doc.mainTopics.length > 0) parts.push(`主题: ${doc.mainTopics.join(', ')}`)
        }
      }

      if (col.paragraphSamples.length > 0) {
        parts.push('\n[段落内容示例]')
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
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    if (allText.includes('faq') || allText.includes('问答') || allText.includes('常见问题')) {
      skills.push({
        type: 'qa',
        name: '知识问答',
        description: '基于资料库合集回答用户问题',
        promptTemplate: `你是知识顾问，基于资料库合集回答问题。

原则：
1. 只基于资料库回答，不编造
2. 无相关信息时明确说明
3. 引用来源文件和段落
4. 专业、简洁、准确`,
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
        sourceFiles: collectionNames,
        enabled: true,
      })
    }

    if (skills.length === 0) {
      skills.push({
        type: 'qa',
        name: '通用问答',
        description: '基于资料库合集回答各类问题',
        promptTemplate: `基于资料库合集回答用户问题。

原则：
1. 基于资料库内容
2. 专业、准确
3. 引用来源
4. 不确定时明确说明`,
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
      suggestedSkills: skills,
      suggestedTools: [],
    }
  }

  private getDefaultProfile(): EmployeeProfile {
    return {
      roleName: '通用数字员工',
      roleDescription: '一个通用的数字员工，可以回答各类问题和提供信息查询。友好专业，准确回答用户问题。',
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
      suggestedTools: [],
    }
  }
}

export default EmployeeProfilingService
