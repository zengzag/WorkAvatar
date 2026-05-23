import fs from 'fs'
import path from 'path'
import type { Employee, Skill, Conversation } from '../../shared/types'
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
      INSERT INTO employees (id, workspace_path, name, description, profile_json, status, avatar_type, review_mode, arch_version, total_tasks, total_approvals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', 'default', 0, 1, 0, 0, ?, ?)
    `).run(employeeId, workspacePath, name, description, profileJson, now, now)

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
      'status', 'review_mode', 'avatar_url', 'prompt_template',
      'system_prompt', 'kb_id', 'kb_ids_json', 'tool_ids_json',
      'mcp_server_ids_json', 'skill_ids_json', 'workspace_dir',
      'llm_provider_id', 'llm_model', 'enable_thinking', 'description',
      'memory_enabled'
    ]

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && ALLOWED_COLUMNS.includes(key)) {
        if (key === 'review_mode' || key === 'memory_enabled') {
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

  deleteEmployeeWorkspace(id: string): boolean {
    const employee = this.getEmployee(id)
    if (!employee || !employee.workspace_path) return false

    const workspaceRoot = path.resolve(employee.workspace_path)
    if (fs.existsSync(workspaceRoot)) {
      try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch { return false }
    }

    this.db.getDb().prepare('UPDATE employees SET workspace_path = NULL, updated_at = unixepoch() WHERE id = ?').run(id)
    return true
  }

  getSkillList(employeeId: string): Skill[] {
    return this.db.getDb().prepare(
      'SELECT * FROM skills WHERE employee_id = ? ORDER BY priority ASC, created_at DESC'
    ).all(employeeId) as Skill[]
  }

  createSkill(employeeId: string, type: Skill['type'], name: string, description: string = '', promptTemplate?: string): Skill {
    const skillId = generateId()
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
    return this.db.getDb().prepare(
      'SELECT id, employee_id, skill_id, title, message_count, status, created_at, updated_at FROM conversations WHERE employee_id = ? ORDER BY updated_at DESC'
    ).all(employeeId) as Conversation[]
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = ''): Conversation {
    const employee = this.db.getDb().prepare('SELECT id FROM employees WHERE id = ?').get(employeeId)
    if (!employee) {
      throw new Error(`Employee not found: ${employeeId}`)
    }

    const conversationId = generateId()
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

  getAllRecentConversations(limit: number = 20): Array<{ id: string; employee_id: string; title: string; message_count: number; status: string; created_at: number; updated_at: number; employee_name: string | null }> {
    return this.db.getDb().prepare(`
      SELECT c.id, c.employee_id, c.title, c.message_count, c.status, c.created_at, c.updated_at, e.name as employee_name
      FROM conversations c
      LEFT JOIN employees e ON c.employee_id = e.id
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(limit) as Array<{ id: string; employee_id: string; title: string; message_count: number; status: string; created_at: number; updated_at: number; employee_name: string | null }>
  }

  private resolveWorkspacePath(workspacePath: string, relativePath?: string): { fullPath: string; error?: string } {
    if (!workspacePath) return { fullPath: '', error: '工作区路径未设置' }

    const workspaceRoot = path.resolve(workspacePath)
    if (!relativePath) return { fullPath: workspaceRoot }

    const fullPath = path.resolve(workspaceRoot, relativePath)
    if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
      return { fullPath: '', error: '路径超出工作区范围' }
    }

    return { fullPath }
  }

  getWorkspaceInfo(workspacePath: string): { success: boolean; path?: string; stats?: { fileCount: number; dirCount: number; totalSize: number }; error?: string } {
    if (!workspacePath) return { success: false, error: '工作区路径未设置' }

    const workspaceRoot = path.resolve(workspacePath)
    if (!fs.existsSync(workspaceRoot)) {
      fs.mkdirSync(workspaceRoot, { recursive: true })
      return { success: true, path: workspaceRoot, stats: { fileCount: 0, dirCount: 0, totalSize: 0 } }
    }

    let fileCount = 0
    let dirCount = 0
    let totalSize = 0

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          dirCount++
          walk(fullPath)
        } else if (entry.isFile()) {
          fileCount++
          try { totalSize += fs.statSync(fullPath).size } catch {}
        }
      }
    }

    try { walk(workspaceRoot) } catch {}

    return { success: true, path: workspaceRoot, stats: { fileCount, dirCount, totalSize } }
  }

  listWorkspaceFiles(workspacePath: string, subPath?: string, recursive?: boolean): { success: boolean; items?: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: number }>; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, subPath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '目录不存在' }
    if (!fs.statSync(fullPath).isDirectory()) return { success: false, error: '路径不是目录' }

    const items: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: number }> = []
    const workspaceRoot = path.resolve(workspacePath)

    const walk = (dir: string) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
      } catch { return }

      for (const entry of entries) {
        const entryFullPath = path.join(dir, entry.name)
        const relativePath = path.relative(workspaceRoot, entryFullPath).replace(/\\/g, '/')
        if (entry.isDirectory()) {
          items.push({ name: entry.name, path: relativePath, type: 'dir' })
          if (recursive) walk(entryFullPath)
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(entryFullPath)
            items.push({ name: entry.name, path: relativePath, type: 'file', size: stat.size, modified: Math.floor(stat.mtimeMs / 1000) })
          } catch {}
        }
      }
    }

    walk(fullPath)
    return { success: true, items }
  }

  readWorkspaceFile(workspacePath: string, filePath: string): { success: boolean; content?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, filePath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '文件不存在' }
    if (!fs.statSync(fullPath).isFile()) return { success: false, error: '路径不是文件' }

    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      return { success: true, content }
    } catch (e: any) {
      return { success: false, error: `读取文件失败: ${e.message}` }
    }
  }

  writeWorkspaceFile(workspacePath: string, filePath: string, content: string): { success: boolean; path?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, filePath)
    if (error) return { success: false, error }

    const dir = path.dirname(fullPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    try {
      fs.writeFileSync(fullPath, content, 'utf-8')
      return { success: true, path: fullPath }
    } catch (e: any) {
      return { success: false, error: `写入文件失败: ${e.message}` }
    }
  }

  createWorkspaceFolder(workspacePath: string, folderPath: string): { success: boolean; path?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, folderPath)
    if (error) return { success: false, error }

    if (fs.existsSync(fullPath)) return { success: false, error: '路径已存在' }

    try {
      fs.mkdirSync(fullPath, { recursive: true })
      return { success: true, path: fullPath }
    } catch (e: any) {
      return { success: false, error: `创建文件夹失败: ${e.message}` }
    }
  }

  deleteWorkspaceItem(workspacePath: string, itemPath: string): { success: boolean; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, itemPath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '路径不存在' }

    try {
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true })
      } else {
        fs.unlinkSync(fullPath)
      }
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `删除失败: ${e.message}` }
    }
  }

  renameWorkspaceItem(workspacePath: string, itemPath: string, newName: string): { success: boolean; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(workspacePath, itemPath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '路径不存在' }

    const dir = path.dirname(fullPath)
    const newPath = path.join(dir, newName)
    const workspaceRoot = path.resolve(workspacePath)
    const newRelativePath = path.relative(workspaceRoot, newPath).replace(/\\/g, '/')
    const { fullPath: newFullPath, error: newError } = this.resolveWorkspacePath(workspacePath, newRelativePath)
    if (newError) return { success: false, error: newError }

    if (fs.existsSync(newFullPath)) return { success: false, error: '目标名称已存在' }

    try {
      fs.renameSync(fullPath, newFullPath)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `重命名失败: ${e.message}` }
    }
  }

  importToWorkspace(workspacePath: string, sourcePaths: string[], targetFolder?: string): { success: boolean; imported?: string[]; errors?: Array<{ path: string; error: string }> } {
    const { fullPath: targetDir, error: dirError } = this.resolveWorkspacePath(workspacePath, targetFolder)
    if (dirError) return { success: false, errors: [{ path: '', error: dirError }] }

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    const imported: string[] = []
    const errors: Array<{ path: string; error: string }> = []

    for (const srcPath of sourcePaths) {
      try {
        if (!fs.existsSync(srcPath)) {
          errors.push({ path: srcPath, error: '源文件不存在' })
          continue
        }

        const stat = fs.statSync(srcPath)
        const fileName = path.basename(srcPath)
        const destPath = path.join(targetDir, fileName)

        if (stat.isFile()) {
          fs.copyFileSync(srcPath, destPath)
          imported.push(fileName)
        } else if (stat.isDirectory()) {
          fs.cpSync(srcPath, destPath, { recursive: true })
          imported.push(fileName)
        }
      } catch (e: any) {
        errors.push({ path: srcPath, error: e.message })
      }
    }

    return { success: imported.length > 0, imported, errors }
  }
}

export default WorkspaceManagerService
