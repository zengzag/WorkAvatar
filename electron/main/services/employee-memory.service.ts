import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('Memory')

export interface EmployeeMemory {
  id: string
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned: number
  source: 'auto' | 'manual'
  created_at: number
  updated_at: number
}

export interface MemoryCreateParams {
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned?: boolean
  source?: 'auto' | 'manual'
}

export interface MemoryUpdateParams {
  key?: string
  topic?: string
  content?: string
  is_pinned?: boolean
}

interface ExtractedMemory {
  key: string
  topic: string
  content: string
}

class EmployeeMemoryService {
  private db: DatabaseService
  private llmClient: LLMClientService
  private static instance: EmployeeMemoryService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llmClient = LLMClientService.getInstance()
  }

  static getInstance(): EmployeeMemoryService {
    if (!EmployeeMemoryService.instance) {
      EmployeeMemoryService.instance = new EmployeeMemoryService()
    }
    return EmployeeMemoryService.instance
  }

  listMemories(employeeId: string): EmployeeMemory[] {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? ORDER BY is_pinned DESC, updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]
  }

  getMemory(id: string): EmployeeMemory | undefined {
    return this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE id = ?'
    ).get(id) as EmployeeMemory | undefined
  }

  createMemory(params: MemoryCreateParams): EmployeeMemory {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(
      `INSERT INTO employee_memories (id, employee_id, key, topic, content, is_pinned, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      params.employee_id,
      params.key,
      params.topic,
      params.content,
      params.is_pinned ? 1 : 0,
      params.source || 'manual',
      now,
      now
    )
    return this.getMemory(id)!
  }

  updateMemory(id: string, params: MemoryUpdateParams): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing) return undefined

    const sets: string[] = []
    const values: any[] = []

    if (params.key !== undefined) { sets.push('key = ?'); values.push(params.key) }
    if (params.topic !== undefined) { sets.push('topic = ?'); values.push(params.topic) }
    if (params.content !== undefined) { sets.push('content = ?'); values.push(params.content) }
    if (params.is_pinned !== undefined) { sets.push('is_pinned = ?'); values.push(params.is_pinned ? 1 : 0) }

    if (sets.length === 0) return existing

    sets.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(id)

    this.db.getDb().prepare(
      `UPDATE employee_memories SET ${sets.join(', ')} WHERE id = ?`
    ).run(...values)

    return this.getMemory(id)
  }

  deleteMemory(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employee_memories WHERE id = ?').run(id)
    return result.changes > 0
  }

  togglePin(id: string): EmployeeMemory | undefined {
    const existing = this.getMemory(id)
    if (!existing) return undefined
    const newPinned = existing.is_pinned ? 0 : 1
    this.db.getDb().prepare(
      'UPDATE employee_memories SET is_pinned = ?, updated_at = ? WHERE id = ?'
    ).run(newPinned, Math.floor(Date.now() / 1000), id)
    return this.getMemory(id)
  }

  searchMemories(employeeId: string, query: string, limit: number = 10): EmployeeMemory[] {
    const pinned = this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? AND is_pinned = 1 ORDER BY updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]

    const searchResults = this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND (key LIKE ? OR topic LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`
    ).all(
      employeeId,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit
    ) as EmployeeMemory[]

    return [...pinned, ...searchResults]
  }

  getRelevantMemories(employeeId: string, query: string, limit: number = 5): EmployeeMemory[] {
    const pinned = this.db.getDb().prepare(
      'SELECT * FROM employee_memories WHERE employee_id = ? AND is_pinned = 1 ORDER BY updated_at DESC'
    ).all(employeeId) as EmployeeMemory[]

    const relevant = this.db.getDb().prepare(
      `SELECT * FROM employee_memories
       WHERE employee_id = ? AND is_pinned = 0 AND (key LIKE ? OR topic LIKE ? OR content LIKE ?)
       ORDER BY updated_at DESC LIMIT ?`
    ).all(
      employeeId,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit
    ) as EmployeeMemory[]

    return [...pinned, ...relevant]
  }

  formatMemoriesForPrompt(memories: EmployeeMemory[]): string {
    if (memories.length === 0) return ''

    const lines: string[] = ['## 跨会话记忆（关于该用户的持久信息）']
    for (const m of memories) {
      lines.push(`- [${m.topic}] ${m.content}`)
    }
    return lines.join('\n')
  }

  async extractMemoriesFromConversation(
    employeeId: string,
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string
  ): Promise<ExtractedMemory[]> {
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n')

    if (conversationText.length < 50) return []

    const prompt = `分析以下对话内容，提取值得跨会话记住的关键信息。这些信息将在未来对话中作为持久记忆注入系统提示词。

请提取以下类型的信息：
1. 用户偏好（如语言偏好、输出格式偏好、工作习惯等）
2. 决策结论（如用户做出的明确决定、选择等）
3. 事实知识（如用户提到的个人背景、项目信息、业务规则等）

请以 JSON 数组格式输出，每个元素包含：
- key: 简短标识符（英文，如 "preferred_language"）
- topic: 主题分类（如 "用户偏好"、"决策结论"、"事实知识"）
- content: 具体内容描述

如果没有值得记住的信息，返回空数组 []。

对话内容：
${conversationText}

请直接输出 JSON 数组，不要包含其他文字：`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 2000,
          model: modelId,
        }
      )

      const jsonMatch = response.match(/\[[\s\S]*\]/)
      if (!jsonMatch) return []

      const extracted = JSON.parse(jsonMatch[0]) as ExtractedMemory[]
      const validExtracted = extracted.filter(m => m.key && m.topic && m.content)

      for (const memory of validExtracted) {
        const existing = this.db.getDb().prepare(
          'SELECT * FROM employee_memories WHERE employee_id = ? AND key = ?'
        ).get(employeeId, memory.key) as EmployeeMemory | undefined

        if (existing) {
          this.db.getDb().prepare(
            'UPDATE employee_memories SET content = ?, topic = ?, updated_at = ? WHERE id = ?'
          ).run(memory.content, memory.topic, Math.floor(Date.now() / 1000), existing.id)
        } else {
          this.createMemory({
            employee_id: employeeId,
            key: memory.key,
            topic: memory.topic,
            content: memory.content,
            source: 'auto',
          })
        }
      }

      logger.info(`Extracted ${validExtracted.length} memories for employee ${employeeId}`)
      return validExtracted
    } catch (error: any) {
      logger.error(`Memory extraction failed: ${error.message}`)
      return []
    }
  }

  async generateLLMSummary(
    messages: Array<{ role: string; content: string }>,
    providerId: string,
    modelId?: string
  ): Promise<string> {
    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n')

    if (conversationText.length < 30) {
      return this.generateFallbackSummary(messages)
    }

    const prompt = `请对以下对话历史生成结构化摘要，保留语义完整性。按以下格式输出：

主题：（用一句话概括对话主题）
要点：
- （列出3-5个关键讨论点）
结论：（如有明确结论则写出，否则写"无明确结论"）

对话内容：
${conversationText}`

    try {
      const response = await this.llmClient.chat(
        providerId,
        [{ role: 'user', content: prompt }],
        {
          temperature: 0.1,
          max_tokens: 1000,
          model: modelId,
        }
      )

      return response || this.generateFallbackSummary(messages)
    } catch (error: any) {
      logger.error(`LLM summary generation failed: ${error.message}`)
      return this.generateFallbackSummary(messages)
    }
  }

  private generateFallbackSummary(messages: Array<{ role: string; content: string }>): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    const topics: string[] = []
    for (const msg of userMessages) {
      const preview = msg.content.substring(0, 100).trim()
      if (preview) {
        topics.push(`- 用户询问: ${preview}${msg.content.length > 100 ? '...' : ''}`)
      }
    }

    const summaryParts: string[] = []
    if (topics.length > 0) {
      summaryParts.push(`讨论了 ${topics.length} 个话题：`)
      summaryParts.push(...topics.slice(0, 10))
    }
    summaryParts.push(`共 ${userMessages.length} 条用户消息，${assistantMessages.length} 条助手回复。`)

    return summaryParts.join('\n')
  }
}

export default EmployeeMemoryService
