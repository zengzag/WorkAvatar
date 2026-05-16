import crypto from 'crypto'
import { generateId } from './common-utils'
import fs from 'fs'
import DatabaseService from './database.service'
import KBDatabaseService from './kb-database.service'

export const EXPORT_CONFIG_VERSION = '1.0.0'

export interface EmployeeConfigExport {
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

export class EmployeeExportConfigService {
  private kbDb: KBDatabaseService
  private db: DatabaseService

  constructor(db: DatabaseService, kbDb: KBDatabaseService) {
    this.db = db
    this.kbDb = kbDb
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

  importConfigFromData(
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

  getEmployeeKnowledgeBases(projectId: string): Array<{ kb_id: string; kb_name: string }> {
    return this.kbDb.getDb().prepare(`
      SELECT kb.id as kb_id, kb.name as kb_name
      FROM knowledge_bases kb
      INNER JOIN kb_project_links kpl ON kb.id = kpl.kb_id
      WHERE kpl.project_id = ?
    `).all(projectId) as Array<{ kb_id: string; kb_name: string }>
  }

  getEmployeeMCPServers(_employeeId: string): Array<{ server_id: string; server_name: string }> {
    return this.db.getDb().prepare(`
      SELECT DISTINCT ms.id as server_id, ms.name as server_name
      FROM mcp_servers ms
      WHERE ms.is_enabled = 1
    `).all() as Array<{ server_id: string; server_name: string }>
  }

  checkVersionCompatibility(version: string): { compatible: boolean; message?: string } {
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

  validateConfig(data: EmployeeConfigExport): { valid: boolean; errors: string[] } {
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
}
