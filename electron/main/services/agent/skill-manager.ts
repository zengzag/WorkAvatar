import path from 'path'
import fs from 'fs'
import yaml from 'js-yaml'
import { Skill, SkillManifest } from './skill.types'

const FRONTMATTER_REGEX = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/

export class SkillManager {
  private skillsDirectories: string[]
  private skills: Map<string, Skill> = new Map()
  private logger?: (level: string, action: string, data: any) => void

  constructor(skillsDirectories?: string[], logger?: (level: string, action: string, data: any) => void) {
    this.skillsDirectories = skillsDirectories || ['skills']
    this.logger = logger
  }

  discoverSkills(): Skill[] {
    const discovered: Skill[] = []

    for (const baseDir of this.skillsDirectories) {
      if (!fs.existsSync(baseDir)) {
        continue
      }

      const entries = fs.readdirSync(baseDir, { withFileTypes: true })
      
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }

        const skillPath = path.join(baseDir, entry.name)
        const skillFile = path.join(skillPath, 'SKILL.md')

        if (!fs.existsSync(skillFile)) {
          continue
        }

        try {
          const skill = this.loadSkillMetadata(skillPath)
          if (skill) {
            this.skills.set(skill.name, skill)
            discovered.push(skill)
            this.log('debug', 'discover_skill', { name: skill.name, path: skillPath })
          }
        } catch (error) {
          this.log('error', 'discover_skill_failed', { path: skillPath, error: String(error) })
        }
      }
    }

    return discovered
  }

  getSkills(): Skill[] {
    return Array.from(this.skills.values())
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  activateSkill(name: string): string {
    const skill = this.skills.get(name)
    if (!skill) {
      throw new Error(`Skill "${name}" not found`)
    }

    const skillFile = path.join(skill.path, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      throw new Error(`Skill file not found at ${skillFile}`)
    }

    let content = fs.readFileSync(skillFile, 'utf-8')
    
    content = content.replace(FRONTMATTER_REGEX, '')
    skill.instructions = content.trim()

    this.log('info', 'activate_skill', { name })
    return skill.instructions
  }

  getSkillsXml(): string {
    if (this.skills.size === 0) {
      return ''
    }

    const parts: string[] = ['<available_skills>']

    for (const skill of this.skills.values()) {
      parts.push(`  <skill>`)
      parts.push(`    <name>${skill.name}</name>`)
      parts.push(`    <description>${skill.description}</description>`)
      parts.push(`    <location>${path.join(skill.path, 'SKILL.md')}</location>`)
      parts.push(`  </skill>`)
    }

    parts.push('</available_skills>')
    return parts.join('\n')
  }

  executeScript(skillName: string, scriptName: string, args?: string[]): string {
    const skill = this.skills.get(skillName)
    if (!skill) {
      return `Error: Skill "${skillName}" not found`
    }

    const scriptPath = path.join(skill.path, 'scripts', scriptName)
    if (!fs.existsSync(scriptPath)) {
      return `Error: Script "${scriptName}" not found in skill "${skillName}"`
    }

    if (!scriptPath.startsWith(path.join(skill.path, 'scripts'))) {
      return 'Error: Security violation - cannot execute outside scripts directory'
    }

    try {
      const { spawnSync } = require('child_process')
      const result = spawnSync(scriptPath, args || [], {
        cwd: require('os').tmpdir(),
        timeout: 30000,
        encoding: 'utf-8'
      })

      let output = result.stdout || ''
      if (result.stderr) {
        output += `\nSTDERR:\n${result.stderr}`
      }

      this.log('debug', 'execute_script', { skill: skillName, script: scriptName, output: output.substring(0, 200) })
      return output
    } catch (error: any) {
      return `Error executing script: ${error.message}`
    }
  }

  readReference(skillName: string, refPath: string): string {
    const skill = this.skills.get(skillName)
    if (!skill) {
      return `Error: Skill "${skillName}" not found`
    }

    const fullPath = path.join(skill.path, 'references', refPath)
    
    if (!fullPath.startsWith(path.join(skill.path, 'references'))) {
      return 'Error: Security violation - invalid reference path'
    }

    if (!fs.existsSync(fullPath)) {
      return `Error: Reference "${refPath}" not found`
    }

    try {
      return fs.readFileSync(fullPath, 'utf-8')
    } catch (error: any) {
      return `Error reading reference: ${error.message}`
    }
  }

  readAsset(skillName: string, assetPath: string): Buffer | null {
    const skill = this.skills.get(skillName)
    if (!skill) {
      throw new Error(`Skill "${skillName}" not found`)
    }

    const fullPath = path.join(skill.path, 'assets', assetPath)
    
    if (!fullPath.startsWith(path.join(skill.path, 'assets'))) {
      throw new Error('Security violation: invalid asset path')
    }

    if (!fs.existsSync(fullPath)) {
      return null
    }

    return fs.readFileSync(fullPath)
  }

  getAlwaysSkills(): Skill[] {
    return this.getSkills().filter(skill => {
      const manifest = this.parseSkillManifest(skill.path)
      return manifest?.always === true
    })
  }

  private loadSkillMetadata(skillPath: string): Skill | null {
    const manifest = this.parseSkillManifest(skillPath)
    if (!manifest) {
      return null
    }

    const scriptsDir = path.join(skillPath, 'scripts')
    const refsDir = path.join(skillPath, 'references')
    const assetsDir = path.join(skillPath, 'assets')

    return {
      name: manifest.name,
      description: manifest.description,
      path: skillPath,
      instructions: '',
      hasScripts: fs.existsSync(scriptsDir),
      hasReferences: fs.existsSync(refsDir),
      hasAssets: fs.existsSync(assetsDir),
      isEnabled: true
    }
  }

  private parseSkillManifest(skillPath: string): SkillManifest | null {
    const skillFile = path.join(skillPath, 'SKILL.md')
    if (!fs.existsSync(skillFile)) {
      return null
    }

    const content = fs.readFileSync(skillFile, 'utf-8')
    const match = content.match(FRONTMATTER_REGEX)
    
    if (!match) {
      return null
    }

    try {
      const frontmatter = yaml.load(match[1]) as any
      
      return {
        name: frontmatter.name || path.basename(skillPath),
        description: frontmatter.description || '',
        version: frontmatter.version,
        author: frontmatter.author,
        tags: frontmatter.tags,
        tools: frontmatter.tools,
        mcpServers: frontmatter.mcp_servers,
        requires: frontmatter.requires,
        metadata: frontmatter.metadata,
        always: frontmatter.always
      }
    } catch {
      return null
    }
  }

  private log(level: string, action: string, data: any): void {
    if (this.logger) {
      this.logger(level, action, data)
    }
  }
}
