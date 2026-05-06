export interface Skill {
  name: string
  description: string
  path: string
  instructions: string
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  isEnabled: boolean
}

export interface SkillManifest {
  name: string
  description: string
  version?: string
  author?: string
  tags?: string[]
  tools?: string[]
  mcpServers?: string[]
  requires?: {
    bins?: string[]
    env?: string[]
  }
  metadata?: Record<string, any>
  always?: boolean
}
