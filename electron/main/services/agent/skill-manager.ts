import path from 'path'
import fs from 'fs'
import SkillRegistryService from '../skill-registry.service'

interface DiscoveredSkill {
  name: string
  description: string
  instructions: string
  /** 技能根目录（绝对路径），用于解析 SKILL.md 中的相对路径引用 */
  skillDir: string
  references: Map<string, string>
}

export class SkillManager {
  private allowedSkillPaths: string[] | undefined
  private debugLog: ((...args: any[]) => void) | undefined
  private discoveredSkills: Map<string, DiscoveredSkill> = new Map()
  private activeSkills: Set<string> = new Set()

  constructor(
    allowedSkillPaths?: string[],
    debugLog?: (...args: any[]) => void
  ) {
    this.allowedSkillPaths = allowedSkillPaths
    this.debugLog = debugLog
  }

  discoverSkills(): void {
    this.discoveredSkills.clear()

    const registry = SkillRegistryService.getInstance()
    const installedSkills = registry.getInstalledSkills()

    for (const skill of installedSkills) {
      if (!skill.is_enabled) continue
      if (this.allowedSkillPaths !== undefined && !this.allowedSkillPaths.includes(skill.installPath)) continue

      const references = new Map<string, string>()
      for (const ref of skill.references) {
        references.set(ref.name, ref.content)
      }

      this.discoveredSkills.set(skill.name, {
        name: skill.name,
        description: skill.description,
        instructions: skill.skillMdContent,
        skillDir: skill.installPath,
        references,
      })
    }

    if (this.debugLog) {
      this.debugLog(`[SkillManager] Discovered ${this.discoveredSkills.size} skills`)
    }
  }

  getSkillsXml(): string {
    if (this.discoveredSkills.size === 0) return ''

    const escapeXml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    const parts: string[] = []
    // 技能清单进入稳定上下文头：按名称排序，保证跨 agent 重建时字节一致
    const skills = [...this.discoveredSkills.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const skill of skills) {
      parts.push(`<skill name="${escapeXml(skill.name)}">${escapeXml(skill.description)}</skill>`)
    }

    return `<skills>\n${parts.join('\n')}\n</skills>`
  }

  activateSkill(name: string): string {
    const skill = this.discoveredSkills.get(name)
    if (!skill) {
      throw new Error(`Skill "${name}" not found`)
    }

    this.activeSkills.add(name)

    if (this.debugLog) {
      this.debugLog(`[SkillManager] Activated skill: ${name}`)
    }

    return this.renderInstructions(skill)
  }

  /**
   * 注入技能根目录绝对路径，并把文中 `skills/<技能名>/…`（技能包原本按仓库根书写的形式）
   * 改写为绝对路径，避免 agent 把相对路径解析到工作区导致读取失败。
   */
  private renderInstructions(skill: DiscoveredSkill): string {
    if (!skill.skillDir) return skill.instructions
    const root = this.skillRoot(skill)
    const lines = [
      this.mapSkillPaths(skill, skill.instructions),
      '',
      '## 技能路径信息',
      `- 技能根目录（绝对路径）: \`${root}\``,
      `- SKILL.md 中的相对路径（如 \`prompts/x.md\`、\`references/x.yaml\`、\`tools/x.py\`、\`scripts/x\`）均相对该目录。`,
      `- 读取文件用 read_reference(skill_name="${skill.name}", reference_path=相对路径)，也可用 file_read 读上面的绝对路径；执行脚本用 shell_exec 拼上述绝对路径。`,
    ]
    return lines.join('\n')
  }

  private skillRoot(skill: DiscoveredSkill): string {
    return skill.skillDir.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  /** `skills/<技能名>/` 是技能包的仓库根写法，统一改写为技能根目录绝对路径 */
  private mapSkillPaths(skill: DiscoveredSkill, text: string): string {
    if (!skill.skillDir) return text
    return text.split(`skills/${skill.name}/`).join(`${this.skillRoot(skill)}/`)
  }

  /** 在技能目录内读取相对路径文件（限制在根目录内，防目录穿越） */
  private readSkillFile(skill: DiscoveredSkill, relPaths: string[]): string | null {
    if (!skill.skillDir) return null
    const root = path.resolve(skill.skillDir)
    for (const rel of relPaths) {
      try {
        const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(root, rel)
        const relative = path.relative(root, abs)
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          return fs.readFileSync(abs, 'utf-8')
        }
      } catch {
        // 读取失败按未命中处理，继续尝试下一个候选
      }
    }
    return null
  }

  readReference(skillName: string, referencePath: string): string {
    const skill = this.discoveredSkills.get(skillName)
    if (!skill) {
      throw new Error(`Skill "${skillName}" not found`)
    }

    // 容错匹配：LLM 可能传入 references/xxx.md、xxx.md、完整路径或带大小写差异
    const availableNames = [...skill.references.keys()]
    const normalized = referencePath.replace(/\\/g, '/').replace(/^\.?\//, '')
    const basename = normalized.split('/').pop() || normalized

    // 1. 精确匹配（用 != null 判定：参考文件内容可能为空串，空串也是有效命中）
    let content: string | null | undefined = skill.references.get(referencePath)
    // 2. 去掉开头的 ./ 或 / 后匹配
    if (content == null) content = skill.references.get(normalized)
    // 3. 仅用文件名匹配（兼容 LLM 传入 references/xxx.md 的情况）
    if (content == null) content = skill.references.get(basename)
    // 4. 大小写不敏感匹配
    if (content == null) {
      const lower = basename.toLowerCase()
      const hit = availableNames.find(n => n.toLowerCase() === lower)
      if (hit) content = skill.references.get(hit)
    }
    // 5. 技能目录内按相对路径读取（覆盖 references 子目录、prompts/、tools/ 等未预加载的文件）
    if (content == null) {
      const packagePrefix = `skills/${skillName}/`
      const stripped = normalized.startsWith(packagePrefix) ? normalized.slice(packagePrefix.length) : normalized
      const candidates = [normalized, stripped, `references/${stripped}`, `references/${basename}`]
      content = this.readSkillFile(skill, [...new Set(candidates)])
    }

    if (content == null) {
      const list = availableNames.length > 0
        ? availableNames.map(n => `- ${n}`).join('\n')
        : '(无参考文件)'
      throw new Error(
        `Reference "${referencePath}" not found in skill "${skillName}".\n` +
        `可用参考文件：\n${list}\n` +
        (skill.skillDir
          ? `也可传入相对技能根目录的路径（根目录：${skill.skillDir}），例如 prompts/xxx.md、references/schemas/xxx.yaml、tools/xxx.py。`
          : '')
      )
    }

    return this.mapSkillPaths(skill, content)
  }

  getActiveSkillInstructions(): string[] {
    const instructions: string[] = []
    for (const name of this.activeSkills) {
      const skill = this.discoveredSkills.get(name)
      if (skill) {
        instructions.push(skill.instructions)
      }
    }
    return instructions
  }
}
