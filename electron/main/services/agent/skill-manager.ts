import SkillRegistryService from '../skill-registry.service'

interface DiscoveredSkill {
  name: string
  description: string
  instructions: string
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
        references,
      })
    }

    if (this.debugLog) {
      this.debugLog(`[SkillManager] Discovered ${this.discoveredSkills.size} skills`)
    }
  }

  getSkillsXml(): string {
    if (this.discoveredSkills.size === 0) return ''

    const parts: string[] = []
    for (const [name, skill] of this.discoveredSkills) {
      parts.push(`<skill name="${name}">${skill.description}</skill>`)
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

    return skill.instructions
  }

  readReference(skillName: string, referencePath: string): string {
    const skill = this.discoveredSkills.get(skillName)
    if (!skill) {
      throw new Error(`Skill "${skillName}" not found`)
    }

    const content = skill.references.get(referencePath)
    if (!content) {
      throw new Error(`Reference "${referencePath}" not found in skill "${skillName}"`)
    }

    return content
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
