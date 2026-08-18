import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ToolAssignParams,
  ToolCategoryAssignParams,
  ToolMode,
  SearchOpenWindowParams,
  SearchCloseWindowParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type SkillRegistryService from '../services/skill-registry.service'
import { allBuiltinTools, createKMSTools, createKMSCollectionTools, javascriptExecTool, shellExecTool } from '../services/agent/tools'
import { generateId } from '../services/common-utils'
import { internetSearchService } from '../services/internet-search.service'
import EmployeeAgentService from '../services/employee-agent.service'
import PluginHostService from '../services/plugin/plugin-host.service'
import { safeHandle } from './_shared'

interface ToolCategoryDef {
  id: string
  name: string
  title: string
  description: string
  icon: string
  toolIds: string[]
  /** 插件贡献的分类（对应某插件，仅插件加载时存在） */
  isPlugin?: boolean
  /** 插件分类对应的插件 id（用于前端以插件命名空间解析 title 的 i18n key） */
  pluginId?: string
}

/**
 * 内置工具分类聚合定义（不含插件工具）：
 * 插件工具按其贡献插件自动聚成"插件分类"（见 buildToolCategoryDefs），
 * 仅当对应插件加载时才出现。日历已插件化，不再内置此分类。
 */
const TOOL_CATEGORY_DEFS: ToolCategoryDef[] = [
  {
    id: 'file_operations',
    name: 'file_operations',
    title: '文件操作',
    description: '文件读写、编辑、成品展示与图片识别等核心文件操作',
    icon: 'file',
    toolIds: [
      'file_read',
      'file_write',
      'file_edit',
      'report_generated_files',
      'ocr_image',
    ],
  },
  {
    id: 'kms',
    name: 'kms',
    title: '资料库（KMS）',
    description: '本地资料库检索、文件内容获取、合集管理等知识管理工具',
    icon: 'database',
    toolIds: [
      'kms_search',
      'kms_get_content',
      'kms_list_collections',
    ],
  },
  {
    id: 'web',
    name: 'web',
    title: '网络工具',
    description: '互联网搜索和网页内容抓取获取',
    icon: 'global',
    toolIds: [
      'web_search',
      'web_fetch',
    ],
  },
  { id: 'scripting', name: 'scripting', title: '脚本执行', description: 'Shell命令、JavaScript代码执行，处理数据、调用语言生态、操作系统命令', icon: 'code', toolIds: ['shell_exec', 'javascript_exec'], },
  {
    id: 'conversation_memory',
    name: 'conversation_memory',
    title: '对话记忆',
    description: '历史对话搜索、列表查询和对话详情查看',
    icon: 'message',
    toolIds: [
      'search_conversations',
      'list_conversations',
      'get_conversation_detail',
    ],
  },
  {
    id: 'basic_helpers',
    name: 'basic_helpers',
    title: '基础辅助',
    description: '日期时间获取、用户询问交互等轻量辅助工具',
    icon: 'tool',
    toolIds: [
      'date_time',
      'ask_user',
    ],
  },
  {
    id: 'collaboration',
    name: 'collaboration',
    title: '协作',
    description: '委托给其他数字员工执行子任务，实现多员工协作',
    icon: 'team',
    toolIds: [
      'delegate_to_employee',
      'list_employees',
      'list_providers',
    ],
  },
]

/**
 * 完整分类定义 = 内置分类 + 插件分类（每插件一类，pluginId → 插件贡献的工具）。
 * 插件分类 id = `plugin:<pluginId>`，仅当插件激活贡献工具时才存在。
 */
function buildToolCategoryDefs(): ToolCategoryDef[] {
  const pluginGroups = PluginHostService.getInstance().getPluginAgentToolGroups()
  const pluginCats: ToolCategoryDef[] = pluginGroups.map(g => ({
    id: `plugin:${g.pluginId}`,
    name: `plugin:${g.pluginId}`,
    // title 用插件 locale 的 navLabel key（前端以插件命名空间解析，如 Calendar → 日历）
    title: 'navLabel',
    description: `${g.pluginName} 提供的工具`,
    icon: 'plugin',
    isPlugin: true,
    pluginId: g.pluginId,
    toolIds: (g.tools as Array<{ id: string }>).map(t => t.id),
  }))
  return [...TOOL_CATEGORY_DEFS, ...pluginCats]
}

function getUnifiedBuiltinToolCatalog() {
  const agentTools = allBuiltinTools.map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'agent' as const,
    onDemand: t.onDemand ?? false,
  }))

  // KMS 资料库工具（搜索 + 内容获取）
  const kmsTools = createKMSTools().map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'kms' as const,
    onDemand: t.onDemand ?? false,
  }))

  // KMS 合集管理工具
  const kmsCollectionTools = createKMSCollectionTools({ current: { collectionIds: [] } }).map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'kms_collection' as const,
    onDemand: t.onDemand ?? false,
  }))

  // shell_exec + javascript_exec 工具（category 覆盖 agent 里的默认 'agent'）
  const scriptingTools = [
    {
      id: shellExecTool.id,
      name: shellExecTool.name,
      title: shellExecTool.title,
      description: shellExecTool.description,
      category: 'scripting' as const,
      onDemand: shellExecTool.onDemand ?? false,
    },
    {
      id: javascriptExecTool.id,
      name: javascriptExecTool.name,
      title: javascriptExecTool.title,
      description: javascriptExecTool.description,
      category: 'scripting' as const,
      onDemand: javascriptExecTool.onDemand ?? false,
    },
    ]

  // 用 Map 去重：后出现的覆盖先出现的，确保 scriptingTools 的 category='scripting' 覆盖 agentTools 里的 'agent'
  const idToTool = new Map<string, { id: string; name: string; title: string; description: string; category: string; onDemand: boolean }>()

  for (const tool of [...agentTools, ...kmsTools, ...kmsCollectionTools, ...scriptingTools]) {
    idToTool.set(tool.id, tool)
  }

  // 插件贡献的 agent 工具（如日历插件工具），纳入统一目录（分类归属由插件分类 toolIds 决定）
  const pluginTools = (PluginHostService.getInstance().getAgentTools() as Array<{
    id: string; name: string; title: string; description: string; onDemand?: boolean
  }>).map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'plugin' as const,
    onDemand: t.onDemand ?? false,
  }))
  for (const tool of pluginTools) {
    idToTool.set(tool.id, tool)
  }

  return Array.from(idToTool.values())
}

/** 根据工具ID → 工具详情的查找表（含 category 字段） */
function getToolLookupMap(): Map<string, { id: string; name: string; title: string; description: string; category: string; onDemand: boolean }> {
  const catalog = getUnifiedBuiltinToolCatalog()
  // 对话记忆工具：补充不在 catalog 但在分类中，需要单独补齐
  const extra: Array<{ id: string; name: string; title: string; description: string; category: string; onDemand: boolean }> = [
    { id: 'search_conversations', name: 'search_conversations', title: '搜索历史对话', description: '在该数字员工的历史任务中搜索内容', category: 'conversation', onDemand: true },
    { id: 'list_conversations', name: 'list_conversations', title: '列出对话', description: '列出该数字员工的任务列表', category: 'conversation', onDemand: true },
    { id: 'get_conversation_detail', name: 'get_conversation_detail', title: '查看对话详情', description: '获取指定任务的完整消息历史', category: 'conversation', onDemand: true },
  ]
  const map = new Map<string, { id: string; name: string; title: string; description: string; category: string; onDemand: boolean }>()
  for (const t of catalog) map.set(t.id, t)
  for (const t of extra) {
    if (!map.has(t.id)) map.set(t.id, t)
  }
  return map
}

/** 工具无显式配置时的默认模式：定义上按需 → on_demand，常驻 → on */
function resolveDefaultToolMode(toolId: string): ToolMode {
  return getToolLookupMap().get(toolId)?.onDemand ? 'on_demand' : 'on'
}

/** 分配参数 → 工具模式：优先 mode；缺失时按 is_enabled 兼容推断 */
function resolveAssignMode(params: { mode?: ToolMode; is_enabled?: boolean; tool_id?: string }): ToolMode {
  if (params.mode === 'on' || params.mode === 'on_demand' || params.mode === 'off') return params.mode
  if (params.is_enabled === false) return 'off'
  return params.tool_id ? resolveDefaultToolMode(params.tool_id) : 'on'
}

function isValidToolMode(mode: string | undefined): mode is ToolMode {
  return mode === 'on' || mode === 'on_demand' || mode === 'off'
}

export function registerToolHandlers(
  db: ReturnType<DatabaseService['getDb']>,
  skillRegistry: SkillRegistryService
) {
  // 缓存 prepared statement，避免每次调用都重新编译 SQL
  const getEmployeeToolsStmt = db.prepare(
    'SELECT tool_id, is_enabled, tool_mode FROM employee_tools WHERE employee_id = ?'
  )
  const assignToolStmt = db.prepare(
    'INSERT INTO employee_tools (id, employee_id, tool_id, tool_mode, is_enabled) VALUES (?, ?, ?, ?, ?) ON CONFLICT(employee_id, tool_id) DO UPDATE SET tool_mode = excluded.tool_mode, is_enabled = excluded.is_enabled'
  )

  safeHandle(IPC_CHANNELS.TOOL_LIST_BUILTIN, () => {
    return getUnifiedBuiltinToolCatalog()
  })

  // 完整工具分类定义（含插件分类），供创建向导等按分类渲染
  safeHandle(IPC_CHANNELS.TOOL_GET_CATEGORIES, () => {
    return buildToolCategoryDefs().map(c => ({
      id: c.id,
      title: c.title,
      icon: c.icon,
      is_plugin: c.isPlugin ?? false,
      plugin_id: c.pluginId,
      tool_ids: c.toolIds,
    }))
  })

  safeHandle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, (params: { employee_id: string }) => {
    const catalog = getUnifiedBuiltinToolCatalog()

    const enabledRows = getEmployeeToolsStmt.all(params.employee_id) as any[]

    const rowMap = new Map<string, { is_enabled: number; tool_mode?: string }>()
    for (const row of enabledRows) {
      rowMap.set(row.tool_id, row)
    }

    return catalog.map(tool => {
      const row = rowMap.get(tool.id)
      const mode: ToolMode = row && isValidToolMode(row.tool_mode)
        ? row.tool_mode
        : (tool.onDemand ? 'on_demand' : 'on')
      return {
        ...tool,
        mode,
        is_enabled: mode !== 'off',
        is_assigned: !!row,
      }
    })
  })

  /**
   * 获取按分类聚合的员工工具列表
   * 返回：每个分类包含总开关 + 分类包含的工具明细 + 模式聚合（on/on_demand/off/mixed）
   */
  safeHandle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOL_CATEGORIES, (params: { employee_id: string }) => {
    const enabledRows = getEmployeeToolsStmt.all(params.employee_id) as Array<{ tool_id: string; is_enabled: number; tool_mode?: string }>
    const rowMap = new Map<string, { is_enabled: number; tool_mode?: string }>()
    for (const row of enabledRows) {
      rowMap.set(row.tool_id, row)
    }
    const toolLookup = getToolLookupMap()

    const resolveMode = (toolId: string): ToolMode => {
      const row = rowMap.get(toolId)
      const lookup = toolLookup.get(toolId)
      return row && isValidToolMode(row.tool_mode)
        ? row.tool_mode
        : (lookup?.onDemand ? 'on_demand' : 'on')
    }

    return buildToolCategoryDefs().map(categoryDef => {
      const tools = categoryDef.toolIds
        .map(tid => toolLookup.get(tid))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map(t => ({
          id: t.id,
          name: t.name,
          title: t.title,
          description: t.description,
          mode: resolveMode(t.id),
        }))

      let enabledCount = 0
      let totalCount = 0
      const modeSet = new Set<ToolMode>()
      for (const tid of categoryDef.toolIds) {
        if (!toolLookup.has(tid)) continue
        totalCount++
        const mode = resolveMode(tid)
        modeSet.add(mode)
        if (mode !== 'off') enabledCount++
      }
      // 分类聚合模式：按分类内所有工具的最高状态显示（on > on_demand > off）
      const mode: ToolMode = modeSet.has('on') ? 'on' : modeSet.has('on_demand') ? 'on_demand' : 'off'
      // 兼容旧字段：全开启才为 true（前端通过 enabled_count / total_count 表达部分开启）
      const isEnabled = enabledCount === totalCount && totalCount > 0

      return {
        id: categoryDef.id,
        name: categoryDef.name,
        title: categoryDef.title,
        description: categoryDef.description,
        icon: categoryDef.icon,
        is_plugin: categoryDef.isPlugin ?? false,
        plugin_id: categoryDef.pluginId,
        tool_ids: categoryDef.toolIds,
        tools,
        mode,
        is_enabled: isEnabled,
        enabled_count: enabledCount,
        total_count: totalCount,
      }
    })
  })

  safeHandle(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, (params: ToolAssignParams) => {
    const mode = resolveAssignMode(params)
    const isEnabled = mode !== 'off' ? 1 : 0
    assignToolStmt.run(generateId(), params.employee_id, params.tool_id, mode, isEnabled)
    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true }
  })

  /**
   * 批量分配/切换某个分类下所有工具的模式
   * 一次性把该分类的工具 ID 全部按传入的 mode 写入
   */
  safeHandle(IPC_CHANNELS.TOOL_ASSIGN_CATEGORY_TO_EMPLOYEE, (params: ToolCategoryAssignParams) => {
    const categoryDef = buildToolCategoryDefs().find(c => c.id === params.category_id)
    if (!categoryDef) {
      return { success: false, error: `未知的工具分类: ${params.category_id}` }
    }

    const rows = categoryDef.toolIds.map(toolId => ({
      tool_id: toolId,
      mode: resolveAssignMode({ mode: params.mode, is_enabled: params.is_enabled, tool_id: toolId }),
    }))

    // 批量 SQL 写入：因为预编译语句最多支持 20 组 values，按批处理
    for (let offset = 0; offset < rows.length; offset += 20) {
      const batch = rows.slice(offset, offset + 20)
      const bindParams: any[] = []
      for (const r of batch) {
        bindParams.push(generateId(), params.employee_id, r.tool_id, r.mode, r.mode !== 'off' ? 1 : 0)
      }
      // 动态构造该批次大小的 SQL
      const placeholders = batch.map(() => '(?, ?, ?, ?, ?)').join(', ')
      const sql = `INSERT INTO employee_tools (id, employee_id, tool_id, tool_mode, is_enabled) VALUES ${placeholders} ON CONFLICT(employee_id, tool_id) DO UPDATE SET tool_mode = excluded.tool_mode, is_enabled = excluded.is_enabled`
      db.prepare(sql).run(...bindParams)
    }

    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true, affected_tool_count: rows.length }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_LIST, () => {
    return skillRegistry.getInstalledSkills()
  })

  // 业务语义错误返回 { success: false, error }，保留原 try-catch
  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, async (_, params: { source: 'directory' | 'zip'; path: string }) => {
    try {
      if (params.source === 'directory') {
        return await skillRegistry.installFromDirectory(params.path)
      } else {
        return await skillRegistry.installFromZip(params.path)
      }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, async (id: string) => {
    const result = await skillRegistry.uninstallSkill(id)
    // 卸载可能影响多个员工，清空全部 agent 缓存（低频操作）
    EmployeeAgentService.getInstance().clearAgentCache()
    return { success: result }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, (params: { employee_id: string }) => {
    return skillRegistry.getEmployeeSkills(params.employee_id)
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, (params: { employee_id: string; skill_id: string }) => {
    skillRegistry.assignSkillToEmployee(params.skill_id, params.employee_id)
    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, (params: { employee_id: string; skill_id: string }) => {
    skillRegistry.removeSkillFromEmployee(params.skill_id, params.employee_id)
    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE_FOR_EMPLOYEE, (params: { employee_id: string; skill_id: string; enabled: boolean }) => {
    skillRegistry.toggleSkillForEmployee(params.skill_id, params.employee_id, params.enabled)
    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.SEARCH_GET_ENGINES, () => {
    return internetSearchService.getAvailableEngines()
  })

  // 业务语义错误返回 { success: false, error }，保留原 try-catch
  ipcMain.handle(IPC_CHANNELS.SEARCH_OPEN_WINDOW, async (_, params: SearchOpenWindowParams) => {
    try {
      await internetSearchService.openSearchWindow(params.engine as any)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  safeHandle(IPC_CHANNELS.SEARCH_CLOSE_WINDOW, (params: SearchCloseWindowParams) => {
    internetSearchService.closeSearchWindow(params.engine as any)
    return { success: true }
  })
}
