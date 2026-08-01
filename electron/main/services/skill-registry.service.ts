import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import YAML from 'yaml'
import { execSync } from 'child_process'
import DatabaseService from './database.service'
import PathService from './path.service'
import { generateId } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('SkillRegistry')

// Skill 来源：global（全局 skillsDir）、project（员工工作区 .workavatar/skills/）、bundled（内置）
export type SkillSource = 'global' | 'project' | 'bundled'

// 对齐 agentskills.io 开放标准 + Claude Code/CodeBuddy 扩展字段
export interface ClaudeSkillManifest {
  // 开放标准必填
  name: string
  description: string
  // 开放标准可选
  version?: string
  author?: string
  license?: string
  compatibility?: string
  metadata?: Record<string, any>
  // Claude Code / CodeBuddy 扩展
  tags?: string[]
  tools?: string[] // 旧字段，兼容保留（等同于 allowed-tools）
  allowedTools?: string[] // 空格/逗号分隔的工具白名单
  disableModelInvocation?: boolean // true 时仅手动 /skill-name 触发
  userInvocable?: boolean // false 时从斜杠菜单隐藏，仅供其他 skill 内部调用
  context?: 'inherit' | 'fork' // fork 时在独立 subagent 上下文执行
  agent?: string // 指定 subagent 类型（仅 context: fork）
  hooks?: any[] // skill 专属 hooks（预留）
}

export interface ClaudeSkill {
  id: string
  name: string
  description: string
  version: string
  author: string
  license: string
  compatibility: string
  tags: string[]
  allowedTools: string[]
  metadata: Record<string, any>
  context: 'inherit' | 'fork'
  agent: string
  disableModelInvocation: boolean
  userInvocable: boolean
  source: SkillSource
  installPath: string
  manifest: ClaudeSkillManifest
  skillMdContent: string
  references: Array<{
    name: string
    path: string
    content: string
  }>
  scripts: Array<{
    name: string
    path: string
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

// 校验 skill name：1-64 字符，仅小写字母/数字/连字符（对齐开放标准）
const SKILL_NAME_REGEX = /^[a-z0-9-]{1,64}$/

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillValidationError'
  }
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
    // 启动时同步内置（bundled）Skills：resources/skills/* → DB
    this.syncBundledSkills().catch((err) => logger.warn('sync bundled skills failed:', err?.message || err))
  }

  /** 同步内置（bundled）Skills：resources/skills 目录下每个子目录视为一个 skill */
  private async syncBundledSkills(): Promise<void> {
    const resourcesDir = PathService.getInstance().getResourcesDir()
    const bundledRoot = path.join(resourcesDir, 'skills')
    if (!fs.existsSync(bundledRoot)) return
    const entries = fs.readdirSync(bundledRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillDir = path.join(bundledRoot, entry.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue
      try {
        await this.installFromDirectory(skillDir, 'bundled')
      } catch (err: any) {
        logger.warn(`sync bundled skill ${entry.name} failed:`, err?.message || err)
      }
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

  async installFromDirectory(sourceDir: string, source: SkillSource = 'global'): Promise<InstallSkillResult> {
    try {
      const skillMdPath = path.join(sourceDir, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) {
        return { success: false, error: '目录中未找到 SKILL.md 文件，不符合 Skills 开放标准格式' }
      }

      const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')
      const manifest = this.parseSkillMd(skillMdContent)

      // 校验：name 合法、与目录名一致、description 非空
      const dirName = path.basename(sourceDir)
      // 目录名可能是临时目录（_temp_xxx），仅在目录名本身像 skill name 时才校验一致性
      if (SKILL_NAME_REGEX.test(dirName)) {
        this.validateManifest(manifest, dirName)
      } else {
        this.validateManifest(manifest)
      }

      // bundled 来源：不复制目录，installPath 直接指向只读 resources 目录，id 不附加随机后缀（稳定）
      // 非 bundled：复制目录到 skillsDir，id 带随机后缀
      const isBundled = source === 'bundled'
      const skillId = isBundled
        ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : this.generateSkillId(manifest.name)
      const installPath = isBundled
        ? sourceDir
        : path.join(this.skillsDir, skillId)

      if (!isBundled) {
        if (fs.existsSync(installPath)) {
          fs.rmSync(installPath, { recursive: true })
        }
        this.copyDirectory(sourceDir, installPath)
      } else {
        // bundled：先按 name+source 删除旧记录，避免 id 变化导致重复
        const db = this.db.getDb()
        db.prepare("DELETE FROM installed_skills WHERE source='bundled' AND name = ?").run(manifest.name)
      }

      const references = this.loadReferences(installPath)
      const scripts = this.loadScripts(installPath)

      const skill: ClaudeSkill = {
        id: skillId,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version || '1.0.0',
        author: manifest.author || 'Unknown',
        license: manifest.license || '',
        compatibility: manifest.compatibility || '',
        tags: manifest.tags || [],
        allowedTools: manifest.allowedTools || [],
        metadata: manifest.metadata || {},
        context: manifest.context || 'inherit',
        agent: manifest.agent || '',
        disableModelInvocation: manifest.disableModelInvocation || false,
        userInvocable: manifest.userInvocable !== false,
        source,
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

  // 从 SKILL.md 内容中分离 frontmatter 与正文
  private splitFrontMatter(content: string): { frontMatter: Record<string, any> | null; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) {
      return { frontMatter: null, body: content }
    }
    try {
      const frontMatter = YAML.parse(match[1]) as Record<string, any> | null
      return { frontMatter: frontMatter || {}, body: match[2] }
    } catch (err: any) {
      logger.warn('Failed to parse SKILL.md frontmatter as YAML:', err?.message || err)
      return { frontMatter: null, body: content }
    }
  }

  // 把字段值统一转为字符串数组（兼容 "a, b, c"、"a b c"、YAML 列表三种写法）
  private toStringArray(value: any): string[] {
    if (!value) return []
    if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
    if (typeof value === 'string') {
      // 兼容逗号分隔与空格分隔
      return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
    }
    return [String(value)]
  }

  parseSkillMd(content: string): ClaudeSkillManifest {
    const { frontMatter } = this.splitFrontMatter(content)

    const manifest: ClaudeSkillManifest = {
      name: '',
      description: '',
      version: '1.0.0',
      author: '',
      license: '',
      compatibility: '',
      metadata: {},
      tags: [],
      tools: [],
      allowedTools: [],
      disableModelInvocation: false,
      userInvocable: true,
      context: 'inherit',
      agent: '',
      hooks: [],
    }

    if (frontMatter) {
      // 兼容旧字段名 tools 与新字段 allowed-tools
      const allowedTools = this.toStringArray(frontMatter['allowed-tools'] ?? frontMatter.allowedTools)
      const tools = this.toStringArray(frontMatter.tools)
      manifest.name = String(frontMatter.name ?? '').trim()
      manifest.description = String(frontMatter.description ?? '').trim()
      manifest.version = frontMatter.version ? String(frontMatter.version).trim() : '1.0.0'
      manifest.author = frontMatter.author ? String(frontMatter.author).trim() : ''
      manifest.license = frontMatter.license ? String(frontMatter.license).trim() : ''
      manifest.compatibility = frontMatter.compatibility ? String(frontMatter.compatibility).trim() : ''
      manifest.metadata = (frontMatter.metadata && typeof frontMatter.metadata === 'object') ? frontMatter.metadata : {}
      manifest.tags = this.toStringArray(frontMatter.tags)
      manifest.tools = tools
      manifest.allowedTools = allowedTools.length > 0 ? allowedTools : tools
      manifest.disableModelInvocation = frontMatter['disable-model-invocation'] === true || frontMatter.disableModelInvocation === true
      manifest.userInvocable = frontMatter['user-invocable'] !== false && frontMatter.userInvocable !== false
      const ctx = frontMatter.context
      manifest.context = ctx === 'fork' ? 'fork' : 'inherit'
      manifest.agent = frontMatter.agent ? String(frontMatter.agent).trim() : ''
      manifest.hooks = Array.isArray(frontMatter.hooks) ? frontMatter.hooks : []
    }

    // name 缺失时从一级标题回退
    if (!manifest.name) {
      const titleMatch = content.match(/^#\s+(.+)$/m)
      if (titleMatch) {
        manifest.name = titleMatch[1].trim()
      }
    }

    // description 缺失时从正文首段回退
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

  // 校验 manifest 必填字段（对齐开放标准）
  validateManifest(manifest: ClaudeSkillManifest, dirName?: string): void {
    if (!manifest.name) {
      throw new SkillValidationError('SKILL.md 缺少 name 字段')
    }
    if (!SKILL_NAME_REGEX.test(manifest.name)) {
      throw new SkillValidationError(`skill name "${manifest.name}" 不合法，需为 1-64 字符的小写字母/数字/连字符`)
    }
    if (dirName && manifest.name !== dirName) {
      throw new SkillValidationError(`skill name "${manifest.name}" 与目录名 "${dirName}" 不一致`)
    }
    if (!manifest.description) {
      throw new SkillValidationError('SKILL.md 缺少 description 字段')
    }
    if (manifest.description.length > 1024) {
      throw new SkillValidationError(`description 过长（${manifest.description.length} > 1024 字符）`)
    }
  }

  private loadReferences(skillDir: string): Array<{ name: string; path: string; content: string }> {
    const refsDir = path.join(skillDir, 'references')
    const refs: Array<{ name: string; path: string; content: string }> = []

    if (!fs.existsSync(refsDir)) return refs

    const files = fs.readdirSync(refsDir)
    for (const file of files) {
      const filePath = path.join(refsDir, file)
      if (fs.statSync(filePath).isFile()) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          refs.push({ name: file, path: filePath, content })
        } catch (err: any) {
          logger.warn(`Failed to read skill reference file ${file}:`, err?.message || err)
        }
      }
    }

    return refs
  }

  private loadScripts(skillDir: string): Array<{ name: string; path: string; content: string }> {
    const scriptsDir = path.join(skillDir, 'scripts')
    const scripts: Array<{ name: string; path: string; content: string }> = []

    if (!fs.existsSync(scriptsDir)) return scripts

    const files = fs.readdirSync(scriptsDir)
    for (const file of files) {
      const filePath = path.join(scriptsDir, file)
      if (fs.statSync(filePath).isFile()) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8')
          scripts.push({ name: file, path: filePath, content })
        } catch (err: any) {
          logger.warn(`Failed to read skill script file ${file}:`, err?.message || err)
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
        id, name, description, version, author, tags_json, install_path, manifest_json, skill_md_content,
        license, compatibility, allowed_tools_json, metadata_json, context, agent, source,
        disable_model_invocation, user_invocable, hooks_json, is_enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      skill.license || '',
      skill.compatibility || '',
      JSON.stringify(skill.allowedTools || []),
      JSON.stringify(skill.metadata || {}),
      skill.context || 'inherit',
      skill.agent || '',
      skill.source || 'global',
      skill.disableModelInvocation ? 1 : 0,
      skill.userInvocable !== false ? 1 : 0,
      JSON.stringify(skill.manifest.hooks || []),
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
    const manifest = JSON.parse(row.manifest_json || '{}')
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      author: row.author,
      license: row.license || '',
      compatibility: row.compatibility || '',
      tags: JSON.parse(row.tags_json || '[]'),
      allowedTools: JSON.parse(row.allowed_tools_json || '[]'),
      metadata: JSON.parse(row.metadata_json || '{}'),
      context: (row.context === 'fork' ? 'fork' : 'inherit') as 'inherit' | 'fork',
      agent: row.agent || '',
      source: (['global', 'project', 'bundled'].includes(row.source) ? row.source : 'global') as SkillSource,
      disableModelInvocation: row.disable_model_invocation === 1,
      userInvocable: row.user_invocable !== 0,
      installPath,
      manifest,
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
      // bundled 来源的 skill 目录在只读 resources/ 下，不可删除；仅删除 DB 记录（下次启动会自动重装）
      if (skill && skill.source !== 'bundled' && fs.existsSync(skill.installPath)) {
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

  // 返回 SKILL.md 去掉 frontmatter 后的正文（用于渐进披露第 2 层）
  getSkillBody(skillId: string): string {
    const skill = this.getSkillById(skillId)
    if (!skill) return ''
    const { body } = this.splitFrontMatter(skill.skillMdContent)
    return body.trim()
  }

  // 渲染 skill 正文：替换 $ARGUMENTS/$1/$2...，执行 !`cmd` 动态注入，追加 references 路径提示
  // 用于 skill 工具 handler 返回给 agent 的最终内容
  renderSkillBody(skillId: string, args?: string): string {
    const skill = this.getSkillById(skillId)
    if (!skill) return ''
    let body = this.getSkillBody(skillId)

    // $ARGUMENTS 与位置参数替换
    if (args) {
      body = body.replace(/\$ARGUMENTS/g, args)
      const parts = args.split(/\s+/).filter(Boolean)
      body = body.replace(/\$(\d+)/g, (_, n) => parts[parseInt(n) - 1] || '')
    } else {
      // 无参数时移除 $ARGUMENTS 占位符
      body = body.replace(/\$ARGUMENTS/g, '').replace(/\$\d+/g, '')
    }

    // !`cmd` 动态注入：仅当 allowedTools 显式包含 shell_exec / Bash 时启用
    const allowShell = (skill.allowedTools || []).some((t) =>
      /^(shell_exec|Bash|bash|sh)$/i.test(t.trim())
    )
    if (allowShell) {
      body = body.replace(/!`([^`]+)`/g, (_, cmd) => {
        try {
          const output = execSync(cmd, {
            encoding: 'utf-8',
            timeout: 5000,
            maxBuffer: 100 * 1024,
            cwd: path.dirname(skill.installPath),
          })
          return output.trim().substring(0, 2000)
        } catch (err: any) {
          return `[cmd error: ${err?.message || err}]`
        }
      })
    }

    // 追加 references 路径提示，引导 agent 用 file_read 按需读取（第 3 层渐进披露）
    if (skill.references.length > 0) {
      body += '\n\n## 可用参考资料（按需用 file_read 工具读取）\n'
      for (const ref of skill.references) {
        body += `- ${ref.name}: \`${ref.path}\`\n`
      }
    }
    // 追加 scripts 路径提示（Phase 3 run_skill_script 工具会用）
    if (skill.scripts.length > 0) {
      body += '\n## 可用脚本（按需用 run_skill_script 工具执行）\n'
      for (const script of skill.scripts) {
        body += `- ${script.name}: \`${script.path}\`\n`
      }
    }

    return body
  }

  // 旧接口保留兼容：返回 name + 全文 + references 拼接
  // 推荐新代码使用 getSkillBody（Phase 2 渐进披露）
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

  // 项目级 skills 缓存：key=目录路径，value={mtime, skills}
  // 项目级 skill 不入库，in-place 读取，按目录 mtime 失效
  private projectSkillsCache = new Map<string, { mtime: number; skills: ClaudeSkill[] }>()

  // 简单稳定 hash，用于生成项目级 skill 的稳定 id（避免每次扫描 id 变化导致 agent 缓存失效）
  private stableHash(input: string): string {
    let hash = 0
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(36)
  }

  // 扫描员工工作区 .workavatar/skills/ 下的项目级 skills（不入库，in-place 读取）
  scanProjectSkills(workspacePath: string): ClaudeSkill[] {
    if (!workspacePath) return []
    const projectSkillsDir = path.join(workspacePath, '.workavatar', 'skills')
    if (!fs.existsSync(projectSkillsDir)) return []

    let dirStat: fs.Stats
    try {
      dirStat = fs.statSync(projectSkillsDir)
    } catch {
      return []
    }

    // 缓存命中：目录 mtime 未变则直接返回
    const cached = this.projectSkillsCache.get(projectSkillsDir)
    if (cached && cached.mtime === dirStat.mtimeMs) return cached.skills

    const skills: ClaudeSkill[] = []
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(projectSkillsDir, { withFileTypes: true })
    } catch {
      return []
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // 跳过隐藏目录
      if (entry.name.startsWith('.')) continue

      const skillDir = path.join(projectSkillsDir, entry.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      try {
        const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8')
        const manifest = this.parseSkillMd(skillMdContent)
        // 项目级 skill 强制要求 name 与目录名一致
        this.validateManifest(manifest, entry.name)

        const sanitizedName = manifest.name.replace(/[^a-z0-9-]/g, '')
        const skillId = `proj_${sanitizedName}_${this.stableHash(skillDir)}`
        const references = this.loadReferences(skillDir)
        const scripts = this.loadScripts(skillDir)

        skills.push({
          id: skillId,
          name: manifest.name,
          description: manifest.description,
          version: manifest.version || '1.0.0',
          author: manifest.author || 'Unknown',
          license: manifest.license || '',
          compatibility: manifest.compatibility || '',
          tags: manifest.tags || [],
          allowedTools: manifest.allowedTools || [],
          metadata: manifest.metadata || {},
          context: manifest.context || 'inherit',
          agent: manifest.agent || '',
          disableModelInvocation: manifest.disableModelInvocation || false,
          userInvocable: manifest.userInvocable !== false,
          source: 'project',
          installPath: skillDir,
          manifest,
          skillMdContent,
          references,
          scripts,
          is_enabled: true, // 项目级默认启用
          created_at: dirStat.mtimeMs,
        })
      } catch (err: any) {
        logger.warn(`Failed to load project skill "${entry.name}": ${err?.message || err}`)
      }
    }

    this.projectSkillsCache.set(projectSkillsDir, { mtime: dirStat.mtimeMs, skills })
    return skills
  }

  getEmployeeSkills(employeeId: string): { enabled: ClaudeSkill[]; disabled: ClaudeSkill[] } {
    const db = this.db.getDb()
    const allSkills = this.getInstalledSkills()

    // 查员工 workspace_path，扫描项目级 skills
    const employee = db.prepare('SELECT workspace_path FROM employees WHERE id = ?').get(employeeId) as
      | { workspace_path?: string }
      | undefined
    const projectSkills = employee?.workspace_path
      ? this.scanProjectSkills(employee.workspace_path)
      : []

    // 合并：项目级 skill 优先（同名覆盖全局）
    const mergedSkills = [...allSkills]
    for (const projSkill of projectSkills) {
      const sameNameGlobalIdx = mergedSkills.findIndex(
        (s) => s.name === projSkill.name && s.source !== 'project'
      )
      if (sameNameGlobalIdx >= 0) {
        mergedSkills[sameNameGlobalIdx] = projSkill
      } else {
        mergedSkills.push(projSkill)
      }
    }

    const employeeRows = db.prepare(
      'SELECT skill_id, is_enabled FROM employee_skills WHERE employee_id = ?'
    ).all(employeeId) as any[]

    const skillStateMap = new Map<string, boolean>()
    for (const row of employeeRows) {
      skillStateMap.set(row.skill_id, row.is_enabled === 1)
    }

    return {
      enabled: mergedSkills.filter((s) => s.source === 'project' || skillStateMap.get(s.id) === true),
      disabled: mergedSkills.filter((s) => s.source !== 'project' && skillStateMap.get(s.id) !== true),
    }
  }
}

export default SkillRegistryService
