import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId } from './common-utils'

export interface ClaudeSkillManifest {
  name: string
  description: string
  version?: string
  author?: string
  tags?: string[]
  tools?: string[]
}

export interface ClaudeSkill {
  id: string
  name: string
  description: string
  version: string
  author: string
  tags: string[]
  installPath: string
  manifest: ClaudeSkillManifest
  skillMdContent: string
  references: Array<{
    name: string
    content: string
  }>
  scripts: Array<{
    name: string
    content: string
  }>
  is_enabled: boolean
  created_at: number
}

export interface InstallSkillResult {
  success: boolean
  skill?: ClaudeSkill
  error?: string
}

class SkillRegistryService {
  private db: DatabaseService
  private skillsDir: string
  private static instance: SkillRegistryService

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.skillsDir = PathService.getInstance().getSkillsDir()
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true })
    }
  }

  static getInstance(): SkillRegistryService {
    if (!SkillRegistryService.instance) {
      SkillRegistryService.instance = new SkillRegistryService()
    }
    return SkillRegistryService.instance
  }

  getSkillsDir(): string {
    return this.skillsDir
  }

  async installFromDirectory(sourceDir: string): Promise<InstallSkillResult> {
    try {
      const skillMdPath = path.join(sourceDir, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) {
        return { success: false, error: '目录中未找到 SKILL.md 文件，不符合 Claude Skills 格式' }
      }

      const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')
      const manifest = this.parseSkillMd(skillMdContent)

      const skillId = this.generateSkillId(manifest.name)
      const installPath = path.join(this.skillsDir, skillId)

      if (fs.existsSync(installPath)) {
        fs.rmSync(installPath, { recursive: true })
      }

      this.copyDirectory(sourceDir, installPath)

      const references = this.loadReferences(installPath)
      const scripts = this.loadScripts(installPath)

      const skill: ClaudeSkill = {
        id: skillId,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version || '1.0.0',
        author: manifest.author || 'Unknown',
        tags: manifest.tags || [],
        installPath,
        manifest,
        skillMdContent,
        references,
        scripts,
        is_enabled: true,
        created_at: Date.now(),
      }

      this.saveToDatabase(skill)
      return { success: true, skill }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  async installFromZip(zipPath: string): Promise<InstallSkillResult> {
    try {
      const extractDir = path.join(this.skillsDir, '_temp_' + Date.now())
      fs.mkdirSync(extractDir, { recursive: true })

      const zip = new AdmZip(zipPath)
      zip.extractAllTo(extractDir, true)

      const entries = fs.readdirSync(extractDir)
      let skillDir = extractDir

      if (entries.length === 1 && fs.statSync(path.join(extractDir, entries[0])).isDirectory()) {
        skillDir = path.join(extractDir, entries[0])
      }

      const result = await this.installFromDirectory(skillDir)

      fs.rmSync(extractDir, { recursive: true, force: true })

      return result
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  parseSkillMd(content: string): ClaudeSkillManifest {
    const lines = content.split('\n')
    const manifest: ClaudeSkillManifest = {
      name: '',
      description: '',
      version: '1.0.0',
      author: '',
      tags: [],
      tools: [],
    }

    let inFrontMatter = false
    let frontMatterLines: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '---') {
        if (!inFrontMatter) {
          inFrontMatter = true
          continue
        } else {
          break
        }
      }
      if (inFrontMatter) {
        frontMatterLines.push(trimmed)
      }
    }

    for (const line of frontMatterLines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim()
        const value = line.substring(colonIndex + 1).trim()
        switch (key) {
          case 'name':
            manifest.name = value
            break
          case 'description':
            manifest.description = value
            break
          case 'version':
            manifest.version = value
            break
          case 'author':
            manifest.author = value
            break
          case 'tags':
            manifest.tags = value.split(',').map((t) => t.trim()).filter(Boolean)
            break
          case 'tools':
            manifest.tools = value.split(',').map((t) => t.trim()).filter(Boolean)
            break
        }
      }
    }

    if (!manifest.name) {
      const titleMatch = content.match(/^#\s+(.+)$/m)
      if (titleMatch) {
        manifest.name = titleMatch[1].trim()
      }
    }

    if (!manifest.description) {
      const descPatterns = [
        /^#\s+.+\n\n(.+?)(?:\n\n|\n#{1,6}\s|$)/ms,
        /^#\s+.+\n(.+?)(?:\n\n|\n#{1,6}\s|$)/ms,
        /\n\n([^#\n].{10,500}?)\n/,
      ]
      for (const pattern of descPatterns) {
        const descMatch = content.match(pattern)
        if (descMatch) {
          const desc = descMatch[1].trim()
          if (desc.length >= 5) {
            manifest.description = desc
            break
          }
        }
      }
    }

    return manifest
  }

  private loadReferences(skillDir: string): Array<{ name: string; content: string }> {
    const refsDir = path.join(skillDir, 'references')
    const refs: Array<{ name: string; content: string }> = []

    if (!fs.existsSync(refsDir)) return refs

    const files = fs.readdirSync(refsDir)
    for (const file of files) {
      const filePath = path.join(refsDir, file)
      if (fs.statSync(filePath).isFile()) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          refs.push({ name: file, content })
        } catch {
        }
      }
    }

    return refs
  }

  private loadScripts(skillDir: string): Array<{ name: string; content: string }> {
    const scriptsDir = path.join(skillDir, 'scripts')
    const scripts: Array<{ name: string; content: string }> = []

    if (!fs.existsSync(scriptsDir)) return scripts

    const files = fs.readdirSync(scriptsDir)
    for (const file of files) {
      const filePath = path.join(scriptsDir, file)
      if (fs.statSync(filePath).isFile()) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          scripts.push({ name: file, content })
        } catch {
        }
      }
    }

    return scripts
  }

  private copyDirectory(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    const entries = fs.readdirSync(src, { withFileTypes: true })

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)

      if (entry.isDirectory()) {
        this.copyDirectory(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }

  private generateSkillId(name: string): string {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    return `${sanitized}-${generateId()}`
  }

  private saveToDatabase(skill: ClaudeSkill): void {
    const db = this.db.getDb()
    db.prepare(
      `INSERT OR REPLACE INTO installed_skills (
        id, name, description, version, author, tags_json, install_path, manifest_json, skill_md_content, is_enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      skill.id,
      skill.name,
      skill.description,
      skill.version,
      skill.author,
      JSON.stringify(skill.tags),
      skill.installPath,
      JSON.stringify(skill.manifest),
      skill.skillMdContent,
      skill.is_enabled ? 1 : 0,
      skill.created_at
    )
  }

  getInstalledSkills(): ClaudeSkill[] {
    const db = this.db.getDb()
    const rows = db.prepare('SELECT * FROM installed_skills ORDER BY created_at DESC').all() as any[]

    return rows.map((row) => this.rowToSkill(row))
  }

  getSkillById(id: string): ClaudeSkill | null {
    const db = this.db.getDb()
    const row = db.prepare('SELECT * FROM installed_skills WHERE id = ?').get(id) as any
    if (!row) return null

    return this.rowToSkill(row)
  }

  private rowToSkill(row: any): ClaudeSkill {
    const installPath = row.install_path
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      tags: JSON.parse(row.tags_json || '[]'),
      installPath,
      manifest: JSON.parse(row.manifest_json || '{}'),
      skillMdContent: row.skill_md_content,
      references: this.loadReferences(installPath),
      scripts: this.loadScripts(installPath),
      is_enabled: row.is_enabled === 1,
      created_at: row.created_at,
    }
  }

  async uninstallSkill(id: string): Promise<boolean> {
    try {
      const skill = this.getSkillById(id)
      if (skill && fs.existsSync(skill.installPath)) {
        fs.rmSync(skill.installPath, { recursive: true, force: true })
      }

      const db = this.db.getDb()
      db.prepare('DELETE FROM installed_skills WHERE id = ?').run(id)
      db.prepare('DELETE FROM employee_skills WHERE skill_id = ?').run(id)

      return true
    } catch {
      return false
    }
  }

  toggleSkill(id: string, enabled: boolean): void {
    const db = this.db.getDb()
    db.prepare('UPDATE installed_skills SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
  }

  getSkillPrompt(skillId: string): string {
    const skill = this.getSkillById(skillId)
    if (!skill) return ''

    const parts: string[] = []
    parts.push(`# ${skill.name}`)
    parts.push('')
    parts.push(skill.skillMdContent)

    if (skill.references.length > 0) {
      parts.push('')
      parts.push('## 参考资料')
      for (const ref of skill.references) {
        parts.push(`### ${ref.name}`)
        parts.push(ref.content.substring(0, 3000))
      }
    }

    return parts.join('\n')
  }

  assignSkillToEmployee(skillId: string, employeeId: string): void {
    const db = this.db.getDb()
    const id = generateId()
    db.prepare(
      'INSERT OR IGNORE INTO employee_skills (id, employee_id, skill_id, is_enabled) VALUES (?, ?, ?, 1)'
    ).run(id, employeeId, skillId)
  }

  removeSkillFromEmployee(skillId: string, employeeId: string): void {
    const db = this.db.getDb()
    db.prepare('DELETE FROM employee_skills WHERE employee_id = ? AND skill_id = ?').run(employeeId, skillId)
  }

  toggleSkillForEmployee(skillId: string, employeeId: string, enabled: boolean): void {
    const db = this.db.getDb()
    const existing = db.prepare(
      'SELECT id FROM employee_skills WHERE employee_id = ? AND skill_id = ?'
    ).get(employeeId, skillId) as any

    if (existing) {
      db.prepare('UPDATE employee_skills SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, existing.id)
    } else {
      const id = generateId()
      db.prepare(
        'INSERT INTO employee_skills (id, employee_id, skill_id, is_enabled) VALUES (?, ?, ?, ?)'
      ).run(id, employeeId, skillId, enabled ? 1 : 0)
    }
  }

  getEmployeeSkills(employeeId: string): { enabled: ClaudeSkill[]; disabled: ClaudeSkill[] } {
    const db = this.db.getDb()
    const allSkills = this.getInstalledSkills()

    const employeeRows = db.prepare(
      'SELECT skill_id, is_enabled FROM employee_skills WHERE employee_id = ?'
    ).all(employeeId) as any[]

    const skillStateMap = new Map<string, boolean>()
    for (const row of employeeRows) {
      skillStateMap.set(row.skill_id, row.is_enabled === 1)
    }

    return {
      enabled: allSkills.filter((s) => skillStateMap.get(s.id) === true),
      disabled: allSkills.filter((s) => skillStateMap.get(s.id) !== true),
    }
  }
}

export default SkillRegistryService
