import fs from 'fs'
import path from 'path'
import SkillRegistryService from '../skill-registry.service'

interface DiscoveredSkill {
  name: string
  description: string
  instructions: string
  references: Map<string, string>
}

export class SkillManager {
  private skillsDirectories: string[]
  private allowedSkillPaths: string[] | undefined
  private debugLog: ((...args: any[]) => void) | undefined
  private discoveredSkills: Map<string, DiscoveredSkill> = new Map()
  private activeSkills: Set<string> = new Set()

  constructor(
    skillsDirectories: string[],
    allowedSkillPaths?: string[],
    debugLog?: (...args: any[]) => void
  ) {
    this.skillsDirectories = skillsDirectories
    this.allowedSkillPaths = allowedSkillPaths
    this.debugLog = debugLog
  }

  discoverSkills(): void {
    this.discoveredSkills.clear()

    const registry = SkillRegistryService.getInstance()
    const installedSkills = registry.getInstalledSkills()

    for (const skill of installedSkills) {
      if (!skill.is_enabled) continue
      if (this.allowedSkillPaths && !this.allowedSkillPaths.includes(skill.installPath)) continue

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

    for (const dir of this.skillsDirectories) {
      this.discoverFromDirectory(dir)
    }

    if (this.debugLog) {
      this.debugLog(`[SkillManager] Discovered ${this.discoveredSkills.size} skills`)
    }
  }

  private discoverFromDirectory(dir: string): void {
    if (!fs.existsSync(dir)) return

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(dir, entry.name)
        const skillMdPath = path.join(skillDir, 'SKILL.md')

        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, 'utf-8')
          const { name, description } = this.parseSkillMd(content)

          if (name && !this.discoveredSkills.has(name)) {
            const references = new Map<string, string>()
            const refsDir = path.join(skillDir, 'references')
            if (fs.existsSync(refsDir)) {
              const refFiles = fs.readdirSync(refsDir)
              for (const refFile of refFiles) {
                const refPath = path.join(refsDir, refFile)
                if (fs.statSync(refPath).isFile()) {
                  references.set(refFile, fs.readFileSync(refPath, 'utf-8'))
                }
              }
            }

            this.discoveredSkills.set(name, {
              name,
              description,
              instructions: content,
              references,
            })
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  private parseSkillMd(content: string): { name: string; description: string } {
    let name = ''
    let description = ''

    const titleMatch = content.match(/^#\s+(.+)$/m)
    if (titleMatch) {
      name = titleMatch[1].trim()
    }

    const descPatterns = [
      /^#\s+.+\n\n(.+?)(?:\n\n|\n#{1,6}\s|$)/ms,
      /^#\s+.+\n(.+?)(?:\n\n|\n#{1,6}\s|$)/ms,
    ]
    for (const pattern of descPatterns) {
      const descMatch = content.match(pattern)
      if (descMatch) {
        const desc = descMatch[1].trim()
        if (desc.length >= 5) {
          description = desc
          break
        }
      }
    }

    return { name, description }
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
