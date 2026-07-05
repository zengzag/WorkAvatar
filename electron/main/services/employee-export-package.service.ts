import crypto from 'crypto'
import { generateId } from './common-utils'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import DatabaseService from './database.service'
import PathService from './path.service'
import { EmployeeExportConfigService, EmployeeConfigExport } from './employee-export-config.service'

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
    try {
      onProgress?.('preparing', 'Preparing employee package...')

      // 复用 config service 的数据构建逻辑，避免两处重复维护
      const { data: configData, error: buildError } = this.configService.buildConfigData(employeeId)
      if (!configData) return { success: false, error: buildError || 'Employee not found' }

      // 重新查询 installedSkills 以供后续 skill 文件打包使用
      const installedSkills = this.db.getDb().prepare(
        'SELECT es.skill_id, es.is_enabled, sk.name as skill_name, sk.install_path FROM employee_skills es JOIN installed_skills sk ON es.skill_id = sk.id WHERE es.employee_id = ?'
      ).all(employeeId) as any[]

      configData.checksum = this.configService.computeChecksum(configData)

      const zip = new AdmZip()

      onProgress?.('adding_config', 'Adding employee configuration...')
      zip.addFile('employee-config.json', Buffer.from(JSON.stringify(configData, null, 2)))

      onProgress?.('adding_skills', 'Adding skill definitions...')
      let skillCount = 0
      for (const skillRef of installedSkills) {
        // skillRef 已包含 install_path 和 skill_name，无需再查 installed_skills
        if (skillRef.install_path && fs.existsSync(skillRef.install_path)) {
          this.addDirectoryToZip(zip, skillRef.install_path, `skills/${skillRef.skill_name}`)
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
        employeeName: configData.employee.name,
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

      const versionCheck = this.configService.checkVersionCompatibility(manifest.version, EXPORT_PACKAGE_VERSION)
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
      const computedConfigChecksum = this.configService.computeChecksum(configData)
      if (configChecksum && computedConfigChecksum !== configChecksum) {
        return { success: false, error: 'Configuration checksum verification failed' }
      }

      onProgress?.('importing_config', 'Importing employee configuration...')
      // configData 总是创建新员工，工具/已安装技能的冲突策略由本方法的技能导入循环处理
      const configResult = this.configService.importConfigFromData(configData)
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

      // Phase 1：写所有技能文件到磁盘（文件写入是幂等的，覆盖安全）
      const skillMetaList: Array<{
        skillName: string
        skillMdContent: string
        manifest2: ReturnType<EmployeeExportPackageService['parseSkillMdManifest']>
        skillInstallPath: string
        existingSkill: any
      }> = []

      for (const skillDir of skillDirs) {
        const skillMdEntry = zip.getEntry(`skills/${skillDir}/SKILL.md`)
        if (!skillMdEntry) continue

        const skillMdContent = skillMdEntry.getData().toString('utf-8')
        const skillName = this.parseSkillNameFromMd(skillMdContent) || skillDir

        const existingSkill = this.db.getDb().prepare(
          'SELECT id FROM installed_skills WHERE name = ?'
        ).get(skillName) as any

        if (existingSkill && conflictStrategy === 'skip') {
          warnings.push(`Skill "${skillName}" already exists, skipped`)
          continue
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

        skillMetaList.push({
          skillName,
          skillMdContent,
          manifest2: this.parseSkillMdManifest(skillMdContent),
          skillInstallPath,
          existingSkill,
        })
      }

      // Phase 2：所有 DB 操作放在单个事务中，避免部分失败导致文件/DB 不一致
      this.db.getDb().transaction(() => {
        const now = Math.floor(Date.now() / 1000)
        for (const meta of skillMetaList) {
          const { skillName, skillMdContent, manifest2, skillInstallPath, existingSkill } = meta
          const isEnabled = skillEnabledMap.has(skillName) ? (skillEnabledMap.get(skillName)! ? 1 : 0) : 1

          if (!existingSkill) {
            // 新技能：INSERT installed_skills + employee_skills
            const skillId = generateId()
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
          } else {
            // 已存在技能：确保 employee_skills 关联存在
            const existingAssoc = this.db.getDb().prepare(
              'SELECT id FROM employee_skills WHERE employee_id = ? AND skill_id = ?'
            ).get(employeeId, existingSkill.id) as any
            if (!existingAssoc) {
              const esId = generateId()
              this.db.getDb().prepare(`
                INSERT INTO employee_skills (id, employee_id, skill_id, is_enabled, config_json, created_at)
                VALUES (?, ?, ?, ?, '{}', ?)
              `).run(esId, employeeId, existingSkill.id, isEnabled, now)
            }

            // overwrite 策略：更新 installed_skills 的元数据（description/version/manifest 等）
            if (conflictStrategy === 'overwrite') {
              this.db.getDb().prepare(`
                UPDATE installed_skills
                SET description = ?, version = ?, author = ?, tags_json = ?, manifest_json = ?, skill_md_content = ?
                WHERE id = ?
              `).run(
                manifest2.description || '',
                manifest2.version || '1.0.0',
                manifest2.author || '',
                JSON.stringify(manifest2.tags || []),
                JSON.stringify(manifest2),
                skillMdContent,
                existingSkill.id
              )
            }
          }
        }
      })()

      onProgress?.('importing_memories', 'Importing employee memories...')
      const memoriesEntry = zip.getEntry('employee-memories.json')
      if (memoriesEntry) {
        try {
          const memoryData = JSON.parse(memoriesEntry.getData().toString('utf-8')) as any[]
          const now = Math.floor(Date.now() / 1000)
          // 整体放在单个事务中，保证记忆导入的原子性
          this.db.getDb().transaction(() => {
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
          })()
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
      const tagsMatch = frontMatter.match(/^tags:\s*(.+)$/m)
      if (tagsMatch) {
        result.tags = tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      }
    }
    return result
  }
}

export default EmployeeExportPackageService
