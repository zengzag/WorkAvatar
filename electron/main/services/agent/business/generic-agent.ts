import { BaseAgent } from '../core/base-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { SkillManager } from '../skill-manager'
import type { ToolDefinition, OpenAIToolDefinition } from '../tools/types'
import { createListAvailableToolsTool, createInvokeToolTool } from '../tools/meta-tools'
import { createTodoWriteTool, TodoStore, buildTodoReminderIfDue } from '../tools/todo.tool'
import {
  buildAssistantSystemPrompt,
  buildCapabilitiesPrompt,
  buildStableContextMessageContent,
  buildTaskContextMessageContent,
  STABLE_CONTEXT_MSG_PREFIX,
  TASK_CONTEXT_MSG_PREFIX,
} from './prompts'

/**
 * 通用对话引擎配置。
 * 数字员工与第三方插件都是它的参数化实例：
 * - 数字员工：systemPrompt 由员工 rules 拼装，注入员工工具/记忆/工作区/技能/委托
 * - 插件：systemPrompt 为插件自定义提示词，注入插件工具
 */
export interface GenericAgentConfig extends AgentConfig {
  /** 直接使用的系统提示词（提供时优先，忽略 instructions 拼装） */
  systemPrompt?: string
  /** 允许的技能安装路径（undefined 表示不启用技能） */
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  /** 环境上下文（稳定不变的路径/权限信息） */
  workspaceGuidance?: string
}

export class GenericAgent extends BaseAgent {
  protected genericConfig: GenericAgentConfig
  protected skillManager: SkillManager
  protected skillsPrompt: string | undefined

  private memoryPrompt: string | undefined
  private kbContextPrompt: string | undefined
  private workspaceContextPrompt: string | undefined
  private taskTimePrompt: string | undefined
  private minimalMode: boolean = false
  private cachedSystemPrompt: string | undefined = undefined
  /** 稳定上下文消息首次构建后冻结（agent 生命周期内字节不变，缓存前缀可复用） */
  private cachedStableContent: string | undefined
  protected readonly todoStore = new TodoStore()

  constructor(config: GenericAgentConfig, options?: BaseAgentOptions) {
    super(config, options)
    this.genericConfig = this.normalizeGenericConfig(config)
    this.skillManager = new SkillManager(
      this.genericConfig.allowedSkillPaths,
      this.genericConfig.debug ? this.log.bind(this) : undefined
    )

    if (this.genericConfig.autoDiscoverSkills) {
      this.skillManager.discoverSkills()
    }
    // 技能清单在 agent 创建时一次性计算并冻结，之后稳定复用（与 memory 同理）
    this.skillsPrompt = this.skillManager.getSkillsXml() || undefined

    this.registerSkillTools()
    this.registerMetaTools()
    this.registerTools([createTodoWriteTool(this.todoStore)])
  }

  /**
   * 注册元工具（list_available_tools + invoke_tool）：
   * 通用对话引擎的按需工具（onDemand）不直接进入 LLM tools 数组，
   * 需经这两个常驻元工具发现与调用（与数字员工一致）。
   */
  private registerMetaTools(): void {
    this.registerTools([
      createListAvailableToolsTool(this.toolRegistry),
      createInvokeToolTool(this.toolDispatcher, this.toolRegistry),
    ])
  }

  getSkillManager(): SkillManager {
    return this.skillManager
  }

  getGenericConfig(): GenericAgentConfig {
    return { ...this.genericConfig }
  }

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

  updateTaskTimePrompt(prompt: string | undefined): void {
    this.taskTimePrompt = prompt
  }

  getTaskTimePrompt(): string | undefined {
    return this.taskTimePrompt
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

  /**
   * 极简模式：纯对话智能体，不向 LLM 传递任何工具（含元工具），
   * 退化为仅基础系统提示词的对话。非极简模式不受影响。
   */
  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<OpenAIToolDefinition[]> {
    if (this.minimalMode) {
      return []
    }
    return super.resolveActiveTools(runtimeToolNames)
  }

  protected onRunStart(): void {
    this.todoStore.reset()
  }

  protected buildLoopReminder(turn: number, maxIterations: number): string | undefined {
    if (this.minimalMode) return undefined
    const reminder = buildTodoReminderIfDue({
      turn,
      maxIterations,
      items: this.todoStore.getItems(),
      lastReminderTurn: this.todoStore.getLastReminderTurn(),
    })
    if (reminder) this.todoStore.markReminded(turn)
    return reminder
  }

  setCachedSystemPrompt(prompt: string | undefined): void {
    this.cachedSystemPrompt = prompt
  }

  getCachedSystemPrompt(): string | undefined {
    return this.cachedSystemPrompt
  }

  protected buildSystemPrompt(_options: AgentRunOptions): string {
    if (this.cachedSystemPrompt) {
      return this.cachedSystemPrompt
    }

    // 配置了 systemPrompt 时直接使用（插件场景）
    if (this.genericConfig.systemPrompt) {
      this.cachedSystemPrompt = this.genericConfig.systemPrompt
      return this.cachedSystemPrompt
    }

    const prompt = buildAssistantSystemPrompt({
      instructions: this.config.instructions || '',
      role: this.config.role,
      workspaceGuidance: this.genericConfig.workspaceGuidance,
      minimalMode: this.minimalMode,
      hasReportGeneratedFiles: !!this.toolRegistry.getTool('report_generated_files'),
      hasFileDelete: !!this.toolRegistry.getTool('file_delete'),
    })

    this.cachedSystemPrompt = prompt
    return prompt
  }

  /**
   * 上下文消息识别前缀（两条）。多轮 history 中若存在已注入的上下文消息，
   * 以此为特征过滤掉旧的，替换成最新的，避免上下文重复堆积。
   */
  private static readonly CONTEXT_MSG_PREFIXES = [STABLE_CONTEXT_MSG_PREFIX, TASK_CONTEXT_MSG_PREFIX] as const

  private isContextMessage(m: import('../core/types').Message): boolean {
    return m.role === 'user' && typeof m.content === 'string' &&
      GenericAgent.CONTEXT_MSG_PREFIXES.some(p => m.content!.startsWith(p))
  }

  /**
   * 稳定能力块：Capabilities（按需工具 + 技能激活方式）。
   * 员工子类额外追加 Delegation 段。工具注册在 agent 构造后完成，按需工具列表惰性计算；
   * 首次生成的稳定上下文消息会被冻结。
   */
  protected buildStableContextExtras(useSkills: boolean): string[] {
    const onDemandTools = this.toolRegistry.getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')
    const capabilities = buildCapabilitiesPrompt({
      onDemandToolList: onDemandToolList || undefined,
      hasSkills: useSkills && !!this.skillsPrompt,
    })
    return capabilities ? [capabilities] : []
  }

  /**
   * 稳定能力块（冻结后字节不变）：技能清单 + 子类追加的 Capabilities/Delegation。
   */
  private getOrBuildStableContent(useSkills: boolean): string | undefined {
    if (this.cachedStableContent !== undefined) return this.cachedStableContent
    const content = buildStableContextMessageContent({
      skillsPrompt: useSkills ? this.skillsPrompt : undefined,
      extras: this.buildStableContextExtras(useSkills),
    })
    this.cachedStableContent = content
    return content
  }

  /**
   * 在调用父类执行前，把动态上下文拆成两组合成 role=user 消息：
   * 1) contextHead 稳定上下文：技能清单 / Capabilities / Delegation —— 锚定在 history 之前，
   *    首次构建后字节冻结，构成可复用的 KV cache 前缀；
   * 2) contextTail 任务上下文：工作区 / 任务时间 / 记忆 / 知识库范围 —— 放在 history 之后、
   *    真实 query 之前；其内容变化只使尾部前缀失效，不击穿已发生对话的缓存。
   * 真实 query 始终独占末尾 user 消息，语义边界清晰。
   */
  private patchOptionsWithDynamicContext(options: AgentRunOptions): AgentRunOptions {
    const useSkills = options.useSkills !== false && !this.minimalMode
    const stableContent = this.getOrBuildStableContent(useSkills)
    // 极简模式：不注入工作区/任务时间/记忆等任务上下文，仅保留基础系统提示词的纯对话
    const taskContent = this.minimalMode ? undefined : buildTaskContextMessageContent({
      workspaceContextPrompt: this.workspaceContextPrompt,
      taskTimePrompt: this.taskTimePrompt,
      memoryPrompt: this.memoryPrompt,
      kbContextPrompt: this.kbContextPrompt,
    })

    const prevHistory = options.history || []
    const cleanedHistory = prevHistory.filter(m => !this.isContextMessage(m))
    const contextHead = stableContent
      ? [{ role: 'user' as const, content: stableContent }]
      : []
    const contextTail = taskContent
      ? [{ role: 'user' as const, content: taskContent }]
      : []

    if (contextHead.length === 0 && contextTail.length === 0) return options

    return { ...options, history: cleanedHistory, contextHead, contextTail }
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
            description: 'The path to the reference file within a skill'
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

  private normalizeGenericConfig(config: GenericAgentConfig): GenericAgentConfig {
    return {
      ...config,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
    }
  }
}
