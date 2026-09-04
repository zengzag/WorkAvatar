import { GenericAgent } from './generic-agent'
import type { AgentConfig, AgentRunOptions } from '../core/types'
import type { BaseAgentOptions } from '../core/base-agent'
import { buildEmployeeSystemPrompt } from './prompts'
import { buildDelegateDescription } from '../tools/delegate.tool'
import { buildMultiAgentDescription } from '../tools/launch-agents.tool'
import DatabaseService from '../../database.service'

export interface EmployeeAgentConfig extends AgentConfig {
  employeeId?: string
  allowedSkillPaths?: string[]
  autoDiscoverSkills?: boolean
  workspaceGuidance?: string
}

/**
 * 数字员工代理：GenericAgent 的员工特化。
 * 员工特殊需求（员工 rules 拼装、委托员工列表注入）在此实现，
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

  protected buildSystemPrompt(options: AgentRunOptions): string {
    if (this.getCachedSystemPrompt()) {
      return this.getCachedSystemPrompt()!
    }

    const useSkills = options.useSkills !== false
    const onDemandTools = this.getToolRegistry().getOnDemandTools()
    const onDemandToolList = onDemandTools
      .map(t => `${t.title}(${t.name})`)
      .join('、')

    // memory / skills / kb 不再拼入 system prompt → 改为在 run/runStream 中 prepend 到 query
    // 这样 system prompt 字节级稳定 → KV cache 前缀高命中
    const prompt = buildEmployeeSystemPrompt({
      name: this.config.name || '数字员工',
      instructions: this.config.instructions || '',
      role: this.config.role,
      hasSkills: useSkills && !!this.getSkillManager().getSkillsXml(),
      workspaceGuidance: this.employeeConfig.workspaceGuidance,
      minimalMode: this.getMinimalMode(),
      onDemandToolList: onDemandToolList || undefined,
      hasReportGeneratedFiles: !!this.getToolRegistry().getTool('report_generated_files'),
    })

    this.setCachedSystemPrompt(prompt)
    return prompt
  }

  protected async resolveActiveTools(runtimeToolNames?: string[]): Promise<any[]> {
    if (this.getMinimalMode()) {
      return []
    }
    const schemas = await super.resolveActiveTools(runtimeToolNames)
    // 嵌套委托（子会话再 spawn）已在 SubAgentRuntime 层做深度/去环守卫，工具不做过滤

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
      const empId = this.employeeConfig.employeeId || ''
      for (let i = 0; i < schemas.length; i++) {
        const name = schemas[i].function?.name
        if (name === 'delegate_to_employee') {
          schemas[i] = {
            ...schemas[i],
            function: { ...schemas[i].function, description: buildDelegateDescription(empId, employees) },
          }
        } else if (name === 'launch_agents') {
          schemas[i] = {
            ...schemas[i],
            function: { ...schemas[i].function, description: buildMultiAgentDescription(empId, employees) },
          }
        }
      }
      return schemas
    } catch {
      // 查询失败时保留静态 description
      return schemas
    }
  }

  private normalizeEmployeeConfig(config: EmployeeAgentConfig): EmployeeAgentConfig {
    return {
      ...config,
      allowedSkillPaths: config.allowedSkillPaths,
      autoDiscoverSkills: config.autoDiscoverSkills !== false,
    }
  }
}
