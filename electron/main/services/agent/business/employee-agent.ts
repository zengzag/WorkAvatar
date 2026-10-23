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

export interface EmployeeDelegationProfile {
  id: string
  name: string
  description?: string
}

export interface EmployeeAgentConfig extends GenericAgentConfig {
  employeeId?: string
  /** 可委托员工列表：随稳定上下文消息注入 Delegation 段 */
  delegationTargets?: EmployeeDelegationTarget[]
  /** 可复用子智能体模板列表（内置 explore/general + 用户自建）：作为预置执行者候选注入 */
  delegationProfiles?: EmployeeDelegationProfile[]
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
    // 稳定能力块以 contextHead 锚定在 history 头部，易变任务块作为请求末尾追加文本注入，
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
   * 工具注册在 agent 构造后完成，因此按需工具列表在首次构建稳定上下文时惰性计算一次，
   * 随后随稳定上下文一起冻结复用。
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
    const delegation = buildDelegationPrompt(
      this.employeeConfig.delegationTargets || [],
      // 透传三态：显式 false = 委托关闭（不注入）；true/undefined = 按目标列表注入（兼容直接构造的调用方）
      this.employeeConfig.delegationEnabled,
      this.employeeConfig.delegationProfiles || [],
    )
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
