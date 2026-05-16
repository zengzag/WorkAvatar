import fs from 'fs'
import path from 'path'
import type { Project, File, Employee, Skill, Conversation } from '../../shared/types'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId } from './common-utils'

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
      projects = this.db.getDb().prepare(query + ' LIMIT ? OFFSET ?').all(limit, offset || 0) as (Project & { file_count: number })[]
    } else {
      projects = this.db.getDb().prepare(query).all() as (Project & { file_count: number })[]
    }

    return { projects, total }
  }

  getProject(id: string): Project | null {
    return this.db.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project || null
  }

  createProject(name: string, description: string = '', rootPath?: string): Project {
    const projectId = generateId()
    const basePath = rootPath || PathService.getInstance().getDataDir()
    const projectRoot = path.join(basePath, 'WorkAvatar', 'projects', projectId)

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

  deleteProject(id: string, deleteWorkspace: boolean = false): boolean {
    if (deleteWorkspace) {
      const project = this.getProject(id)
      if (project && project.root_path) {
        const workspaceRoot = path.resolve(project.root_path)
        if (fs.existsSync(workspaceRoot)) {
          try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
        }
      }
    }
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
    let query = 'SELECT e.*, p.name as project_name FROM employees e LEFT JOIN projects p ON e.project_id = p.id'
    const params: any[] = []

    if (projectId) {
      query += ' WHERE e.project_id = ?'
      params.push(projectId)
    }

    if (status) {
      query += projectId ? ' AND e.status = ?' : ' WHERE e.status = ?'
      params.push(status)
    }

    query += ' ORDER BY e.updated_at DESC'

    return this.db.getDb().prepare(query).all(...params) as Employee[]
  }

  getEmployee(id: string): Employee | null {
    return this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(id) as Employee || null
  }

  createEmployee(projectId: string, name: string, description: string = '', profileJson: string = ''): Employee {
    const employeeId = generateId()
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
    // 只查询必要字段，避免加载大的 messages_json
    return this.db.getDb().prepare(
      'SELECT id, employee_id, skill_id, title, message_count, status, created_at, updated_at FROM conversations WHERE employee_id = ? ORDER BY updated_at DESC'
    ).all(employeeId) as Conversation[]
  }

  getConversation(id: string): Conversation | null {
    return this.db.getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation || null
  }

  createConversation(employeeId: string, skillId?: string, title: string = ''): Conversation {
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

  private resolveWorkspacePath(projectId: string, relativePath?: string): { fullPath: string; error?: string } {
    const project = this.getProject(projectId)
    if (!project) return { fullPath: '', error: '项目不存在' }

    const workspaceRoot = path.resolve(project.root_path)
    if (!relativePath) return { fullPath: workspaceRoot }

    const fullPath = path.resolve(workspaceRoot, relativePath)
    if (!fullPath.startsWith(workspaceRoot + path.sep) && fullPath !== workspaceRoot) {
      return { fullPath: '', error: '路径超出项目工作区范围' }
    }

    return { fullPath }
  }

  getWorkspaceInfo(projectId: string): { success: boolean; path?: string; stats?: { fileCount: number; dirCount: number; totalSize: number }; error?: string } {
    const project = this.getProject(projectId)
    if (!project) return { success: false, error: '项目不存在' }

    const workspaceRoot = path.resolve(project.root_path)
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

  listWorkspaceFiles(projectId: string, subPath?: string, recursive?: boolean): { success: boolean; items?: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: number }>; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, subPath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '目录不存在' }
    if (!fs.statSync(fullPath).isDirectory()) return { success: false, error: '路径不是目录' }

    const items: Array<{ name: string; path: string; type: 'file' | 'dir'; size?: number; modified?: number }> = []
    const project = this.getProject(projectId)!
    const workspaceRoot = path.resolve(project.root_path)

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

  readWorkspaceFile(projectId: string, filePath: string): { success: boolean; content?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, filePath)
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

  writeWorkspaceFile(projectId: string, filePath: string, content: string): { success: boolean; path?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, filePath)
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

  createWorkspaceFolder(projectId: string, folderPath: string): { success: boolean; path?: string; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, folderPath)
    if (error) return { success: false, error }

    if (fs.existsSync(fullPath)) return { success: false, error: '路径已存在' }

    try {
      fs.mkdirSync(fullPath, { recursive: true })
      return { success: true, path: fullPath }
    } catch (e: any) {
      return { success: false, error: `创建文件夹失败: ${e.message}` }
    }
  }

  deleteWorkspaceItem(projectId: string, itemPath: string): { success: boolean; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, itemPath)
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

  renameWorkspaceItem(projectId: string, itemPath: string, newName: string): { success: boolean; error?: string } {
    const { fullPath, error } = this.resolveWorkspacePath(projectId, itemPath)
    if (error) return { success: false, error }

    if (!fs.existsSync(fullPath)) return { success: false, error: '路径不存在' }

    const dir = path.dirname(fullPath)
    const newPath = path.join(dir, newName)
    const { fullPath: newFullPath, error: newError } = this.resolveWorkspacePath(projectId, path.relative(this.getProject(projectId)!.root_path, newPath).replace(/\\/g, '/'))
    if (newError) return { success: false, error: newError }

    if (fs.existsSync(newFullPath)) return { success: false, error: '目标名称已存在' }

    try {
      fs.renameSync(fullPath, newFullPath)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: `重命名失败: ${e.message}` }
    }
  }

  importToWorkspace(projectId: string, sourcePaths: string[], targetFolder?: string): { success: boolean; imported?: string[]; errors?: Array<{ path: string; error: string }> } {
    const { fullPath: targetDir, error: dirError } = this.resolveWorkspacePath(projectId, targetFolder)
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

export default ProjectManagerService
