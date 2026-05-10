import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { Project, File, Employee, Skill, Conversation } from '../../shared/types'
import DatabaseService from './database.service'

class ProjectManagerService {
  private db: DatabaseService
  private static instance: ProjectManagerService

  private constructor() {
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): ProjectManagerService {
    if (!ProjectManagerService.instance) {
      ProjectManagerService.instance = new ProjectManagerService()
    }
    return ProjectManagerService.instance
  }

  getProjectList(limit?: number, offset?: number): { projects: (Project & { file_count: number })[]; total: number } {
    const query = `
      SELECT p.*, COUNT(f.id) as file_count 
      FROM projects p 
      LEFT JOIN files f ON p.id = f.project_id 
      GROUP BY p.id 
      ORDER BY p.updated_at DESC
    `
    const countResult = this.db.getDb().prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }
    const total = countResult.count

    let projects: (Project & { file_count: number })[]
    if (limit !== undefined) {
      projects = this.db.getDb().prepare(query + ' LIMIT ? OFFSET ?').all(limit, offset || 0) as any
    } else {
      projects = this.db.getDb().prepare(query).all() as any
    }

    return { projects, total }
  }

  getProject(id: string): Project | null {
    return this.db.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project || null
  }

  createProject(name: string, description: string = '', rootPath?: string): Project {
    const projectId = crypto.randomUUID()
    const projectRoot = rootPath || path.join(app.getPath('documents'), 'WorkAvatar', 'projects', projectId)

    if (!fs.existsSync(projectRoot)) {
      fs.mkdirSync(projectRoot, { recursive: true })
    }

    const now = Math.floor(Date.now() / 1000)
    this.db.getDb().prepare(`
      INSERT INTO projects (id, name, description, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, name, description, projectRoot, now, now)

    return this.getProject(projectId)!
  }

  updateProject(id: string, data: { name?: string; description?: string; root_path?: string; llm_provider_id?: string }): Project | null {
    const project = this.getProject(id)
    if (!project) return null

    const updates: string[] = []
    const values: any[] = []

    if (data.name !== undefined) {
      updates.push('name = ?')
      values.push(data.name)
    }
    if (data.description !== undefined) {
      updates.push('description = ?')
      values.push(data.description)
    }
    if (data.root_path !== undefined) {
      updates.push('root_path = ?')
      values.push(data.root_path)
    }
    if (data.llm_provider_id !== undefined) {
      updates.push('llm_provider_id = ?')
      values.push(data.llm_provider_id)
    }

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)

      this.db.getDb().prepare(`
        UPDATE projects SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    }

    return this.getProject(id)
  }

  deleteProject(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM projects WHERE id = ?').run(id)
    return result.changes > 0
  }

  getFileList(projectId: string, status?: string): { files: File[]; total: number } {
    let query = 'SELECT * FROM files WHERE project_id = ?'
    const params: any[] = [projectId]

    if (status) {
      query += ' AND status = ?'
      params.push(status)
    }

    query += ' ORDER BY created_at DESC'

    const files = this.db.getDb().prepare(query).all(...params) as File[]
    const countResult = this.db.getDb().prepare(
      'SELECT COUNT(*) as count FROM files WHERE project_id = ?' + (status ? ' AND status = ?' : '')
    ).get(...params) as { count: number }

    return { files, total: countResult.count }
  }

  getFile(id: string): File | null {
    return this.db.getDb().prepare('SELECT * FROM files WHERE id = ?').get(id) as File || null
  }

  deleteFile(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM files WHERE id = ?').run(id)
    return result.changes > 0
  }

  getEmployeeList(projectId?: string, status?: string): Employee[] {
    let query = 'SELECT * FROM employees'
    const params: any[] = []

    if (projectId) {
      query += ' WHERE project_id = ?'
      params.push(projectId)
    }

    if (status) {
      query += projectId ? ' AND status = ?' : ' WHERE status = ?'
      params.push(status)
    }

    query += ' ORDER BY updated_at DESC'

    return this.db.getDb().prepare(query).all(...params) as Employee[]
  }

  getEmployee(id: string): Employee | null {
    return this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as Employee || null
  }

  createEmployee(projectId: string, name: string, description: string = '', profileJson: string = ''): Employee {
    const employeeId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    this.db.getDb().prepare(`
      INSERT INTO employees (id, project_id, name, description, profile_json, status, avatar_type, review_mode, arch_version, total_tasks, total_approvals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', 'default', 0, 1, 0, 0, ?, ?)
    `).run(employeeId, projectId, name, description, profileJson, now, now)

    return this.getEmployee(employeeId)!
  }

  updateEmployee(id: string, data: {
    name?: string
    description?: string
    profile_json?: string
    status?: 'draft' | 'active' | 'paused' | 'error'
    review_mode?: boolean
    default_skill_id?: string
    llm_provider_id?: string
    llm_model?: string
  }): Employee | null {
    const employee = this.getEmployee(id)
    if (!employee) return null

    const updates: string[] = []
    const values: any[] = []

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        if (key === 'review_mode') {
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

  deleteEmployee(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM employees WHERE id = ?').run(id)
    return result.changes > 0
  }

  getSkillList(employeeId: string): Skill[] {
    return this.db.getDb().prepare(
      'SELECT * FROM skills WHERE employee_id = ? ORDER BY priority ASC, created_at DESC'
    ).all(employeeId) as Skill[]
  }

  createSkill(employeeId: string, type: Skill['type'], name: string, description: string = '', promptTemplate?: string): Skill {
    const skillId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    this.db.getDb().prepare(`
      INSERT INTO skills (id, employee_id, type, name, description, config_json, prompt_template, rules_json, test_cases_json, priority, is_enabled, created_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?, '[]', '[]', 0, 1, ?)
    `).run(skillId, employeeId, type, name, description, promptTemplate || null, now)

    return this.db.getDb().prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as Skill
  }

  updateSkill(id: string, data: {
    name?: string
    description?: string
    config_json?: string
    prompt_template?: string
    rules_json?: string
    priority?: number
    is_enabled?: boolean
  }): Skill | null {
    const skill = this.db.getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill
    if (!skill) return null

    const updates: string[] = []
    const values: any[] = []

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined) {
        updates.push(`${key} = ?`)
        values.push(value)
      }
    })

    if (updates.length > 0) {
      values.push(id)
      this.db.getDb().prepare(`
        UPDATE skills SET ${updates.join(', ')} WHERE id = ?
      `).run(...values)
    }

    return this.db.getDb().prepare('SELECT * FROM skills WHERE id = ?').get(id) as Skill
  }

  deleteSkill(id: string): boolean {
    const result = this.db.getDb().prepare('DELETE FROM skills WHERE id = ?').run(id)
    return result.changes > 0
  }

  getConversationList(employeeId: string): Conversation[] {
    // 只查询必要字段，避免加载大的 messages_json
    return this.db.getDb().prepare(
      'SELECT id, employee_id, skill_id, title, message_count, status, created_at, updated_at FROM conversations WHERE employee_id = ? ORDER BY updated_at DESC'
    ).all(employeeId) as Conversation[]
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = ''): Conversation {
    const conversationId = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)

    this.db.getDb().prepare(`
      INSERT INTO conversations (id, employee_id, skill_id, title, messages_json, message_count, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', 0, 'active', ?, ?)
    `).run(conversationId, employeeId, skillId || null, title, now, now)

    return this.getConversation(conversationId)!
  }

  updateConversation(id: string, data: { title?: string; messages_json?: string; message_count?: number; status?: string }): Conversation | null {
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

export default ProjectManagerService
