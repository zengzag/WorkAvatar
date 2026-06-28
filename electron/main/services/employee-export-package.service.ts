import crypto from 'crypto'
import { generateId } from './common-utils'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import PathService from './path.service'
import { EmployeeExportConfigService, EXPORT_CONFIG_VERSION, EmployeeConfigExport } from './employee-export-config.service'

export const EXPORT_PACKAGE_VERSION = '2.0.0'

export interface PackageManifest {
  version: string
  type: 'workavatar-employee-package'
  exportedAt: string
  employeeName: string
  checksum: string
  contents: {
    hasConfig: boolean
    hasSkills: boolean
    hasMemories: boolean
    skillCount: number
    memoryCount: number
  }
}

export class EmployeeExportPackageService {
  private db: DatabaseService
  private configService: EmployeeExportConfigService

  constructor(db: DatabaseService, configService: EmployeeExportConfigService) {
    this.db = db
    this.configService = configService
  }

  async exportPackage(
    employeeId: string,
    exportPath: string,
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
    if (!employee) return { success: false, error: 'Employee not found' }

    try {
      onProgress?.('preparing', 'Preparing employee package...')

      const skills = this.db.getDb().prepare(
        'SELECT * FROM skills WHERE employee_id = ?'
      ).all(employeeId) as any[]

      const employeeTools = this.db.getDb().prepare(
        'SELECT tool_id, is_enabled, config_json FROM employee_tools WHERE employee_id = ?'
      ).all(employeeId) as any[]

      const installedSkills = this.db.getDb().prepare(
        'SELECT es.skill_id, es.is_enabled, sk.name as skill_name FROM employee_skills es JOIN installed_skills sk ON es.skill_id = sk.id WHERE es.employee_id = ?'
      ).all(employeeId) as any[]

      const configData: EmployeeConfigExport = {
        version: EXPORT_CONFIG_VERSION,
        type: 'workavatar-employee-config',
        exportedAt: new Date().toISOString(),
        checksum: '',
        employee: {
          name: employee.name,
          description: employee.description,
          avatar_type: employee.avatar_type,
          profile_json: employee.profile_json || '',
          memory_enabled: !!employee.memory_enabled,
          default_skill_id: employee.default_skill_id || null,
        },
        skills: skills.map(s => ({
          type: s.type,
          name: s.name,
          description: s.description,
          config_json: s.config_json,
          prompt_template: s.prompt_template || undefined,
          rules_json: s.rules_json,
          test_cases_json: s.test_cases_json,
          input_schema_json: s.input_schema_json || undefined,
          output_schema_json: s.output_schema_json || undefined,
          priority: s.priority,
          is_enabled: !!s.is_enabled,
        })),
        tools: employeeTools.map(t => ({
          tool_id: t.tool_id,
          is_enabled: !!t.is_enabled,
          config_json: t.config_json || '{}',
        })),
        installedSkills: installedSkills.map(sk => ({
          skill_id: sk.skill_id,
          skill_name: sk.skill_name,
          is_enabled: !!sk.is_enabled,
        })),
      }

      const dataStr = JSON.stringify(configData, null, 2)
      configData.checksum = crypto.createHash('sha256').update(dataStr).digest('hex')

      const zip = new AdmZip()

      onProgress?.('adding_config', 'Adding employee configuration...')
      zip.addFile('employee-config.json', Buffer.from(JSON.stringify(configData, null, 2)))

      onProgress?.('adding_skills', 'Adding skill definitions...')
      let skillCount = 0
      for (const skillRef of installedSkills) {
        const installedSkill = this.db.getDb().prepare(
          'SELECT * FROM installed_skills WHERE id = ?'
        ).get(skillRef.skill_id) as any

        if (installedSkill && installedSkill.install_path && fs.existsSync(installedSkill.install_path)) {
          this.addDirectoryToZip(zip, installedSkill.install_path, `skills/${installedSkill.name}`)
          skillCount++
        }
      }

      onProgress?.('adding_memories', 'Adding employee memories...')
      const memories = this.db.getDb().prepare(
        'SELECT * FROM employee_memories WHERE employee_id = ?'
      ).all(employeeId) as any[]
      const memoryData = memories.map(m => ({
        key: m.key,
        topic: m.topic,
        content: m.content,
        is_pinned: !!m.is_pinned,
        source: m.source || 'auto',
        importance: m.importance || 'normal',
        last_referenced_at: m.last_referenced_at || null,
        created_at: m.created_at,
        updated_at: m.updated_at,
      }))
      zip.addFile('employee-memories.json', Buffer.from(JSON.stringify(memoryData, null, 2)))

      onProgress?.('generating_checksum', 'Generating checksum...')
      const manifest: PackageManifest = {
        version: EXPORT_PACKAGE_VERSION,
        type: 'workavatar-employee-package',
        exportedAt: new Date().toISOString(),
        employeeName: employee.name,
        checksum: '',
        contents: {
          hasConfig: true,
          hasSkills: skillCount > 0,
          hasMemories: memories.length > 0,
          skillCount,
          memoryCount: memories.length,
        },
      }

      const allFileContents = zip.getEntries().map(e => e.getData().toString('hex')).join('')
      manifest.checksum = crypto.createHash('sha256').update(allFileContents).digest('hex')

      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

      onProgress?.('saving', 'Saving package...')
      zip.writeZip(exportPath)
      onProgress?.('complete', `Package exported: ${skillCount} skills, ${memories.length} memories`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async importPackage(
    importPath: string,
    conflictStrategy: 'skip' | 'overwrite' | 'merge' = 'merge',
    onProgress?: (stage: string, detail: string) => void
  ): Promise<{ success: boolean; error?: string; employeeId?: string; warnings?: string[] }> {
    try {
      if (!fs.existsSync(importPath)) {
        return { success: false, error: 'Import file not found' }
      }

      onProgress?.('reading', 'Reading package...')
      const zip = new AdmZip(importPath)

      const manifestEntry = zip.getEntry('manifest.json')
      if (!manifestEntry) {
        return { success: false, error: 'Invalid package: manifest.json not found' }
      }

      const manifest: PackageManifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
      if (manifest.type !== 'workavatar-employee-package') {
        return { success: false, error: 'Invalid package: not a WorkAvatar employee package' }
      }

      const versionCheck = this.configService.checkVersionCompatibility(manifest.version)
      if (!versionCheck.compatible) {
        return { success: false, error: versionCheck.message }
      }

      const savedChecksum = manifest.checksum
      const entriesWithoutManifest = zip.getEntries().filter(e => e.entryName !== 'manifest.json')
      const allFileContents = entriesWithoutManifest.map(e => e.getData().toString('hex')).join('')
      const computedChecksum = crypto.createHash('sha256').update(allFileContents).digest('hex')
      if (savedChecksum && computedChecksum !== savedChecksum) {
        return { success: false, error: 'Package integrity check failed: file may be corrupted' }
      }

      const configEntry = zip.getEntry('employee-config.json')
      if (!configEntry) {
        return { success: false, error: 'Invalid package: employee-config.json not found' }
      }

      const configData: EmployeeConfigExport = JSON.parse(configEntry.getData().toString('utf-8'))

      const configChecksum = configData.checksum
      configData.checksum = ''
      const configStr = JSON.stringify(configData, null, 2)
      const computedConfigChecksum = crypto.createHash('sha256').update(configStr).digest('hex')
      if (configChecksum && computedConfigChecksum !== configChecksum) {
        return { success: false, error: 'Configuration checksum verification failed' }
      }

      onProgress?.('importing_config', 'Importing employee configuration...')
      const configResult = this.configService.importConfigFromData(configData, conflictStrategy)
      if (!configResult.success) {
        return { success: false, error: configResult.error }
      }

      const employeeId = configResult.employeeId!
      const warnings = configResult.warnings || []

      const skillEnabledMap = new Map<string, boolean>()
      for (const sk of configData.installedSkills || []) {
        skillEnabledMap.set(sk.skill_name, sk.is_enabled)
      }

      onProgress?.('importing_skills', 'Importing skill definitions...')
      const skillEntries = zip.getEntries().filter(e =>
        e.entryName.startsWith('skills/') && !e.isDirectory
      )

      const skillDirs = new Set<string>()
      for (const entry of skillEntries) {
        const parts = entry.entryName.split('/')
        if (parts.length >= 2) {
          skillDirs.add(parts[1])
        }
      }

      for (const skillDir of skillDirs) {
        const skillMdEntry = zip.getEntry(`skills/${skillDir}/SKILL.md`)
        if (skillMdEntry) {
          const skillMdContent = skillMdEntry.getData().toString('utf-8')
          const skillName = this.parseSkillNameFromMd(skillMdContent) || skillDir

          const existingSkill = this.db.getDb().prepare(
            'SELECT id FROM installed_skills WHERE name = ?'
          ).get(skillName) as any

          if (existingSkill) {
            if (conflictStrategy === 'skip') {
              warnings.push(`Skill "${skillName}" already exists, skipped`)
              continue
            }
          }

          const skillInstallPath = path.join(PathService.getInstance().getSkillsDir(), skillDir)

          if (!fs.existsSync(skillInstallPath)) {
            fs.mkdirSync(skillInstallPath, { recursive: true })
          }

          const skillFiles = zip.getEntries().filter(e =>
            e.entryName.startsWith(`skills/${skillDir}/`) && !e.isDirectory
          )

          for (const file of skillFiles) {
            const relativePath = file.entryName.substring(`skills/${skillDir}/`.length)
            const destPath = path.join(skillInstallPath, relativePath)
            const destDir = path.dirname(destPath)
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true })
            }
            fs.writeFileSync(destPath, file.getData())
          }

          if (!existingSkill) {
            const skillId = generateId()
            const now = Math.floor(Date.now() / 1000)
            const manifest2 = this.parseSkillMdManifest(skillMdContent)
            const isEnabled = skillEnabledMap.has(skillName) ? (skillEnabledMap.get(skillName)! ? 1 : 0) : 1

            this.db.getDb().prepare(`
              INSERT INTO installed_skills (id, name, description, version, author, tags_json, install_path, manifest_json, skill_md_content, is_enabled, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            `).run(
              skillId, skillName, manifest2.description || '',
              manifest2.version || '1.0.0', manifest2.author || '',
              JSON.stringify(manifest2.tags || []),
              skillInstallPath,
              JSON.stringify(manifest2),
              skillMdContent, now
            )

            const esId = generateId()
            this.db.getDb().prepare(`
              INSERT INTO employee_skills (id, employee_id, skill_id, is_enabled, config_json, created_at)
              VALUES (?, ?, ?, ?, '{}', ?)
            `).run(esId, employeeId, skillId, isEnabled, now)
          }
        }
      }

      onProgress?.('importing_memories', 'Importing employee memories...')
      const memoriesEntry = zip.getEntry('employee-memories.json')
      if (memoriesEntry) {
        try {
          const memoryData = JSON.parse(memoriesEntry.getData().toString('utf-8')) as any[]
          const now = Math.floor(Date.now() / 1000)
          for (const m of memoryData) {
            const mId = generateId()
            this.db.getDb().prepare(`
              INSERT INTO employee_memories (id, employee_id, key, topic, content, is_pinned, source, importance, created_at, updated_at, last_referenced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              mId, employeeId, m.key, m.topic, m.content || '',
              m.is_pinned ? 1 : 0, m.source || 'auto', m.importance || 'normal',
              m.created_at || now, m.updated_at || now, m.last_referenced_at || null
            )
          }
          if (memoryData.length > 0) {
            onProgress?.('importing_memories', `Imported ${memoryData.length} memories`)
          }
        } catch (e) {
          warnings.push(`Failed to import memories: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      onProgress?.('complete', 'Package import complete')
      return { success: true, employeeId, warnings }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  private addDirectoryToZip(zip: AdmZip, dirPath: string, zipPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const entryZipPath = `${zipPath}/${entry.name}`
      if (entry.isDirectory()) {
        this.addDirectoryToZip(zip, fullPath, entryZipPath)
      } else {
        zip.addLocalFile(fullPath, zipPath)
      }
    }
  }

  private parseSkillNameFromMd(content: string): string | null {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (match) {
      const frontMatter = match[1]
      const nameMatch = frontMatter.match(/^name:\s*(.+)$/m)
      if (nameMatch) return nameMatch[1].trim()
    }
    const headingMatch = content.match(/^#\s+(.+)$/m)
    return headingMatch ? headingMatch[1].trim() : null
  }

  private parseSkillMdManifest(content: string): {
    description?: string
    version?: string
    author?: string
    tags?: string[]
  } {
    const result: { description?: string; version?: string; author?: string; tags?: string[] } = {}
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
    if (match) {
      const frontMatter = match[1]
      const descMatch = frontMatter.match(/^description:\s*(.+)$/m)
      if (descMatch) result.description = descMatch[1].trim()
      const versionMatch = frontMatter.match(/^version:\s*(.+)$/m)
      if (versionMatch) result.version = versionMatch[1].trim()
      const authorMatch = frontMatter.match(/^author:\s*(.+)$/m)
      if (authorMatch) result.author = authorMatch[1].trim()
      const tagsMatch = frontMatter.match(/^tags:\s*\n((\s+-\s+.+\n?)+)/m)
      if (tagsMatch) {
        result.tags = tagsMatch[1].split('\n').map(t => t.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
      }
    }
    return result
  }
}

export default EmployeeExportPackageService
