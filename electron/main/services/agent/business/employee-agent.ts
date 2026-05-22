import { BaseAgent } from '../core/base-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { SkillManager } from '../skill-manager'
import type { ToolDefinition } from '../tools/types'
import { PlannerFactory } from '../planning/planner'
import type { PlanningStrategy } from '../planning/types'
import { buildEmployeeSystemPrompt, KNOWLEDGE_QUERY_GUIDANCE } from './prompts'

export interface EmployeeAgentConfig extends AgentConfig {
  treeOfThought?: boolean
  filterTools?: boolean
  totModel?: string
  totApiKey?: string
  totBaseUrl?: string
  totProviderType?: string
  skillsDirectories?: string[]
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  selfLearning?: boolean
  planningStrategy?: PlanningStrategy
  knowledgeGuidance?: string
  workspaceGuidance?: string
  memoryPrompt?: string
}

export class EmployeeAgent extends BaseAgent {
  private employeeConfig: EmployeeAgentConfig
  private skillManager: SkillManager

  constructor(config: EmployeeAgentConfig, options?: BaseAgentOptions) {
    super(config, options)
    this.employeeConfig = this.normalizeEmployeeConfig(config)
    this.skillManager = new SkillManager(
      this.employeeConfig.skillsDirectories || [],
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

  updateMemoryPrompt(prompt: string | undefined): void {
    this.employeeConfig.memoryPrompt = prompt
  }

  protected buildSystemPrompt(options: AgentRunOptions): string {
    const useSkills = options.useSkills !== false
    const skillsXml = useSkills ? this.skillManager.getSkillsXml() : undefined

    return buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      skillsXml: skillsXml || undefined,
      activeSkillInstructions: this.getActiveSkillInstructions(),
      knowledgeGuidance: this.employeeConfig.knowledgeGuidance,
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      memoryPrompt: this.employeeConfig.memoryPrompt,
    })
  }

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<any[]> {
    if (this.employeeConfig.treeOfThought || this.employeeConfig.planningStrategy) {
      const strategy = this.employeeConfig.planningStrategy || 'tool_filter'
      const planner = PlannerFactory.create(
        strategy,
        this.getLLMProvider(),
        this.employeeConfig.totModel ? {
          model: this.employeeConfig.totModel,
          apiKey: this.employeeConfig.totApiKey,
          baseUrl: this.employeeConfig.totBaseUrl,
          providerType: this.employeeConfig.totProviderType,
        } : undefined
      )

      const allTools = this.getToolRegistry().getOpenAISchemas()
      const plan = await planner.plan(
        this.getContext().getMetadata('currentQuery') || '',
        allTools
      )

      this.getEventEmitter().emit('plan:generated', plan)

      if (plan.selectedToolNames && plan.selectedToolNames.length > 0) {
        return this.getToolRegistry().getOpenAISchemasByNames(plan.selectedToolNames)
      }
    }

    return super.resolveActiveTools(runtimeToolNames)
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: any,
    signal?: AbortSignal
  ): Promise<void> {
    this.getContext().setMetadata('currentQuery', options.query)
    return super.runStream(options, callbacks, signal)
  }

  async run(options: AgentRunOptions): Promise<any> {
    this.getContext().setMetadata('currentQuery', options.query)
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
          return { success: true, instructions }
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
        return { content }
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
      treeOfThought: config.treeOfThought || false,
      filterTools: config.filterTools !== false,
      selfLearning: config.selfLearning || false,
      skillsDirectories: config.skillsDirectories || ['skills'],
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
      knowledgeGuidance: config.knowledgeGuidance ?? `\n\n${KNOWLEDGE_QUERY_GUIDANCE}`,
    }
  }
}
