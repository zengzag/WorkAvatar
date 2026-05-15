import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { getDefaultProviderId } from './common-utils'

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
    return getDefaultProviderId(this.db)
  }

  private async extractWithLLM(text: string, fileName: string, providerId: string, modelId?: string): Promise<ExtractionResult> {
    const maxLength = 8000
    const truncatedText = text.length > maxLength ? text.substring(0, maxLength) + '\n...[内容已截断]' : text

    const prompt = `分析文档并提取结构化信息，JSON格式返回。

文档名称: ${fileName}
文档内容:
${truncatedText}

返回结构:
{
  "rules": [{"ruleId": "r001", "type": "condition_action", "description": "...", "conditions": [{"field": "...", "operator": ">", "value": "..."}], "actions": [{"type": "...", "role": "..."}], "priority": 1, "exceptions": []}],
  "qaPairs": [{"question": "...", "answer": "...", "confidence": 0.95}],
  "templates": [{"name": "...", "description": "...", "content": "...", "variables": []}],
  "knowledge": ["..."],
  "summary": "..."
}

抽取要求:
1. 规则：条件判断类业务规则（如"如果...则..."）
2. 问答对：FAQ格式的问题-答案对
3. 模板：固定格式文本，标注{{变量}}
4. 知识：重要参考知识点
5. 不存在的类型返回空数组

只返回JSON。`

    const response = await this.llmClient.chat(providerId, [
      { role: 'system', content: '从文档中提取结构化规则、问答对和模板，JSON格式输出。' },
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
