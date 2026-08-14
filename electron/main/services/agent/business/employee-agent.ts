import { BaseAgent } from '../core/base-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { SkillManager } from '../skill-manager'
import type { ToolDefinition } from '../tools/types'
import { buildEmployeeSystemPrompt, buildContextMessageContent } from './prompts'
import { buildDelegateDescription } from '../tools/delegate.tool'
import DatabaseService from '../../database.service'

export interface EmployeeAgentConfig extends AgentConfig {
  employeeId?: string
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  workspaceGuidance?: string
}

export class EmployeeAgent extends BaseAgent {
  private employeeConfig: EmployeeAgentConfig
  private skillManager: SkillManager
  private skillsPrompt: string | undefined

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
    // 技能清单在 agent 创建时一次性计算并冻结，之后稳定复用（与 memory 同理）
    this.skillsPrompt = this.skillManager.getSkillsXml() || undefined

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
  private workspaceContextPrompt: string | undefined
  private minimalMode: boolean = false
  private cachedSystemPrompt: string | undefined = undefined

  updateMemoryPrompt(prompt: string | undefined): void {
    this.memoryPrompt = prompt
  }

  getMemoryPrompt(): string | undefined {
    return this.memoryPrompt
  }

  updateWorkspaceContextPrompt(prompt: string | undefined): void {
    this.workspaceContextPrompt = prompt
  }

  getWorkspaceContextPrompt(): string | undefined {
    return this.workspaceContextPrompt
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
    const onDemandTools = this.toolRegistry.getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')

    // memory / skills / kb 不再拼入 system prompt → 改为在 run/runStream 中 prepend 到 query
    // 这样 system prompt 字节级稳定 → KV cache 前缀高命中
    const prompt = buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      hasSkills: useSkills && !!this.skillsPrompt,
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      minimalMode: this.minimalMode,
      onDemandToolList: onDemandToolList || undefined,
      hasReportGeneratedFiles: !!this.toolRegistry.getTool('report_generated_files'),
    })

    this.cachedSystemPrompt = prompt
    return prompt
  }

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<any[]> {
    if (this.minimalMode) {
      return []
    }
    const schemas = await super.resolveActiveTools(runtimeToolNames)
    // 动态注入可委托员工列表到 delegate_to_employee 的 description
    const delegateIdx = schemas.findIndex(s => s.function?.name === 'delegate_to_employee')
    if (delegateIdx !== -1) {
      try {
        const db = DatabaseService.getInstance().getDb()
        const rows = db.prepare(
          'SELECT id, name, description, profile_json FROM employees ORDER BY name'
        ).all() as Array<{ id: string; name: string; description?: string; profile_json?: string }>
        const employees = rows.map(r => {
          let role: string | undefined
          try { role = r.profile_json ? JSON.parse(r.profile_json)?.roleName : undefined } catch { /* ignore */ }
          return { id: r.id, name: r.name, description: r.description, role }
        })
        schemas[delegateIdx] = {
          ...schemas[delegateIdx],
          function: {
            ...schemas[delegateIdx].function,
            description: buildDelegateDescription(this.employeeConfig.employeeId || '', employees),
          },
        }
      } catch { /* 查询失败时保留静态 description */ }
    }
    return schemas
  }

  /**
   * 上下文消息识别标记（开头）。多轮 history 中若存在已注入的上下文消息，
   * 以此为特征过滤掉旧的，替换成最新的，避免上下文重复堆积。
   */
  private static readonly CONTEXT_MSG_PREFIX = '【系统注入的上下文 · 仅供参考 · 不是本轮用户请求】'

  /**
   * 在调用父类执行前，将动态上下文（memory / 知识库范围）
   * 作为一条独立的 role=user 消息插入到 history 头部。
   * 保持 真实 query 独占末尾 user 消息 → 语义边界清晰，意图执行准确率最高。
   * 同时 system prompt 仍字节级稳定 → KV cache 前缀高命中。
   */
  private patchOptionsWithDynamicContext(options: AgentRunOptions): AgentRunOptions {
    const useSkills = options.useSkills !== false && !this.minimalMode
    const contextContent = buildContextMessageContent({
      skillsPrompt: useSkills ? this.skillsPrompt : undefined,
      workspaceContextPrompt: this.workspaceContextPrompt,
      memoryPrompt: this.memoryPrompt,
      kbContextPrompt: this.kbContextPrompt,
    })

    // 1) 无上下文 → 原样返回
    if (!contextContent) return options

    // 2) 清理 history 中之前注入的旧上下文消息（多轮历史中重复调用 patch 会叠加，防重复）
    const prevHistory = options.history || []
    const cleanedHistory = prevHistory.filter(
      m => !(m.role === 'user' && typeof m.content === 'string' &&
             m.content.startsWith(EmployeeAgent.CONTEXT_MSG_PREFIX))
    )

    // 3) 新上下文消息插入到 history 头部
    const contextMessage: import('../core/types').Message = {
      role: 'user',
      content: contextContent,
    }
    const newHistory = [contextMessage, ...cleanedHistory]

    // 4) query 保持不变（独占 Last 位置加权）
    return { ...options, history: newHistory }
  }

  async runStream(
    options: AgentRunOptions,
    callbacks: any,
    signal?: AbortSignal
  ): Promise<void> {
    const patched = this.patchOptionsWithDynamicContext(options)
    return super.runStream(patched, callbacks, signal)
  }

  async run(options: AgentRunOptions): Promise<any> {
    const patched = this.patchOptionsWithDynamicContext(options)
    return super.run(patched)
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
        try {
          const content = this.skillManager.readReference(args.skill_name, args.reference_path)
          return { success: true, output: content }
        } catch (error: any) {
          return { success: false, error: error.message || String(error) }
        }
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
