import fs from 'fs'
import path from 'path'
import type { Employee, Conversation } from '../../shared/types'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId } from './common-utils'

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
    const workspacePath = path.join(basePath, 'employees', employeeId)

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
      'name', 'role_name', 'role_description', 'responsibilities_json',
      'personality_traits_json', 'working_style', 'suggested_tools_json',
      'status', 'avatar_url', 'prompt_template',
      'system_prompt', 'kb_id', 'kb_ids_json', 'tool_ids_json',
      'mcp_server_ids_json', 'skill_ids_json', 'workspace_dir',
      'enable_thinking', 'description',
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
        const workspaceRoot = path.resolve(employee.workspace_path)
        if (fs.existsSync(workspaceRoot)) {
          try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
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

    return this.getConversation(conversationId)!
  }

  updateConversation(id: string, data: { title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number }): Conversation | null {
    const conversation = this.getConversation(id)
    if (!conversation) return null

    const updates: string[] = []
    const values: any[] = []

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        updates.push(`${key} = ?`)
        values.push(value)
      }
    })

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)

      this.db.getDb().prepare(`
        UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    }

    return this.getConversation(id)
  }

  deleteConversation(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
    return result.changes > 0
  }

  deleteAllConversations(employeeId: string): number {
    const result = this.db.getDb().prepare('DELETE FROM conversations WHERE employee_id = ?').run(employeeId)
    return result.changes
  }
}

export default WorkspaceManagerService
