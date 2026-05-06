import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'

interface TestCase {
  id: string
  input: string
  expectedOutput: string
  skillType: string
}

interface TestResult {
  testCaseId: string
  input: string
  expectedOutput: string
  actualOutput: string
  matchStatus: 'exact' | 'partial' | 'mismatch'
  similarity: number
  passed: boolean
  executionTime: number
}

interface SandboxTestReport {
  totalTests: number
  passedTests: number
  failedTests: number
  overallScore: number
  results: TestResult[]
  summary: string
}

class SandboxTesterService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: SandboxTesterService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): SandboxTesterService {
    if (!SandboxTesterService.instance) {
      SandboxTesterService.instance = new SandboxTesterService()
    }
    return SandboxTesterService.instance
  }

  async runSkillTests(skillId: string, providerId?: string, modelId?: string): Promise<SandboxTestReport> {
    const skill = this.db.getDb().prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`)
    }

    const testCases = this.parseTestCases(skill.test_cases_json)
    if (testCases.length === 0) {
      return {
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        overallScore: 0,
        results: [],
        summary: '该技能没有配置测试用例',
      }
    }

    const defaultProvider = providerId || this.getDefaultProviderId()
    if (!defaultProvider) {
      throw new Error('No LLM provider configured')
    }

    const results: TestResult[] = []
    let passedCount = 0

    for (const testCase of testCases) {
      const result = await this.runSingleTest(skill, testCase, defaultProvider, modelId)
      results.push(result)
      if (result.passed) {
        passedCount++
      }
    }

    const overallScore = testCases.length > 0 ? (passedCount / testCases.length) * 100 : 0

    return {
      totalTests: testCases.length,
      passedTests: passedCount,
      failedTests: testCases.length - passedCount,
      overallScore,
      results,
      summary: `测试完成: ${passedCount}/${testCases.length} 通过, 得分 ${overallScore.toFixed(1)}%`,
    }
  }

  async runEmployeeTests(employeeId: string, providerId?: string, modelId?: string): Promise<{
    employeeName: string
    skillReports: Array<{ skillId: string; skillName: string; report: SandboxTestReport }>
    overallScore: number
  }> {
    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
    if (!employee) {
      throw new Error(`Employee ${employeeId} not found`)
    }

    const skills = this.db.getDb().prepare(
      'SELECT * FROM skills WHERE employee_id = ? AND is_enabled = 1'
    ).all(employeeId) as any[]

    const skillReports: Array<{ skillId: string; skillName: string; report: SandboxTestReport }> = []
    let totalScore = 0
    let totalTests = 0

    for (const skill of skills) {
      try {
        const report = await this.runSkillTests(skill.id, providerId, modelId)
        skillReports.push({
          skillId: skill.id,
          skillName: skill.name,
          report,
        })
        totalScore += report.overallScore * report.totalTests
        totalTests += report.totalTests
      } catch (error) {
        console.error(`Failed to test skill ${skill.id}:`, error)
      }
    }

    const overallScore = totalTests > 0 ? totalScore / totalTests : 0

    return {
      employeeName: employee.name,
      skillReports,
      overallScore,
    }
  }

  private async runSingleTest(
    skill: any,
    testCase: TestCase,
    providerId: string,
    modelId?: string
  ): Promise<TestResult> {
    const startTime = Date.now()

    const prompt = this.buildTestPrompt(skill, testCase.input)

    try {
      const actualOutput = await this.llmClient.chat(providerId, [
        { role: 'system', content: skill.prompt_template || '你是一个智能助手。' },
        { role: 'user', content: prompt },
      ], { temperature: 0.3, max_tokens: 2048, ...(modelId ? { model: modelId } : {}) })

      const executionTime = Date.now() - startTime
      const similarity = this.calculateSimilarity(actualOutput, testCase.expectedOutput)
      const matchStatus = this.determineMatchStatus(similarity)
      const passed = matchStatus !== 'mismatch'

      return {
        testCaseId: testCase.id,
        input: testCase.input,
        expectedOutput: testCase.expectedOutput,
        actualOutput,
        matchStatus,
        similarity,
        passed,
        executionTime,
      }
    } catch (error) {
      const executionTime = Date.now() - startTime
      return {
        testCaseId: testCase.id,
        input: testCase.input,
        expectedOutput: testCase.expectedOutput,
        actualOutput: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        matchStatus: 'mismatch',
        similarity: 0,
        passed: false,
        executionTime,
      }
    }
  }

  private buildTestPrompt(skill: any, input: string): string {
    const rules = this.parseRules(skill.rules_json)
    const rulesText = rules.length > 0
      ? '规则:\n' + rules.map((r: any) => `- ${r.description}`).join('\n')
      : ''

    return `${rulesText}\n\n输入:\n${input}\n\n请根据以上规则和输入给出输出。`
  }

  private parseTestCases(testCasesJson: string): TestCase[] {
    try {
      const parsed = JSON.parse(testCasesJson || '[]')
      if (Array.isArray(parsed)) {
        return parsed.map((tc: any, idx: number) => ({
          id: tc.id || `tc_${idx}`,
          input: tc.input || tc.question || '',
          expectedOutput: tc.expectedOutput || tc.answer || tc.expected || '',
          skillType: tc.skillType || 'general',
        }))
      }
    } catch {
    }
    return []
  }

  private parseRules(rulesJson: string): any[] {
    try {
      const parsed = JSON.parse(rulesJson || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  private calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase().trim()
    const s2 = str2.toLowerCase().trim()

    if (s1 === s2) return 1.0
    if (s1.length === 0 || s2.length === 0) return 0.0

    const longer = s1.length > s2.length ? s1 : s2
    const shorter = s1.length > s2.length ? s2 : s1

    if (longer.includes(shorter)) {
      return shorter.length / longer.length
    }

    const distance = this.levenshteinDistance(s1, s2)
    return Math.max(0, 1 - distance / Math.max(s1.length, s2.length))
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = []

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i]
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1]
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          )
        }
      }
    }

    return matrix[str2.length][str1.length]
  }

  private determineMatchStatus(similarity: number): 'exact' | 'partial' | 'mismatch' {
    if (similarity >= 0.95) return 'exact'
    if (similarity >= 0.7) return 'partial'
    return 'mismatch'
  }

  private getDefaultProviderId(): string | null {
    const row = this.db.getDb().prepare(
      'SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1'
    ).get() as any
    return row?.id || null
  }

  generateTestCasesFromRules(skillId: string): TestCase[] {
    const skill = this.db.getDb().prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any
    if (!skill) return []

    const rules = this.parseRules(skill.rules_json)
    const testCases: TestCase[] = []

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]
      if (rule.conditions && rule.conditions.length > 0) {
        const condition = rule.conditions[0]
        testCases.push({
          id: `auto_${i}_positive`,
          input: `测试条件: ${condition.field} ${condition.operator} ${condition.value}`,
          expectedOutput: rule.actions?.[0]?.type || 'pass',
          skillType: skill.type,
        })

        testCases.push({
          id: `auto_${i}_negative`,
          input: `测试条件: ${condition.field} 不满足 ${condition.operator} ${condition.value}`,
          expectedOutput: 'reject',
          skillType: skill.type,
        })
      }
    }

    return testCases
  }
}

export default SandboxTesterService
