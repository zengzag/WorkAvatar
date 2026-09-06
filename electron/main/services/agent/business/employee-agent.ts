import { GenericAgent } from './generic-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import {
  buildEmployeeSystemPrompt,
  buildCapabilitiesPrompt,
  buildDelegationPrompt,
} from './prompts'

export interface EmployeeDelegationTarget {
  id: string
  name: string
  description?: string
  role?: string
}

export interface EmployeeAgentConfig extends AgentConfig {
  employeeId?: string
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  workspaceGuidance?: string
  /** 可委托员工列表（委托能力开启时非空）：随稳定上下文消息注入 [DELEGATION] 段 */
  delegationTargets?: EmployeeDelegationTarget[]
}

/**
 * 数字员工代理：GenericAgent 的员工特化。
 * 员工特殊需求（员工 rules 拼装、委托/能力信息注入）在此实现，
 * 通用对话能力（动态上下文注入、技能管理、工具循环）由 GenericAgent 提供。
 */
export class EmployeeAgent extends GenericAgent {
  private employeeConfig: EmployeeAgentConfig

  constructor(config: EmployeeAgentConfig, options?: BaseAgentOptions) {
    super(config, options)
    this.employeeConfig = this.normalizeEmployeeConfig(config)
  }

  getEmployeeConfig(): EmployeeAgentConfig {
    return { ...this.employeeConfig }
  }

  protected buildSystemPrompt(_options: AgentRunOptions): string {
    if (this.getCachedSystemPrompt()) {
      return this.getCachedSystemPrompt()!
    }

    // memory / skills / 委托 / 能力清单不再拼入 system prompt → 改为在 run/runStream 中
    // 以独立 role=user 上下文消息注入（稳定上下文 = 技能+能力+委托；任务上下文 = 工作区+时间+记忆+知识范围），
    // 这样 system prompt 字节级稳定 → KV cache 前缀高命中
    const prompt = buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      minimalMode: this.getMinimalMode(),
      hasReportGeneratedFiles: !!this.getToolRegistry().getTool('report_generated_files'),
    })

    this.setCachedSystemPrompt(prompt)
    return prompt
  }

  /**
   * 稳定能力块：[CAPABILITIES] + [DELEGATION]。
   * 工具注册在 agent 构造后完成，因此按需工具列表在此（每次运行）惰性计算；内容随 agent 生命周期冻结。
   */
  protected buildStableContextExtras(useSkills: boolean): string[] {
    if (!useSkills) return []
    const onDemandTools = this.getToolRegistry().getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')
    const capabilities = buildCapabilitiesPrompt({
      onDemandToolList: onDemandToolList || undefined,
      hasSkills: !!this.skillsPrompt,
    })
    const delegation = buildDelegationPrompt(this.employeeConfig.delegationTargets || [])
    return [capabilities, delegation].filter((x): x is string => !!x)
  }

  private normalizeEmployeeConfig(config: EmployeeAgentConfig): EmployeeAgentConfig {
    return {
      ...config,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
    }
  }
}
