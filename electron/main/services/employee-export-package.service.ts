import crypto from 'crypto'
import { generateId } from './common-utils'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'
import PathService from './path.service'
import KnowledgeBaseService from './kb.service'
import { EmployeeExportConfigService, EXPORT_CONFIG_VERSION, EmployeeConfigExport } from './employee-export-config.service'

export const EXPORT_PACKAGE_VERSION = '1.0.0'

export interface PackageManifest {
  version: string
  type: 'workavatar-employee-package'
  exportedAt: string
  employeeName: string
  checksum: string
  contents: {
    hasConfig: boolean
    hasSkills: boolean
    hasKnowledgeBases: boolean
    skillCount: number
    kbCount: number
    docCount: number
  }
}

export class EmployeeExportPackageService {
  private kbDb: KBDatabaseService
  private db: DatabaseService
  private configService: EmployeeExportConfigService

  constructor(db: DatabaseService, kbDb: KBDatabaseService, configService: EmployeeExportConfigService) {
    this.db = db
    this.kbDb = kbDb
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
          review_mode: !!employee.review_mode,
          llm_provider_id: employee.llm_provider_id || undefined,
          llm_model: employee.llm_model || undefined,
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
          hasKnowledgeBases: false,
          skillCount,
          kbCount: 0,
          docCount: 0,
        },
      }

      const allFileContents = zip.getEntries().map(e => e.getData().toString('hex')).join('')
      manifest.checksum = crypto.createHash('sha256').update(allFileContents).digest('hex')

      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

      onProgress?.('saving', 'Saving package...')
      zip.writeZip(exportPath)
      onProgress?.('complete', `Package exported: ${skillCount} skills`)

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
              VALUES (?, ?, ?, 1, '{}', ?)
            `).run(esId, employeeId, skillId, now)
          }
        }
      }

      onProgress?.('importing_knowledge', 'Importing knowledge bases...')
      const kbEntries = zip.getEntries().filter(e =>
        e.entryName.startsWith('knowledge-bases/') && e.entryName.endsWith('kb-data.json')
      )

      const importedKBIds: string[] = []

      for (const kbEntry of kbEntries) {
        const kbData = JSON.parse(kbEntry.getData().toString('utf-8'))

        const existingKB = this.kbDb.getDb().prepare(
          'SELECT id FROM knowledge_bases WHERE name = ?'
        ).get(kbData.name) as any

        let targetKBId: string

        if (existingKB) {
          if (conflictStrategy === 'skip') {
            warnings.push(`Knowledge base "${kbData.name}" already exists, skipped`)
            targetKBId = existingKB.id
          } else if (conflictStrategy === 'overwrite') {
            const oldKbBasePath = PathService.getInstance().getKBBasePath(existingKB.id)
            if (fs.existsSync(oldKbBasePath)) {
              try { fs.rmSync(oldKbBasePath, { recursive: true, force: true }) } catch {}
            }
            this.kbDb.getDb().prepare('DELETE FROM knowledge_bases WHERE id = ?').run(existingKB.id)
            targetKBId = this.createKBFromData(kbData)
          } else {
            targetKBId = existingKB.id
          }
        } else {
          targetKBId = this.createKBFromData(kbData)
        }

        importedKBIds.push(targetKBId)

        const kbBasePath = PathService.getInstance().getKBBasePath(targetKBId)

        const safeKbName = kbData.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
        const docFiles = zip.getEntries().filter(e =>
          e.entryName.startsWith(`knowledge-bases/${safeKbName}/documents/`) && !e.isDirectory
        )

        for (const docFile of docFiles) {
          const fileName = path.basename(docFile.entryName)
          const destPath = path.join(kbBasePath, fileName)
          fs.writeFileSync(destPath, docFile.getData())
        }
      }

      onProgress?.('building_index', 'Building search indexes...')
      const kbService = KnowledgeBaseService.getInstance()
      for (const kbId of importedKBIds) {
        try {
          await kbService.rebuildSearchIndex(kbId)
        } catch {}
      }

      onProgress?.('complete', 'Package import complete')
      return { success: true, employeeId, warnings }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  private createKBFromData(kbData: any): string {
    const kbId = generateId()
    const now = Math.floor(Date.now() / 1000)

    const kbPath = PathService.getInstance().getKBBasePath(kbId)

    this.kbDb.getDb().prepare(`
      INSERT INTO knowledge_bases (id, name, description, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kbId, kbData.name, kbData.description || '', kbPath, now, now)

    const docIdMap = new Map<string, string>()
    for (const doc of kbData.documents || []) {
      const newDocId = generateId()
      docIdMap.set(doc.id, newDocId)

      let parsedJsonPath: string | null = null
      if (doc.parsed_json) {
        const parseDir = path.join(kbPath, '_parsed', newDocId)
        if (!fs.existsSync(parseDir)) {
          fs.mkdirSync(parseDir, { recursive: true })
        }
        parsedJsonPath = path.join(parseDir, 'parsed.json')
        fs.writeFileSync(parsedJsonPath, doc.parsed_json, 'utf-8')
      }

      this.kbDb.getDb().prepare(`
        INSERT INTO kb_documents (id, kb_id, file_id, original_name, type, size, hash, parsed_json_path, parse_status, is_reused, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newDocId, kbId, doc.file_id || null, doc.original_name, doc.type, doc.size, doc.hash,
        parsedJsonPath, doc.parse_status || 'pending', doc.is_reused || 0,
        doc.created_at || now, doc.updated_at || now
      )
    }

    for (const p of kbData.paragraphs || []) {
      const newDocId = docIdMap.get(p.document_id)
      if (!newDocId) continue

      const pId = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_paragraphs (id, kb_id, document_id, title, title_path, level, paragraph_index, start_offset, end_offset, content, summary, keywords_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        pId, kbId, newDocId, p.title, p.title_path || null,
        p.level || 1, p.paragraph_index ?? 0,
        p.start_offset, p.end_offset, p.content || '',
        p.summary || null, p.keywords_json || '[]'
      )
    }

    for (const ds of kbData.docSummaries || []) {
      const newDocId = docIdMap.get(ds.document_id)
      if (!newDocId) continue

      const id = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, keywords_json, main_topics_json, toc_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        id, kbId, newDocId, ds.summary || '',
        ds.keywords_json || '[]', ds.main_topics_json || '[]',
        ds.toc_json || '[]'
      )
    }

    if (kbData.globalSummary) {
      const gs = kbData.globalSummary
      const id = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        id, kbId, gs.summary || '',
        gs.key_topics_json || '[]'
      )
    }

    return kbId
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
