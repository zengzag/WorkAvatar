import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'

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

interface FileContent {
  fileId: string
  fileName: string
  type: string
  content: string
  sections: Array<{
    title: string
    content: string
    level: number
  }>
}

class EmployeeProfilingService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: EmployeeProfilingService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): EmployeeProfilingService {
    if (!EmployeeProfilingService.instance) {
      EmployeeProfilingService.instance = new EmployeeProfilingService()
    }
    return EmployeeProfilingService.instance
  }

  async analyzeProjectForEmployee(
    _projectId: string,
    selectedFileIds: string[],
    providerId?: string,
    modelId?: string,
    additionalContext?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<{ profile: EmployeeProfile; analysisMethod: 'llm' | 'heuristic' | 'default'; error?: string }> {
    const files = this.loadFileContents(selectedFileIds)
    if (files.length === 0) {
      return { profile: this.getDefaultProfile(), analysisMethod: 'default' }
    }

    const defaultProvider = providerId || this.getDefaultProviderId()
    if (!defaultProvider) {
      return { profile: this.getHeuristicProfile(files), analysisMethod: 'heuristic', error: '未配置 LLM 提供商，请先在设置中配置 LLM 提供商' }
    }

    try {
      onProgress?.({ stage: 'preparing', detail: `准备分析 ${files.length} 个文件...` })
      const profile = await this.analyzeWithLLM(files, defaultProvider, modelId, additionalContext, onProgress)
      onProgress?.({ stage: 'done', detail: '分析完成' })
      return { profile, analysisMethod: 'llm' }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'LLM 调用失败'
      console.error('LLM profiling failed, falling back to heuristic:', error)
      onProgress?.({ stage: 'error', detail: `LLM 调用失败: ${errorMsg}` })
      return { profile: this.getHeuristicProfile(files), analysisMethod: 'heuristic', error: `LLM 调用失败: ${errorMsg}` }
    }
  }

  private loadFileContents(fileIds: string[]): FileContent[] {
    const files: FileContent[] = []

    for (const fileId of fileIds) {
      const file = this.db.getDb().prepare('SELECT * FROM files WHERE id = ?').get(fileId) as any
      if (!file || !file.parsed_json) continue

      try {
        const parsed = JSON.parse(file.parsed_json)
        files.push({
          fileId: file.id,
          fileName: file.original_name,
          type: file.type,
          content: parsed.fullText || '',
          sections: parsed.sections || [],
        })
      } catch {
        // Skip malformed parsed_json
      }
    }

    return files
  }

  private getDefaultProviderId(): string | null {
    const defaultRow = this.db.getDb().prepare(
      'SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1'
    ).get() as any
    if (defaultRow?.id) {
      return defaultRow.id
    }
    const anyRow = this.db.getDb().prepare(
      'SELECT id FROM llm_providers LIMIT 1'
    ).get() as any
    return anyRow?.id || null
  }

  private async analyzeWithLLM(
    files: FileContent[],
    providerId: string,
    modelId?: string,
    additionalContext?: string,
    onProgress?: (data: { stage: string; detail?: string; chunk?: string }) => void
  ): Promise<EmployeeProfile> {
    const combinedText = this.buildCombinedDocument(files)
    const maxLength = 12000
    const truncatedText = combinedText.length > maxLength
      ? combinedText.substring(0, maxLength) + '\n...[内容已截断，共' + combinedText.length + '字符]'
      : combinedText

    const userGuidance = additionalContext
      ? `\n\n## 用户补充说明\n${additionalContext}\n\n请在设计数字员工角色时，优先考虑以上用户的补充说明和期望。`
      : ''

    const prompt = `你是一位资深的人力资源专家和业务架构师。请仔细分析以下文档资料，理解其业务场景，然后设计一个合适的"数字员工"角色。

## 文档资料
${truncatedText}${userGuidance}

## 分析要求

请从以下维度进行深入分析：

1. **业务场景理解**：这些文档描述的是什么业务领域？涉及哪些工作流程？
2. **角色定位**：基于文档内容，应该创建一个什么角色的数字员工？（如"合同审核专员"、"客服顾问"、"数据分析师"等）
3. **职责识别**：这个员工应该承担哪些具体职责？
4. **工作风格**：这个员工应该以什么风格与用户交互？（严谨型、亲和型、高效型等）
5. **工具需求**：这个员工可能需要使用什么工具？（如计算器、文件搜索、数据查询等）

## 输出格式

请严格按照以下JSON格式输出（只输出JSON，不要其他解释）：

{\n"roleName": "角色名称，如'合同审核专员'",\n"roleDescription": "角色的详细描述，100字左右",\n"responsibilities": ["职责1", "职责2", "职责3"],\n"personalityTraits": ["特质1", "特质2"],\n"workingStyle": "工作风格描述，如'严谨细致，注重合规性'",\n"suggestedTools": ["tool_name_1", "tool_name_2"]\n}\n\n要求：\n1. roleName 要专业且贴合业务场景\n2. 如果某类信息不存在，返回空数组或默认值`

    onProgress?.({ stage: 'llm_calling', detail: '正在调用 LLM 进行智能分析...' })

    let fullResponse = ''
    let thinkContent = ''
    let streamDone = false
    let streamError: Error | null = null

    await this.llmClient.chatStream(
      providerId,
      [
        {
          role: 'system',
          content: '你是一位资深的人力资源专家和业务架构师，擅长根据业务文档设计数字员工角色和能力体系。'
        },
        { role: 'user', content: prompt },
      ],
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
        thinkContent += thoughtChunk
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

    const result = JSON.parse(cleaned)

    return {
      roleName: result.roleName || '数字员工',
      roleDescription: result.roleDescription || '基于文档资料自动创建的数字员工',
      responsibilities: Array.isArray(result.responsibilities) ? result.responsibilities : [],
      suggestedSkills: this.normalizeSkills(result.suggestedSkills, files),
      personalityTraits: Array.isArray(result.personalityTraits) ? result.personalityTraits : ['专业', '高效'],
      workingStyle: result.workingStyle || '专业严谨',
      suggestedTools: Array.isArray(result.suggestedTools) ? result.suggestedTools : [],
    }
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

  private buildCombinedDocument(files: FileContent[]): string {
    const parts: string[] = []

    for (const file of files) {
      parts.push(`\n=== 文件: ${file.fileName} (类型: ${file.type}) ===`)

      if (file.sections.length > 0) {
        for (const section of file.sections) {
          const indent = '  '.repeat(Math.max(0, section.level - 1))
          parts.push(`${indent}[${section.title}]`)
          parts.push(`${indent}${section.content.substring(0, 800)}`)
        }
      } else {
        parts.push(file.content.substring(0, 2000))
      }
    }

    return parts.join('\n')
  }

  private normalizeSkills(rawSkills: any[], files: FileContent[]): SuggestedSkill[] {
    if (!Array.isArray(rawSkills)) return []

    const fileNames = files.map((f) => f.fileName)

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
        : fileNames,
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
    return `你是专业的数字员工，擅长【${skillName}】。

## 能力描述
${description || '根据用户需求提供专业服务'}

## 工作原则
1. 仔细分析用户输入，理解真实需求
2. 基于专业知识和规则进行处理
3. 输出结果要准确、完整、有条理
4. 如有不确定之处，明确说明

## 输出格式
请根据具体任务类型，提供结构化、专业的输出。`
  }

  private getHeuristicProfile(files: FileContent[]): EmployeeProfile {
    const fileNames = files.map((f) => f.fileName)
    const allText = files.map((f) => f.content).join(' ').toLowerCase()

    const skills: SuggestedSkill[] = []

    if (allText.includes('合同') || allText.includes('协议') || allText.includes('条款')) {
      skills.push({
        type: 'extraction',
        name: '合同审核',
        description: '审核合同条款，识别风险点和缺失项',
        promptTemplate: `你是专业的合同审核专员。

## 审核要点
1. 检查合同主体信息完整性
2. 审核付款条款是否合理
3. 识别违约责任和争议解决条款
4. 检查保密条款和知识产权归属
5. 标注风险等级（高/中/低）

## 输出格式
对每份合同输出：
- 基本信息摘要
- 风险点列表（含等级和建议）
- 缺失条款提醒
- 总体评估意见`,
        rules: [
          { description: '付款条款必须明确金额、时间和方式', condition: '遇到付款相关条款', action: '详细审核并标注风险' },
          { description: '违约责任必须对等', condition: '遇到违约责任条款', action: '检查双方责任是否平衡' },
        ],
        testCases: [
          { input: '请审核这份采购合同', expectedOutput: '包含风险点列表和评估意见的审核报告' },
        ],
        sourceFiles: fileNames,
        enabled: true,
      })
    }

    if (allText.includes('faq') || allText.includes('问答') || allText.includes('常见问题')) {
      skills.push({
        type: 'qa',
        name: '知识问答',
        description: '基于知识库回答用户问题',
        promptTemplate: `你是专业的知识顾问。请基于以下知识库回答用户问题。

## 回答原则
1. 只基于提供的知识库回答，不编造信息
2. 如果知识库中没有相关信息，明确说明
3. 引用来源文件和具体章节
4. 保持专业、简洁、准确`,
        rules: [
          { description: '必须引用知识来源', condition: '回答问题时', action: '标注信息来源文件' },
          { description: '不确定时明确告知', condition: '知识库中无相关信息', action: '说明无法回答，不编造' },
        ],
        testCases: [
          { input: '这个产品的保修期是多久？', expectedOutput: '基于知识库给出准确答案并引用来源' },
        ],
        sourceFiles: fileNames,
        enabled: true,
      })
    }

    if (allText.includes('报表') || allText.includes('数据') || allText.includes('统计')) {
      skills.push({
        type: 'query',
        name: '数据分析',
        description: '查询和分析数据，生成统计结果',
        promptTemplate: `你是数据分析师。请根据用户请求查询和分析数据。

## 工作步骤
1. 理解用户的分析需求
2. 确定需要查询的数据维度
3. 进行数据汇总和计算
4. 生成清晰的分析结果

## 输出格式
- 查询条件说明
- 数据统计结果
- 关键发现和建议`,
        rules: [
          { description: '数据必须准确', condition: '涉及数值计算', action: '仔细核对计算过程' },
        ],
        testCases: [
          { input: '统计上个月的销售额', expectedOutput: '包含具体数字的分析报告' },
        ],
        sourceFiles: fileNames,
        enabled: true,
      })
    }

    if (skills.length === 0) {
      skills.push({
        type: 'qa',
        name: '通用问答',
        description: '基于上传的资料回答各类问题',
        promptTemplate: `你是专业的数字员工助手。请基于提供的资料回答用户问题。

## 回答原则
1. 基于资料内容回答
2. 保持专业、准确
3. 引用来源信息
4. 不确定时明确说明`,
        rules: [],
        testCases: [
          { input: '请介绍一下相关内容', expectedOutput: '基于资料的概括性回答' },
        ],
        sourceFiles: fileNames,
        enabled: true,
      })
    }

    return {
      roleName: '数字员工',
      roleDescription: '基于项目资料自动创建的数字员工，提供专业知识服务',
      responsibilities: ['回答用户咨询', '处理业务请求', '提供专业建议'],
      suggestedSkills: skills,
      personalityTraits: ['专业', '耐心', '准确'],
      workingStyle: '严谨细致，基于资料提供专业回答',
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
        promptTemplate: '你是智能助手，请专业、准确地回答用户问题。',
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
