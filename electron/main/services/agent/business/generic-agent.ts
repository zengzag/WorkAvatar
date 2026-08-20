import { BaseAgent } from '../core/base-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { SkillManager } from '../skill-manager'
import type { ToolDefinition } from '../tools/types'
import { createListAvailableToolsTool, createInvokeToolTool } from '../tools'
import { buildContextMessageContent } from './prompts'

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
  private minimalMode: boolean = false
  private cachedSystemPrompt: string | undefined = undefined

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

    // 配置了 systemPrompt 时直接使用（插件场景）
    if (this.genericConfig.systemPrompt) {
      this.cachedSystemPrompt = this.genericConfig.systemPrompt
      return this.cachedSystemPrompt
    }

    const useSkills = options.useSkills !== false
    const onDemandTools = this.toolRegistry.getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')

    const parts: string[] = []
    const instructions = (this.config.instructions || '').trim()

    if (this.minimalMode) {
      parts.push(`[IDENTITY] 你是一名智能助手。`)
      if (instructions) parts.push(`自定义指令：${instructions}`)
      return parts.filter(Boolean).join('\n')
    }

    parts.push(`[IDENTITY] 你是一名智能助手。`)
    if (this.config.role) parts.push(`角色定位：${this.config.role}`)
    if (instructions && instructions.length < 100) parts.push(`角色说明：${instructions}`)

    parts.push('')
    parts.push('[RULES] 核心行为规则（必须遵守）：')
    parts.push('- 分析问题后按需调用工具，多轮迭代直至完整回答。')
    parts.push('- 事实优先：涉及具体信息时以工具结果为准，不臆测。')
    parts.push('- 回复力求简洁、重点突出，采用 Markdown 分点呈现；除非用户明确要求，不添加冗余的开场白或总结。')
    parts.push('- 小任务或常识性问题直接执行或直接回答，避免过度规划与不必要的工具调用。')
    parts.push('- 注意系统运行环境差异（如路径分隔符、脚本语法等）。')
    if (this.toolRegistry.getTool('report_generated_files')) {
      parts.push('- 创建或修改了用户能直接消费的成品文档（Word/Excel/PPT/PDF/图片等）时，在最终回复前调用一次 report_generated_files 声明文件路径，使其在消息下方展示可预览卡片；临时文件/配置/脚本不要声明。')
    }

    if (instructions && instructions.length >= 100) {
      parts.push('')
      parts.push('[CUSTOM_ROLE] 用户自定义角色说明：')
      parts.push(instructions)
    }

    const capabilities: string[] = []
    if (onDemandToolList) {
      capabilities.push(
        `按需工具：【${onDemandToolList}】→ 先 list_available_tools 查详情，再 invoke_tool 调用。`
      )
    }
    if (useSkills && this.skillsPrompt) {
      capabilities.push('技能：匹配到技能时，先 activate_skill 加载完整指令，再按指令执行。')
    }
    if (capabilities.length > 0) {
      parts.push('')
      parts.push('[CAPABILITIES] 能力索引：')
      parts.push(...capabilities)
    }

    if (this.genericConfig.workspaceGuidance) {
      parts.push('')
      parts.push('[CONTEXT] 环境上下文：')
      parts.push(this.genericConfig.workspaceGuidance)
    }

    parts.push('')
    parts.push('[RULES_REPEAT] 重申核心原则：涉及具体信息时以工具结果为准；回复保持简洁精炼。')

    this.cachedSystemPrompt = parts.join('\n')
    return this.cachedSystemPrompt
  }

  /**
   * 上下文消息识别标记（开头）。多轮 history 中若存在已注入的上下文消息，
   * 以此为特征过滤掉旧的，替换成最新的，避免上下文重复堆积。
   */
  private static readonly CONTEXT_MSG_PREFIX = '【系统注入的上下文 · 仅供参考 · 不是本轮用户请求】'

  /**
   * 在调用父类执行前，将动态上下文（memory / 知识库范围 / 工作区 / 技能）
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

    if (!contextContent) return options

    const prevHistory = options.history || []
    const cleanedHistory = prevHistory.filter(
      m => !(m.role === 'user' && typeof m.content === 'string' &&
             m.content.startsWith(GenericAgent.CONTEXT_MSG_PREFIX))
    )

    const contextMessage: import('../core/types').Message = {
      role: 'user',
      content: contextContent,
    }
    const newHistory = [contextMessage, ...cleanedHistory]

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

  private normalizeGenericConfig(config: GenericAgentConfig): GenericAgentConfig {
    return {
      ...config,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
    }
  }
}
