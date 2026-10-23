import type { ToolDefinition } from './types'
import DatabaseService from '../../database.service'

/**
 * 协作类内置工具：列出数字员工 / 列出模型供应商。
 * 供 LLM 在需要委派任务或指定执行员工/模型时查询可用对象。
 */
export const listEmployeesTool: ToolDefinition = {
  id: 'list_employees',
  name: 'list_employees',
  title: '列出数字员工',
  summary: 'List available digital employees (id and name) for assigning or delegating a task.',
  description: `List all available digital employees with their id and name.
- Use it when you need the employee id of a task executor.
- The authoritative list of delegatees is the Delegation section in the system context.`,
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare('SELECT id, name, description, rules FROM employees ORDER BY name ASC').all() as Array<{ id: string; name: string; description: string | null; rules: string | null }>
      if (rows.length === 0) {
        return { success: true, output: '暂无可用数字员工。', employees: [] }
      }
      // 简介优先级：rules > description；仅作选用参考，截断避免撑爆上下文
      const formatted = rows.map((r, i) => {
        const intro = (r.rules || r.description || '').trim().replace(/\s+/g, ' ').slice(0, 120)
        return `[${i + 1}] ${r.name} (id=${r.id})${intro ? `\n    ${intro}` : ''}`
      }).join('\n')
      return {
        success: true,
        output: `找到 ${rows.length} 个数字员工（以下为简介，用于选择最合适的员工委派任务）：\n${formatted}`,
        employees: rows.map(r => ({
          id: r.id,
          name: r.name,
          description: (r.rules || r.description || '').trim().slice(0, 500),
        })),
      }
    } catch (err: any) {
      return { success: false, error: `列出数字员工失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}

export const listProvidersTool: ToolDefinition = {
  id: 'list_providers',
  name: 'list_providers',
  title: '列出模型供应商',
  summary: 'List LLM providers and their available models for choosing an execution model.',
  description: `List LLM providers with their id, name, provider_type, default model, and model list.
- Use it when you need a provider_id and model_id for task execution.
- A model marked is_default is the provider's default.`,
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    try {
      const db = DatabaseService.getInstance().getDb()
      const rows = db.prepare(
        `SELECT id, name, provider_type, model, models_json FROM llm_providers ORDER BY is_default DESC, created_at DESC`
      ).all() as Array<{ id: string; name: string; provider_type: string; model: string; models_json: string }>
      if (rows.length === 0) {
        return { success: true, output: '暂无 LLM 供应商。', providers: [] }
      }
      const providers = rows.map((r) => {
        let models: any[] = []
        try { models = JSON.parse(r.models_json || '[]') } catch { /* ignore */ }
        return {
          id: r.id,
          name: r.name,
          provider_type: r.provider_type,
          default_model: r.model,
          models: models.map((m: any) => ({
            id: m.id,
            model: m.model,
            name: m.name || m.model,
            is_default: !!m.is_default,
            category: m.category || 'chat',
          })),
        }
      })
      const formatted = providers.map((p, i) => {
        const modelLines = p.models.length > 0
          ? p.models.map((m) => `    - ${m.name} (model=${m.model}${m.is_default ? ' [默认]' : ''})`).join('\n')
          : '    (无模型列表，使用默认 model: ' + p.default_model + ')'
        return `[${i + 1}] ${p.name} (id=${p.id}, type=${p.provider_type})\n  默认模型: ${p.default_model}\n  可用模型:\n${modelLines}`
      }).join('\n')
      return {
        success: true,
        output: `找到 ${providers.length} 个供应商：\n${formatted}`,
        providers,
      }
    } catch (err: any) {
      return { success: false, error: `列出供应商失败: ${err.message || err}` }
    }
  },
  source: 'builtin',
  onDemand: true,
  permission: 'safe',
}
