import crypto from 'crypto'
import { generateId } from './common-utils'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'
import PathService from './path.service'

const EXPORT_CONFIG_VERSION = '1.0.0'
const EXPORT_PACKAGE_VERSION = '1.0.0'

interface EmployeeConfigExport {
  version: string
  type: 'workavatar-employee-config'
  exportedAt: string
  checksum: string
  employee: {
    name: string
    description: string
    avatar_type: string
    profile_json: string
    review_mode: boolean
    llm_provider_id?: string
    llm_model?: string
  }
  skills: Array<{
    type: string
    name: string
    description: string
    config_json: string
    prompt_template?: string
    rules_json: string
    test_cases_json: string
    input_schema_json?: string
    output_schema_json?: string
    priority: number
    is_enabled: boolean
  }>
  tools: Array<{
    tool_id: string
    is_enabled: boolean
    config_json: string
  }>
  knowledgeBases: Array<{
    kb_id: string
    kb_name: string
  }>
  mcpServers: Array<{
    mcp_server_id: string
    mcp_server_name: string
  }>
  installedSkills: Array<{
    skill_id: string
    skill_name: string
    is_enabled: boolean
  }>
}

interface PackageManifest {
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

class EmployeeExportService {
  private kbDb: KBDatabaseService
  private db: DatabaseService
  private static instance: EmployeeExportService

  private constructor() {
    this.kbDb = KBDatabaseService.getInstance()
    this.db = DatabaseService.getInstance()
  }

  static getInstance(): EmployeeExportService {
    if (!EmployeeExportService.instance) {
      EmployeeExportService.instance = new EmployeeExportService()
    }
    return EmployeeExportService.instance
  }

  exportConfig(
    employeeId: string,
    exportPath: string
  ): { success: boolean; error?: string } {
    const employee = this.db.getDb().prepare('SELECT * FROM employees WHERE id = ?').get(employeeId) as any
    if (!employee) return { success: false, error: 'Employee not found' }

    try {
      const skills = this.db.getDb().prepare(
        'SELECT * FROM skills WHERE employee_id = ?'
      ).all(employeeId) as any[]

      const employeeTools = this.db.getDb().prepare(
        'SELECT tool_id, is_enabled, config_json FROM employee_tools WHERE employee_id = ?'
      ).all(employeeId) as any[]

      const linkedKBs = this.getEmployeeKnowledgeBases(employee.project_id)

      const mcpServers = this.getEmployeeMCPServers(employeeId)

      const installedSkills = this.db.getDb().prepare(
        'SELECT es.skill_id, es.is_enabled, sk.name as skill_name FROM employee_skills es JOIN installed_skills sk ON es.skill_id = sk.id WHERE es.employee_id = ?'
      ).all(employeeId) as any[]

      const exportData: EmployeeConfigExport = {
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
        knowledgeBases: linkedKBs.map(kb => ({
          kb_id: kb.kb_id,
          kb_name: kb.kb_name,
        })),
        mcpServers: mcpServers.map(mcp => ({
          mcp_server_id: mcp.server_id,
          mcp_server_name: mcp.server_name,
        })),
        installedSkills: installedSkills.map(sk => ({
          skill_id: sk.skill_id,
          skill_name: sk.skill_name,
          is_enabled: !!sk.is_enabled,
        })),
      }

      const dataStr = JSON.stringify(exportData, null, 2)
      exportData.checksum = crypto.createHash('sha256').update(dataStr).digest('hex')

      const finalStr = JSON.stringify(exportData, null, 2)
      fs.writeFileSync(exportPath, finalStr, 'utf-8')

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: errorMessage }
    }
  }

  importConfig(
    importPath: string,
    projectId: string,
    conflictStrategy: 'skip' | 'overwrite' | 'merge' = 'merge'
  ): { success: boolean; error?: string; employeeId?: string; warnings?: string[] } {
    try {
      if (!fs.existsSync(importPath)) {
        return { success: false, error: 'Import file not found' }
      }

      const content = fs.readFileSync(importPath, 'utf-8')
      const importData: EmployeeConfigExport = JSON.parse(content)

      if (importData.type !== 'workavatar-employee-config') {
        return { success: false, error: 'Invalid file: not a WorkAvatar employee config export' }
      }

      const versionCheck = this.checkVersionCompatibility(importData.version)
      if (!versionCheck.compatible) {
        return { success: false, error: versionCheck.message }
      }

      const savedChecksum = importData.checksum
      importData.checksum = ''
      const dataStr = JSON.stringify(importData, null, 2)
      const computedChecksum = crypto.createHash('sha256').update(dataStr).digest('hex')
      if (savedChecksum && computedChecksum !== savedChecksum) {
        return { success: false, error: 'Checksum verification failed: file may be corrupted' }
      }

      const validation = this.validateConfig(importData)
      if (!validation.valid) {
        return { success: false, error: `Configuration validation failed: ${validation.errors.join('; ')}` }
      }

      const warnings: string[] = []

      const project = this.db.getDb().prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any
      if (!project) {
        return { success: false, error: 'Target project not found' }
      }

      const employeeId = generateId()
      const now = Math.floor(Date.now() / 1000)

      this.db.getDb().prepare(`
        INSERT INTO employees (id, project_id, name, description, profile_json, status, avatar_type, review_mode, llm_provider_id, llm_model, arch_version, total_tasks, total_approvals, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, 0, 0, ?, ?)
      `).run(
        employeeId,
        projectId,
        importData.employee.name,
        importData.employee.description || '',
        importData.employee.profile_json || '',
        importData.employee.avatar_type || 'default',
        importData.employee.review_mode ? 1 : 0,
        importData.employee.llm_provider_id || null,
        importData.employee.llm_model || null,
        now, now
      )

      for (const skill of importData.skills || []) {
        const skillId = generateId()
        this.db.getDb().prepare(`
          INSERT INTO skills (id, employee_id, type, name, description, config_json, prompt_template, rules_json, test_cases_json, input_schema_json, output_schema_json, priority, is_enabled, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          skillId, employeeId, skill.type, skill.name, skill.description || '',
          skill.config_json || '{}', skill.prompt_template || null,
          skill.rules_json || '[]', skill.test_cases_json || '[]',
          skill.input_schema_json || null, skill.output_schema_json || null,
          skill.priority || 0, skill.is_enabled !== false ? 1 : 0, now
        )
      }

      for (const tool of importData.tools || []) {
        const existingTool = this.db.getDb().prepare(
          'SELECT id FROM employee_tools WHERE employee_id = ? AND tool_id = ?'
        ).get(employeeId, tool.tool_id) as any

        if (existingTool) {
          if (conflictStrategy === 'overwrite') {
            this.db.getDb().prepare(
              'UPDATE employee_tools SET is_enabled = ?, config_json = ? WHERE employee_id = ? AND tool_id = ?'
            ).run(tool.is_enabled ? 1 : 0, tool.config_json || '{}', employeeId, tool.tool_id)
          } else if (conflictStrategy === 'merge') {
            this.db.getDb().prepare(
              'UPDATE employee_tools SET is_enabled = ? WHERE employee_id = ? AND tool_id = ?'
            ).run(tool.is_enabled ? 1 : 0, employeeId, tool.tool_id)
          }
        } else {
          const etId = generateId()
          this.db.getDb().prepare(`
            INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled, config_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(etId, employeeId, tool.tool_id, tool.is_enabled ? 1 : 0, tool.config_json || '{}', now)
        }
      }

      for (const kbRef of importData.knowledgeBases || []) {
        const kbExists = this.kbDb.getDb().prepare(
          'SELECT id FROM knowledge_bases WHERE id = ?'
        ).get(kbRef.kb_id) as any

        if (kbExists) {
          const linkExists = this.kbDb.getDb().prepare(
            'SELECT id FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
          ).get(kbRef.kb_id, projectId) as any

          if (!linkExists) {
            const linkId = generateId()
            this.kbDb.getDb().prepare(`
              INSERT INTO kb_project_links (id, kb_id, project_id, created_at)
              VALUES (?, ?, ?, ?)
            `).run(linkId, kbRef.kb_id, projectId, now)
          }
        } else {
          warnings.push(`Knowledge base "${kbRef.kb_name}" (${kbRef.kb_id}) not found, skipped`)
        }
      }

      for (const mcpRef of importData.mcpServers || []) {
        const mcpExists = this.db.getDb().prepare(
          'SELECT id FROM mcp_servers WHERE id = ?'
        ).get(mcpRef.mcp_server_id) as any

        if (!mcpExists) {
          warnings.push(`MCP server "${mcpRef.mcp_server_name}" (${mcpRef.mcp_server_id}) not found, skipped`)
        }
      }

      for (const skillRef of importData.installedSkills || []) {
        const skillExists = this.db.getDb().prepare(
          'SELECT id FROM installed_skills WHERE id = ?'
        ).get(skillRef.skill_id) as any

        if (skillExists) {
          const existingAssign = this.db.getDb().prepare(
            'SELECT id FROM employee_skills WHERE employee_id = ? AND skill_id = ?'
          ).get(employeeId, skillRef.skill_id) as any

          if (!existingAssign) {
            const esId = generateId()
            this.db.getDb().prepare(`
              INSERT INTO employee_skills (id, employee_id, skill_id, is_enabled, config_json, created_at)
              VALUES (?, ?, ?, ?, '{}', ?)
            `).run(esId, employeeId, skillRef.skill_id, skillRef.is_enabled ? 1 : 0, now)
          }
        } else {
          warnings.push(`Installed skill "${skillRef.skill_name}" (${skillRef.skill_id}) not found, skipped`)
        }
      }

      return { success: true, employeeId, warnings }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: errorMessage }
    }
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

      const linkedKBs = this.getEmployeeKnowledgeBases(employee.project_id)
      const mcpServers = this.getEmployeeMCPServers(employeeId)
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
        knowledgeBases: linkedKBs.map(kb => ({
          kb_id: kb.kb_id,
          kb_name: kb.kb_name,
        })),
        mcpServers: mcpServers.map(mcp => ({
          mcp_server_id: mcp.server_id,
          mcp_server_name: mcp.server_name,
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

      onProgress?.('adding_knowledge', 'Adding knowledge base data...')
      let docCount = 0
      for (const kbRef of linkedKBs) {
        const kb = this.kbDb.getDb().prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(kbRef.kb_id) as any
        if (!kb) continue

        const kbDocuments = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_documents WHERE kb_id = ?'
        ).all(kbRef.kb_id) as any[]

        const kbChapters = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_chapters WHERE kb_id = ?'
        ).all(kbRef.kb_id) as any[]

        const kbDocSummaries = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_document_summaries WHERE kb_id = ?'
        ).all(kbRef.kb_id) as any[]

        const kbGlobalSummary = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_global_summaries WHERE kb_id = ?'
        ).get(kbRef.kb_id) as any

        const kbEntities = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_entities WHERE kb_id = ?'
        ).all(kbRef.kb_id) as any[]

        const kbEntityRelations = this.kbDb.getDb().prepare(
          'SELECT * FROM kb_entity_relations WHERE kb_id = ?'
        ).all(kbRef.kb_id) as any[]

        const kbData = {
          id: kb.id,
          name: kb.name,
          description: kb.description,
          documents: kbDocuments.map(d => {
            let parsedJson: string | null = null
            if (d.parsed_json_path && fs.existsSync(d.parsed_json_path)) {
              try { parsedJson = fs.readFileSync(d.parsed_json_path, 'utf-8') } catch {}
            }
            return {
              id: d.id,
              original_name: d.original_name,
              type: d.type,
              size: d.size,
              hash: d.hash,
              parsed_json: parsedJson,
              parse_status: d.parse_status,
              created_at: d.created_at,
              updated_at: d.updated_at,
            }
          }),
          chapters: kbChapters,
          docSummaries: kbDocSummaries,
          globalSummary: kbGlobalSummary || null,
          entities: kbEntities,
          entityRelations: kbEntityRelations,
        }

        const safeKbName = kb.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
        zip.addFile(
          `knowledge-bases/${safeKbName}/kb-data.json`,
          Buffer.from(JSON.stringify(kbData, null, 2))
        )

        const kbBasePath = PathService.getInstance().getKBBasePath(kb.id)

        for (const doc of kbDocuments) {
          const filePath = path.join(kbBasePath, doc.original_name)
          if (fs.existsSync(filePath)) {
            zip.addLocalFile(filePath, `knowledge-bases/${safeKbName}/documents`)
            docCount++
          }
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
          hasKnowledgeBases: linkedKBs.length > 0,
          skillCount,
          kbCount: linkedKBs.length,
          docCount,
        },
      }

      const allFileContents = zip.getEntries().map(e => e.getData().toString('hex')).join('')
      manifest.checksum = crypto.createHash('sha256').update(allFileContents).digest('hex')

      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))

      onProgress?.('saving', 'Saving package...')
      zip.writeZip(exportPath)
      onProgress?.('complete', `Package exported: ${skillCount} skills, ${linkedKBs.length} knowledge bases, ${docCount} documents`)

      return { success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  async importPackage(
    importPath: string,
    projectId: string,
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

      const versionCheck = this.checkVersionCompatibility(manifest.version)
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
      const configResult = this.importConfigFromData(configData, projectId, conflictStrategy)
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
            this.kbDb.getDb().prepare('DELETE FROM knowledge_bases WHERE id = ?').run(existingKB.id)
            targetKBId = this.createKBFromData(kbData)
          } else {
            targetKBId = existingKB.id
          }
        } else {
          targetKBId = this.createKBFromData(kbData)
        }

        const linkExists = this.kbDb.getDb().prepare(
          'SELECT id FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
        ).get(targetKBId, projectId) as any

        if (!linkExists) {
          const linkId = generateId()
          const now = Math.floor(Date.now() / 1000)
          this.kbDb.getDb().prepare(`
            INSERT INTO kb_project_links (id, kb_id, project_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(linkId, targetKBId, projectId, now)
        }

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

      onProgress?.('complete', 'Package import complete')
      return { success: true, employeeId, warnings }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      onProgress?.('error', errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  private importConfigFromData(
    importData: EmployeeConfigExport,
    projectId: string,
    _conflictStrategy: 'skip' | 'overwrite' | 'merge'
  ): { success: boolean; error?: string; employeeId?: string; warnings?: string[] } {
    const validation = this.validateConfig(importData)
    if (!validation.valid) {
      return { success: false, error: `Configuration validation failed: ${validation.errors.join('; ')}` }
    }

    const warnings: string[] = []
    const now = Math.floor(Date.now() / 1000)

    const employeeId = generateId()

    this.db.getDb().prepare(`
      INSERT INTO employees (id, project_id, name, description, profile_json, status, avatar_type, review_mode, llm_provider_id, llm_model, arch_version, total_tasks, total_approvals, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, 0, 0, ?, ?)
    `).run(
      employeeId, projectId,
      importData.employee.name,
      importData.employee.description || '',
      importData.employee.profile_json || '',
      importData.employee.avatar_type || 'default',
      importData.employee.review_mode ? 1 : 0,
      importData.employee.llm_provider_id || null,
      importData.employee.llm_model || null,
      now, now
    )

    for (const skill of importData.skills || []) {
      const skillId = generateId()
      this.db.getDb().prepare(`
        INSERT INTO skills (id, employee_id, type, name, description, config_json, prompt_template, rules_json, test_cases_json, input_schema_json, output_schema_json, priority, is_enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        skillId, employeeId, skill.type, skill.name, skill.description || '',
        skill.config_json || '{}', skill.prompt_template || null,
        skill.rules_json || '[]', skill.test_cases_json || '[]',
        skill.input_schema_json || null, skill.output_schema_json || null,
        skill.priority || 0, skill.is_enabled !== false ? 1 : 0, now
      )
    }

    for (const tool of importData.tools || []) {
      const etId = generateId()
      this.db.getDb().prepare(`
        INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled, config_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(etId, employeeId, tool.tool_id, tool.is_enabled ? 1 : 0, tool.config_json || '{}', now)
    }

    for (const kbRef of importData.knowledgeBases || []) {
      const kbExists = this.kbDb.getDb().prepare('SELECT id FROM knowledge_bases WHERE id = ?').get(kbRef.kb_id) as any
      if (kbExists) {
        const linkExists = this.kbDb.getDb().prepare(
          'SELECT id FROM kb_project_links WHERE kb_id = ? AND project_id = ?'
        ).get(kbRef.kb_id, projectId) as any
        if (!linkExists) {
          const linkId = generateId()
          this.kbDb.getDb().prepare(`
            INSERT INTO kb_project_links (id, kb_id, project_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(linkId, kbRef.kb_id, projectId, now)
        }
      } else {
        warnings.push(`Knowledge base "${kbRef.kb_name}" not found, skipped`)
      }
    }

    for (const skillRef of importData.installedSkills || []) {
      const skillExists = this.db.getDb().prepare('SELECT id FROM installed_skills WHERE id = ?').get(skillRef.skill_id) as any
      if (skillExists) {
        const esId = generateId()
        this.db.getDb().prepare(`
          INSERT INTO employee_skills (id, employee_id, skill_id, is_enabled, config_json, created_at)
          VALUES (?, ?, ?, ?, '{}', ?)
        `).run(esId, employeeId, skillRef.skill_id, skillRef.is_enabled ? 1 : 0, now)
      } else {
        warnings.push(`Installed skill "${skillRef.skill_name}" not found, skipped`)
      }
    }

    return { success: true, employeeId, warnings }
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
        INSERT INTO kb_documents (id, kb_id, original_name, type, size, hash, parsed_json_path, parse_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newDocId, kbId, doc.original_name, doc.type, doc.size, doc.hash,
        parsedJsonPath, doc.parse_status || 'pending',
        doc.created_at || now, doc.updated_at || now
      )
    }

    for (const ch of kbData.chapters || []) {
      const newDocId = docIdMap.get(ch.document_id)
      if (!newDocId) continue

      const chId = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_chapters (id, kb_id, document_id, title, chapter_index, start_offset, end_offset, content, summary, keywords_json, entities_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        chId, kbId, newDocId, ch.title, ch.chapter_index,
        ch.start_offset, ch.end_offset, ch.content || '',
        ch.summary || null, ch.keywords_json || '[]', ch.entities_json || '[]'
      )
    }

    for (const ds of kbData.docSummaries || []) {
      const newDocId = docIdMap.get(ds.document_id)
      if (!newDocId) continue

      const id = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_document_summaries (id, kb_id, document_id, summary, key_entities_json, timeline_json, keywords_json, main_topics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        id, kbId, newDocId, ds.summary || '',
        ds.key_entities_json || '[]', ds.timeline_json || '[]',
        ds.keywords_json || '[]', ds.main_topics_json || '[]'
      )
    }

    if (kbData.globalSummary) {
      const gs = kbData.globalSummary
      const id = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_global_summaries (id, kb_id, summary, key_topics_json, key_entities_json, global_timeline_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        id, kbId, gs.summary || '',
        gs.key_topics_json || '[]', gs.key_entities_json || '[]', gs.global_timeline_json || '[]'
      )
    }

    const entityIdMap = new Map<string, string>()
    for (const entity of kbData.entities || []) {
      const newEntityId = generateId()
      entityIdMap.set(entity.id, newEntityId)

      this.kbDb.getDb().prepare(`
        INSERT INTO kb_entities (id, kb_id, name, type, description, aliases_json, attributes_json, mention_count, first_seen_doc_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(
        newEntityId, kbId, entity.name, entity.type, entity.description,
        entity.aliases_json || '[]', entity.attributes_json || '{}',
        entity.mention_count || 0, docIdMap.get(entity.first_seen_doc_id) || null
      )
    }

    for (const rel of kbData.entityRelations || []) {
      const newSourceId = entityIdMap.get(rel.source_entity_id)
      const newTargetId = entityIdMap.get(rel.target_entity_id)
      if (!newSourceId || !newTargetId) continue

      const id = generateId()
      this.kbDb.getDb().prepare(`
        INSERT INTO kb_entity_relations (id, kb_id, source_entity_id, target_entity_id, relation_type, description, source_document_id, confidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `).run(
        id, kbId, newSourceId, newTargetId, rel.relation_type,
        rel.description || null, docIdMap.get(rel.source_document_id) || null,
        rel.confidence || null
      )
    }

    return kbId
  }

  private getEmployeeKnowledgeBases(projectId: string): Array<{ kb_id: string; kb_name: string }> {
    return this.kbDb.getDb().prepare(`
      SELECT kb.id as kb_id, kb.name as kb_name
      FROM knowledge_bases kb
      INNER JOIN kb_project_links kpl ON kb.id = kpl.kb_id
      WHERE kpl.project_id = ?
    `).all(projectId) as Array<{ kb_id: string; kb_name: string }>
  }

  private getEmployeeMCPServers(_employeeId: string): Array<{ server_id: string; server_name: string }> {
    return this.db.getDb().prepare(`
      SELECT DISTINCT ms.id as server_id, ms.name as server_name
      FROM mcp_servers ms
      WHERE ms.is_enabled = 1
    `).all() as Array<{ server_id: string; server_name: string }>
  }

  private checkVersionCompatibility(version: string): { compatible: boolean; message?: string } {
    const [major] = version.split('.').map(Number)
    const [currentMajor] = EXPORT_CONFIG_VERSION.split('.').map(Number)

    if (major > currentMajor) {
      return {
        compatible: false,
        message: `Incompatible version: export version ${version} is newer than current version ${EXPORT_CONFIG_VERSION}. Please update the application.`
      }
    }

    return { compatible: true }
  }

  private validateConfig(data: EmployeeConfigExport): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!data.employee) {
      errors.push('Missing employee data')
    } else {
      if (!data.employee.name) {
        errors.push('Missing employee name')
      }
    }

    if (!data.version) {
      errors.push('Missing version information')
    }

    if (!data.type) {
      errors.push('Missing type identifier')
    }

    return { valid: errors.length === 0, errors }
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

export default EmployeeExportService
