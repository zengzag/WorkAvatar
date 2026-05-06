import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'

interface ExtractedRule {
  ruleId: string
  type: string
  description: string
  conditions: Array<{
    field: string
    operator: string
    value: any
  }>
  actions: Array<{
    type: string
    role?: string
    value?: any
  }>
  priority: number
  exceptions?: string[]
  source?: {
    file: string
    page?: number
    line?: number
  }
}

interface ExtractedQAPair {
  question: string
  answer: string
  confidence: number
}

interface ExtractedTemplate {
  name: string
  description: string
  content: string
  variables: string[]
}

interface ExtractionResult {
  rules: ExtractedRule[]
  qaPairs: ExtractedQAPair[]
  templates: ExtractedTemplate[]
  knowledge: string[]
  summary: string
}

class RuleExtractionService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: RuleExtractionService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): RuleExtractionService {
    if (!RuleExtractionService.instance) {
      RuleExtractionService.instance = new RuleExtractionService()
    }
    return RuleExtractionService.instance
  }

  async extractFromFile(fileId: string, providerId?: string, modelId?: string): Promise<ExtractionResult> {
    const file = this.db.getDb().prepare('SELECT * FROM files WHERE id = ?').get(fileId) as any
    if (!file) {
      throw new Error(`File ${fileId} not found`)
    }

    if (file.status !== 'completed' || !file.parsed_json) {
      throw new Error(`File ${fileId} is not parsed yet`)
    }

    const parsedResult = JSON.parse(file.parsed_json)
    const text = parsedResult.fullText || ''

    if (!text.trim()) {
      return {
        rules: [],
        qaPairs: [],
        templates: [],
        knowledge: [],
        summary: '',
      }
    }

    const defaultProvider = providerId || this.getDefaultProviderId()
    if (!defaultProvider) {
      return this.extractWithHeuristics(text, file.original_name)
    }

    try {
      return await this.extractWithLLM(text, file.original_name, defaultProvider, modelId)
    } catch {
      return this.extractWithHeuristics(text, file.original_name)
    }
  }

  private getDefaultProviderId(): string | null {
    const row = this.db.getDb().prepare(
      'SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1'
    ).get() as any
    return row?.id || null
  }

  private async extractWithLLM(text: string, fileName: string, providerId: string, modelId?: string): Promise<ExtractionResult> {
    const maxLength = 8000
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '\n...[内容已截断]' : text

    const prompt = '你是一位专业的业务规则抽取专家。请仔细分析以下文档内容，从中提取结构化信息。\n\n' +
      `文档名称: ${fileName}\n\n` +
      `文档内容:\n${truncatedText}\n\n` +
      '请严格按照以下 JSON 格式输出抽取结果（只输出 JSON，不要其他解释）:\n\n' +
      '{\n' +
      '  "rules": [\n' +
      '    {\n' +
      '      "ruleId": "r001",\n' +
      '      "type": "condition_action",\n' +
      '      "description": "规则的自然语言描述",\n' +
      '      "conditions": [\n' +
      '        { "field": "字段名", "operator": ">", "value": "值" }\n' +
      '      ],\n' +
      '      "actions": [\n' +
      '        { "type": "require_approval", "role": "审批角色" }\n' +
      '      ],\n' +
      '      "priority": 1,\n' +
      '      "exceptions": ["例外情况1"]\n' +
      '    }\n' +
      '  ],\n' +
      '  "qaPairs": [\n' +
      '    {\n' +
      '      "question": "问题",\n' +
      '      "answer": "答案",\n' +
      '      "confidence": 0.95\n' +
      '    }\n' +
      '  ],\n' +
      '  "templates": [\n' +
      '    {\n' +
      '      "name": "模板名称",\n' +
      '      "description": "模板描述",\n' +
      '      "content": "模板内容，包含 {{变量}}",\n' +
      '      "variables": ["变量1", "变量2"]\n' +
      '    }\n' +
      '  ],\n' +
      '  "knowledge": ["知识片段1", "知识片段2"],\n' +
      '  "summary": "文档整体摘要"\n' +
      '}\n\n' +
      '抽取要求:\n' +
      '1. 规则：提取所有条件判断类的业务规则，如"如果...则..."、"超过X需要..."等\n' +
      '2. 问答对：从FAQ格式的内容中提取问题-答案对\n' +
      '3. 模板：识别文档中的固定格式文本，标注变量占位符\n' +
      '4. 知识：提取重要的参考知识点\n' +
      '5. 如果某类信息不存在，返回空数组'

    const response = await this.llmClient.chat(providerId, [
      { role: 'system', content: '你是一个专业的业务规则抽取助手，擅长从文档中提取结构化规则、问答对和模板。' },
      { role: 'user', content: prompt },
    ], { temperature: 0.1, max_tokens: 4096, ...(modelId ? { model: modelId } : {}) })

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        throw new Error('No JSON found in LLM response')
      }
      const result = JSON.parse(jsonMatch[0])

      return {
        rules: Array.isArray(result.rules) ? result.rules : [],
        qaPairs: Array.isArray(result.qaPairs) ? result.qaPairs : [],
        templates: Array.isArray(result.templates) ? result.templates : [],
        knowledge: Array.isArray(result.knowledge) ? result.knowledge : [],
        summary: result.summary || '',
      }
    } catch {
      return this.extractWithHeuristics(text, fileName)
    }
  }

  private extractWithHeuristics(text: string, fileName: string): ExtractionResult {
    const rules: ExtractedRule[] = []
    const qaPairs: ExtractedQAPair[] = []
    const templates: ExtractedTemplate[] = []
    const knowledge: string[] = []

    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const rulePatterns = [
        /(.+?)(?:必须|应当|应该|需要|要求)(.+)/,
        /(?:如果|若|当)(.+?)(?:则|就|那么|应当|必须)(.+)/,
        /(.+?)(?:不得|禁止|不能|不允许)(.+)/,
        /(.+?)(?:超过|大于|小于|等于|不少于|不超过)(.+?)(?:时|则|需要|必须)(.+)/,
      ]

      for (const pattern of rulePatterns) {
        const match = line.match(pattern)
        if (match) {
          const conditions: ExtractedRule['conditions'] = []
          const actions: ExtractedRule['actions'] = []

          if (match[1] && match[2]) {
            const thresholdMatch = match[1].match(/(\d+(?:\.\d+)?)/)
            if (thresholdMatch) {
              conditions.push({
                field: match[1].replace(thresholdMatch[0], '').trim() || '金额',
                operator: '>',
                value: thresholdMatch[0],
              })
            } else {
              conditions.push({
                field: '条件',
                operator: 'contains',
                value: match[1].trim(),
              })
            }

            if (match[3] && match[3].includes('审批')) {
              actions.push({ type: 'require_approval', role: '审批人' })
            } else if (line.includes('驳回') || line.includes('拒绝')) {
              actions.push({ type: 'reject' })
            } else {
              actions.push({ type: 'flag' })
            }
          }

          rules.push({
            ruleId: `r${String(rules.length + 1).padStart(3, '0')}`,
            type: 'condition_action',
            description: line,
            conditions,
            actions,
            priority: rules.length,
          })
          break
        }
      }

      const qaPattern = /^(?:Q|问题|问)[：:]\s*(.+?)\s*(?:A|答案|答)[：:]\s*(.+)$/i
      const qaMatch = line.match(qaPattern)
      if (qaMatch) {
        qaPairs.push({
          question: qaMatch[1].trim(),
          answer: qaMatch[2].trim(),
          confidence: 0.8,
        })
      }

      if (line.includes('{{') && line.includes('}}')) {
        const varMatches = line.match(/\{\{(\w+)\}\}/g)
        if (varMatches) {
          templates.push({
            name: `模板 ${templates.length + 1}`,
            description: '从文档中提取的模板',
            content: line,
            variables: varMatches.map((v) => v.replace(/\{\{|\}\}/g, '')),
          })
        }
      }
    }

    const paragraphs = text.split(/\n{2,}/)
    for (const para of paragraphs.slice(0, 5)) {
      const trimmed = para.trim()
      if (trimmed.length > 50 && trimmed.length < 500) {
        knowledge.push(trimmed)
      }
    }

    return {
      rules,
      qaPairs,
      templates,
      knowledge,
      summary: `从 ${fileName} 中提取了 ${rules.length} 条规则，${qaPairs.length} 个问答对，${templates.length} 个模板`,
    }
  }

  async extractFromProject(projectId: string, providerId?: string, modelId?: string): Promise<{
    totalRules: number
    totalQAPairs: number
    totalTemplates: number
    fileResults: Array<{ fileId: string; fileName: string; result: ExtractionResult }>
  }> {
    const files = this.db.getDb().prepare(
      'SELECT * FROM files WHERE project_id = ? AND status = ?'
    ).all(projectId, 'completed') as any[]

    const fileResults: Array<{ fileId: string; fileName: string; result: ExtractionResult }> = []
    let totalRules = 0
    let totalQAPairs = 0
    let totalTemplates = 0

    for (const file of files) {
      try {
        const result = await this.extractFromFile(file.id, providerId, modelId)
        fileResults.push({
          fileId: file.id,
          fileName: file.original_name,
          result,
        })
        totalRules += result.rules.length
        totalQAPairs += result.qaPairs.length
        totalTemplates += result.templates.length

        this.db.getDb().prepare(
          'UPDATE files SET rule_count = ?, qa_count = ? WHERE id = ?'
        ).run(result.rules.length, result.qaPairs.length, file.id)
      } catch (error) {
        console.error(`Failed to extract rules from file ${file.id}:`, error)
      }
    }

    return {
      totalRules,
      totalQAPairs,
      totalTemplates,
      fileResults,
    }
  }
}

export default RuleExtractionService
