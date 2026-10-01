import { GenericAgent } from './generic-agent'
import type { GenericAgentConfig } from './generic-agent'
import type { AgentRunOptions } from '../core/types'
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

export interface EmployeeAgentConfig extends GenericAgentConfig {
  employeeId?: string
  /** 可委托员工列表：随稳定上下文消息注入 Delegation 段 */
  delegationTargets?: EmployeeDelegationTarget[]
  /** 委托能力开关（targets 为空时仍注入临时角色/模板说明） */
  delegationEnabled?: boolean
}

/**
 * 数字员工代理：GenericAgent 的员工特化。
 * 员工特殊需求（员工 system prompt 拼装、委托/能力信息注入）在此实现，
 * 通用对话能力（动态上下文注入、技能管理、工具循环、任务清单）由 GenericAgent 提供。
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

    // memory / skills / 委托 / 能力清单不拼入 system prompt：
    // 稳定能力块以 contextHead 锚定在 history 头部，任务块以 contextTail 放在 history 之后，
    // system prompt 字节级稳定 → KV cache 前缀高命中。
    const prompt = buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      minimalMode: this.getMinimalMode(),
      hasReportGeneratedFiles: !!this.getToolRegistry().getTool('report_generated_files'),
      hasFileDelete: !!this.getToolRegistry().getTool('file_delete'),
    })

    this.setCachedSystemPrompt(prompt)
    return prompt
  }

  /**
   * 稳定能力块：Capabilities（按需工具 + 技能激活方式）+ Delegation。
   * 工具注册在 agent 构造后完成，因此按需工具列表在此（每次运行）惰性计算；
   * 首次生成的稳定上下文消息会在 GenericAgent 中冻结。
   */
  protected buildStableContextExtras(useSkills: boolean): string[] {
    const onDemandTools = this.getToolRegistry().getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')
    const capabilities = buildCapabilitiesPrompt({
      onDemandToolList: onDemandToolList || undefined,
      hasSkills: useSkills && !!this.skillsPrompt,
    })
    const delegation = buildDelegationPrompt(this.employeeConfig.delegationTargets || [], this.employeeConfig.delegationEnabled === true)
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
