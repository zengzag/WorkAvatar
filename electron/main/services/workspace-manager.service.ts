import fs from 'fs'
import path from 'path'
import type { Employee, Conversation } from '../../shared/types'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId, generateShortId, extractMessagePreview } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('WorkspaceManager')

class WorkspaceManagerService {
  private db: DatabaseService
  private static instance: WorkspaceManagerService

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): WorkspaceManagerService {
    if (!WorkspaceManagerService.instance) {
      WorkspaceManagerService.instance = new WorkspaceManagerService()
    }
    return WorkspaceManagerService.instance
  }

  getEmployeeList(status?: string): Employee[] {
    let query = 'SELECT * FROM employees'
    const params: any[] = []

    if (status) {
      query += ' WHERE status = ?'
      params.push(status)
    }

    query += ' ORDER BY updated_at DESC'

    return this.db.getDb().prepare(query).all(...params) as Employee[]
  }

  getEmployee(id: string): Employee | null {
    return this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as Employee || null
  }

  createEmployee(name: string, description: string = '', profileJson: string = ''): Employee {
    const employeeId = generateId()
    const now = Math.floor(Date.now() / 1000)

    const basePath = PathService.getInstance().getDataDir()
    const employeesRoot = path.join(basePath, 'employees')
    // 目录名使用 8 字符短 ID（与 24 字符 DB 主键解耦），重试至多 10 次避免极小概率碰撞
    let workspacePath = ''
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = path.join(employeesRoot, generateShortId())
      if (!fs.existsSync(candidate)) {
        workspacePath = candidate
        break
      }
    }
    if (!workspacePath) {
      // 兜底：拼接 employeeId 前缀确保唯一
      workspacePath = path.join(employeesRoot, `${generateShortId()}-${employeeId.slice(0, 4)}`)
    }

    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true })
    }

    this.db.getDb().prepare(`
      INSERT INTO employees (id, workspace_path, name, description, profile_json, status, avatar_type, arch_version, total_tasks, total_approvals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', 'default', 1, 0, 0, ?, ?)
    `).run(employeeId, workspacePath, name, description, profileJson, now, now)

    return this.getEmployee(employeeId)!
  }

  updateEmployee(id: string, data: {
    name?: string
    description?: string
    profile_json?: string
    status?: 'draft' | 'active' | 'paused' | 'error'
    default_skill_id?: string
    workspace_path?: string | null
    memory_enabled?: boolean
  }): Employee | null {
    const employee = this.getEmployee(id)
    if (!employee) return null

    const updates: string[] = []
    const values: any[] = []

    const ALLOWED_COLUMNS = [
      'name', 'description', 'profile_json',
      'status', 'default_skill_id',
      'memory_enabled', 'workspace_path'
    ]

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_COLUMNS.includes(key)) {
        if (key === 'memory_enabled') {
          updates.push(`${key} = ?`)
          values.push(value ? 1 : 0)
        } else {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
    })

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)

      this.db.getDb().prepare(`
        UPDATE employees SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    }

    return this.getEmployee(id)
  }

  deleteEmployee(id: string, deleteWorkspace: boolean = false): boolean {
    if (deleteWorkspace) {
      const employee = this.getEmployee(id)
      if (employee && employee.workspace_path) {
        // 安全校验：workspace_path 必须位于数据目录的 employees/ 子目录下，
        // 防止 DB 被篡改后通过 workspace_path 递归删除任意系统目录
        const basePath = PathService.getInstance().getDataDir()
        const employeesRoot = path.resolve(basePath, 'employees')
        const workspaceRoot = path.resolve(employee.workspace_path)
        const relative = path.relative(employeesRoot, workspaceRoot)
        const isWithinEmployees = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
        if (!isWithinEmployees) {
          logger.warn(`Refused to delete workspace outside employees root: ${employee.workspace_path}`)
        } else if (fs.existsSync(workspaceRoot)) {
          try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch (error) { logger.warn('Failed to remove workspace directory', workspaceRoot, error) }
        }
      }
    }
    const result = this.db.getDb().prepare('DELETE FROM employees WHERE id = ?').run(id)
    return result.changes > 0
  }

  getConversationList(employeeId: string): Conversation[] {
    return this.db.getDb().prepare(
      'SELECT id, employee_id, skill_id, title, message_count, minimal_mode, status, created_at, updated_at, last_message_at FROM conversations WHERE employee_id = ? ORDER BY COALESCE(last_message_at, created_at) DESC'
    ).all(employeeId) as Conversation[]
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = '', minimalMode?: boolean): Conversation {
    const employee = this.db.getDb().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId)
    if (!employee) {
      throw new Error(`Employee not found: ${employeeId}`)
    }

    const conversationId = generateId()
    const now = Math.floor(Date.now() / 1000)

    this.db.getDb().prepare(`
      INSERT INTO conversations (id, employee_id, skill_id, title, messages_json, message_count, minimal_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', 0, ?, 'active', ?, ?)
    `).run(conversationId, employeeId, skillId || null, title, minimalMode ? 1 : 0, now, now)

    this.syncConversationFTS(conversationId, employeeId, title, '', '[]')

    return this.getConversation(conversationId)!
  }

  private syncConversationFTS(id: string, employeeId: string, title: string, summary: string, messagesJson: string): void {
    this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id)
    const preview = extractMessagePreview(messagesJson)
    this.db.getDb().prepare(
      'INSERT INTO conversations_fts (title, summary, content_preview, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?)'
    ).run(title || '', summary || '', preview, id, employeeId)
  }

  updateConversation(id: string, data: { title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string }): boolean {
    const ALLOWED_CONVERSATION_COLUMNS = [
      'title', 'messages_json', 'message_count',
      'status', 'minimal_mode', 'last_message_at', 'employee_id'
    ]

    const updates: string[] = []
    const values: any[] = []

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_CONVERSATION_COLUMNS.includes(key)) {
        if (key === 'minimal_mode') {
          updates.push(`${key} = ?`)
          values.push(value ? 1 : 0)
        } else {
          updates.push(`${key} = ?`)
          values.push(value)
        }
      }
    })

    if (updates.length === 0) return false

    updates.push('updated_at = unixepoch()')
    values.push(id)

    const result = this.db.getDb().prepare(`
      UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
    `).run(...values)

    if (result.changes === 0) return false

    // FTS 同步：在 title / messages_json / employee_id 变化时执行
    // 优化：避免 SELECT * 加载完整 messages_json 大字段，只查必要的小字段
    if (data.title !== undefined || data.messages_json !== undefined || data.employee_id !== undefined) {
      const needMessagesJson = data.messages_json === undefined
      const cols = needMessagesJson
        ? 'employee_id, title, summary, messages_json'
        : 'employee_id, title, summary'
      const row = this.db.getDb().prepare(
        `SELECT ${cols} FROM conversations WHERE id = ?`
      ).get(id) as any
      if (row) {
        this.syncConversationFTS(
          id,
          row.employee_id,
          data.title !== undefined ? data.title : row.title,
          row.summary || '',
          data.messages_json !== undefined ? data.messages_json : (row.messages_json || '[]')
        )
      }
    }

    return true
  }

  deleteConversation(id: string): boolean {
    this.db.getDb().prepare('DELETE FROM conversations_fts WHERE conversation_id = ?').run(id)
    const result = this.db.getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteAllConversations(employeeId: string): number {
    this.db.getDb().prepare('DELETE FROM conversations_fts WHERE employee_id = ?').run(employeeId)
    const result = this.db.getDb().prepare('DELETE FROM conversations WHERE employee_id = ?').run(employeeId)
    return result.changes
  }
}

export default WorkspaceManagerService
