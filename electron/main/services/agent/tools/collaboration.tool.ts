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
  summary: '列出所有可用的数字员工（id、名称）。需要指定执行员工或委派任务时使用。',
  description: `列出所有可用的数字员工，返回 id、name。
- 需要指定执行任务的数字员工时，调用此工具获取 employee_id
- 调用后可将所需员工的 id 传入 delegate_to_employee 的 target_employee_id 参数`,
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
  summary: '列出所有 LLM 供应商及其可用模型。需要指定执行模型时使用。',
  description: `列出所有 LLM 供应商及其可用模型，返回 id、name、provider_type、默认 model、models 列表。
- 需要指定执行任务的供应商/模型时，调用此工具获取 provider_id 和 model_id
- models 列表中标记 is_default 的为该供应商的默认模型`,
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
