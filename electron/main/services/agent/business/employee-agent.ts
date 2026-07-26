import { BaseAgent } from '../core/base-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { SkillManager } from '../skill-manager'
import type { ToolDefinition } from '../tools/types'
import { buildEmployeeSystemPrompt } from './prompts'

export interface EmployeeAgentConfig extends AgentConfig {
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  workspaceGuidance?: string
}

export class EmployeeAgent extends BaseAgent {
  private employeeConfig: EmployeeAgentConfig
  private skillManager: SkillManager

  constructor(config: EmployeeAgentConfig, options?: BaseAgentOptions) {
    super(config, options)
    this.employeeConfig = this.normalizeEmployeeConfig(config)
    this.skillManager = new SkillManager(
      this.employeeConfig.allowedSkillPaths,
      this.employeeConfig.debug ? this.log.bind(this) : undefined
    )

    if (this.employeeConfig.autoDiscoverSkills) {
      this.skillManager.discoverSkills()
    }

    this.registerSkillTools()
  }

  getSkillManager(): SkillManager {
    return this.skillManager
  }

  getEmployeeConfig(): EmployeeAgentConfig {
    return { ...this.employeeConfig }
  }

  private memoryPrompt: string | undefined
  private kbContextPrompt: string | undefined
  private minimalMode: boolean = false
  private cachedSystemPrompt: string | undefined = undefined

  updateMemoryPrompt(prompt: string | undefined): void {
    this.memoryPrompt = prompt
  }

  getMemoryPrompt(): string | undefined {
    return this.memoryPrompt
  }

  updateKBContextPrompt(prompt: string | undefined): void {
    this.kbContextPrompt = prompt
  }

  setMinimalMode(enabled: boolean): void {
    this.minimalMode = enabled
  }

  getMinimalMode(): boolean {
    return this.minimalMode
  }

  setCachedSystemPrompt(prompt: string | undefined): void {
    this.cachedSystemPrompt = prompt
  }

  getCachedSystemPrompt(): string | undefined {
    return this.cachedSystemPrompt
  }

  protected buildSystemPrompt(options: AgentRunOptions): string {
    if (this.cachedSystemPrompt) {
      return this.cachedSystemPrompt
    }

    const useSkills = options.useSkills !== false
    const skillsXml = useSkills ? this.skillManager.getSkillsXml() : undefined

    const prompt = buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      skillsXml: skillsXml || undefined,
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      memoryPrompt: this.memoryPrompt,
      kbContextPrompt: this.kbContextPrompt,
      minimalMode: this.minimalMode,
    })

    this.cachedSystemPrompt = prompt
    return prompt
  }

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<any[]> {
    if (this.minimalMode) {
      return []
    }
    return super.resolveActiveTools(runtimeToolNames)
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: any,
    signal?: AbortSignal
  ): Promise<void> {
    return super.runStream(options, callbacks, signal)
  }

  async run(options: AgentRunOptions): Promise<any> {
    return super.run(options)
  }

  createSkillTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []

    const activateSkill: ToolDefinition = {
      id: 'activate_skill',
      name: 'activate_skill',
      title: 'Activate Skill',
      description: 'Activate a skill by name to get its full instructions',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'The name of the skill to activate'
          }
        },
        required: ['skill_name']
      },
      handler: (args: any) => {
        try {
          const instructions = this.skillManager.activateSkill(args.skill_name)
          return { success: true, output: instructions }
        } catch (error: any) {
          return { success: false, error: error.message }
        }
      },
      source: 'skill',
      permission: 'safe',
    }
    tools.push(activateSkill)

    const readReference: ToolDefinition = {
      id: 'read_reference',
      name: 'read_reference',
      title: 'Read Reference',
      description: 'Read a reference file from a skill',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'The name of the skill'
          },
          reference_path: {
            type: 'string',
            description: 'The path to the reference file within the skill'
          }
        },
        required: ['skill_name', 'reference_path']
      },
      handler: (args: any) => {
        const content = this.skillManager.readReference(args.skill_name, args.reference_path)
        return { success: true, output: content }
      },
      source: 'skill',
      permission: 'safe',
    }
    tools.push(readReference)

    return tools
  }

  private registerSkillTools(): void {
    const skillTools = this.createSkillTools()
    this.registerTools(skillTools)
  }

  private normalizeEmployeeConfig(config: EmployeeAgentConfig): EmployeeAgentConfig {
    return {
      ...config,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
    }
  }
}
