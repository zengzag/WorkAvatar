import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ToolAssignParams,
  ToolCategoryAssignParams,
  SearchOpenWindowParams,
  SearchCloseWindowParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type SkillRegistryService from '../services/skill-registry.service'
import { allBuiltinTools, createKMSTools, createKMSCollectionTools, javascriptExecTool, shellExecTool } from '../services/agent/tools'
import { generateId } from '../services/common-utils'
import { internetSearchService } from '../services/internet-search.service'
import EmployeeAgentService from '../services/employee-agent.service'
import { safeHandle } from './_shared'

interface ToolCategoryDef {
  id: string
  name: string
  title: string
  description: string
  icon: string
  toolIds: string[]
}

/**
 * 工具分类聚合定义：
 * 每个分类对应一批工具，用户只看到分类名和开关，
 * 开启/关闭即批量操作该分类下的所有工具，降低理解成本
 */
const TOOL_CATEGORY_DEFS: ToolCategoryDef[] = [
  {
    id: 'file_operations',
    name: 'file_operations',
    title: '文件操作',
    description: '文件读写、创建、删除、移动、复制、搜索、目录管理等文件系统操作',
    icon: 'file',
    toolIds: [
      'file_read',
      'file_write',
      'file_edit',
      'file_mkdir',
      'file_list',
      'file_search',
      'file_delete',
      'file_move',
      'file_copy',
      'file_rename',
      'file_stat',
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
      'kms_knowledge_card',
      'kms_list_collections',
      'kms_collection_overview',
      'kms_get_toc',
      'kms_get_paragraphs',
    ],
  },
  {
    id: 'calendar',
    name: 'calendar',
    title: '日历待办',
    description: '日程事件的创建/查询/修改/删除，以及待办任务管理和统计',
    icon: 'calendar',
    toolIds: [
      'calendar_event_list',
      'calendar_event_create',
      'calendar_event_update',
      'calendar_event_delete',
      'calendar_todo_list',
      'calendar_todo_create',
      'calendar_todo_update',
      'calendar_todo_delete',
      'calendar_todo_complete',
      'calendar_todo_stats',
    ],
  },
  {
    id: 'automation',
    name: 'automation',
    title: '自动化任务',
    description: '自动化任务的创建、调度、运行、预览和执行历史查询',
    icon: 'robot',
    toolIds: [
      'automation_list_employees',
      'automation_list_providers',
      'automation_task_list',
      'automation_task_create',
      'automation_task_update',
      'automation_task_delete',
      'automation_task_toggle',
      'automation_task_run_now',
      'automation_task_preview',
      'automation_run_list',
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
]

function getUnifiedBuiltinToolCatalog() {
  const agentTools = allBuiltinTools.map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'agent' as const,
  }))

  // KMS 资料库工具（搜索 + 内容获取）
  const kmsTools = createKMSTools().map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'kms' as const,
  }))

  // KMS 合集管理工具
  const kmsCollectionTools = createKMSCollectionTools({ current: { collectionIds: [] } }).map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'kms_collection' as const,
  }))

  // shell_exec + javascript_exec 工具（category 覆盖 agent 里的默认 'agent'）
  const scriptingTools = [
    {
      id: shellExecTool.id,
      name: shellExecTool.name,
      title: shellExecTool.title,
      description: shellExecTool.description,
      category: 'scripting' as const,
    },
    {
      id: javascriptExecTool.id,
      name: javascriptExecTool.name,
      title: javascriptExecTool.title,
      description: javascriptExecTool.description,
      category: 'scripting' as const,
    },
    ]

  // 用 Map 去重：后出现的覆盖先出现的，确保 scriptingTools 的 category='scripting' 覆盖 agentTools 里的 'agent'
  const idToTool = new Map<string, { id: string; name: string; title: string; description: string; category: string }>()

  for (const tool of [...agentTools, ...kmsTools, ...kmsCollectionTools, ...scriptingTools]) {
    idToTool.set(tool.id, tool)
  }

  return Array.from(idToTool.values())
}

/** 根据工具ID → 工具详情的查找表（含 category 字段） */
function getToolLookupMap(): Map<string, { id: string; name: string; title: string; description: string; category: string }> {
  const catalog = getUnifiedBuiltinToolCatalog()
  // 对话记忆工具：补充不在 catalog 但在分类中，需要单独补齐
  const extra: Array<{ id: string; name: string; title: string; description: string; category: string }> = [
    { id: 'search_conversations', name: 'search_conversations', title: '搜索历史对话', description: '在该数字员工的历史任务中搜索内容', category: 'conversation' },
    { id: 'list_conversations', name: 'list_conversations', title: '列出对话', description: '列出该数字员工的任务列表', category: 'conversation' },
    { id: 'get_conversation_detail', name: 'get_conversation_detail', title: '查看对话详情', description: '获取指定任务的完整消息历史', category: 'conversation' },
  ]
  const map = new Map<string, { id: string; name: string; title: string; description: string; category: string }>()
  for (const t of catalog) map.set(t.id, t)
  for (const t of extra) {
    if (!map.has(t.id)) map.set(t.id, t)
  }
  return map
}

export function registerToolHandlers(
  db: ReturnType<DatabaseService['getDb']>,
  skillRegistry: SkillRegistryService
) {
  // 缓存 prepared statement，避免每次调用都重新编译 SQL
  const getEmployeeToolsStmt = db.prepare(
    'SELECT tool_id, is_enabled FROM employee_tools WHERE employee_id = ?'
  )
  const assignToolStmt = db.prepare(
    'INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES (?, ?, ?, ?) ON CONFLICT(employee_id, tool_id) DO UPDATE SET is_enabled = ?'
  )

  safeHandle(IPC_CHANNELS.TOOL_LIST_BUILTIN, () => {
    return getUnifiedBuiltinToolCatalog()
  })

  safeHandle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, (params: { employee_id: string }) => {
    const catalog = getUnifiedBuiltinToolCatalog()

    const enabledRows = getEmployeeToolsStmt.all(params.employee_id) as any[]

    const enabledMap = new Map<string, boolean>()
    for (const row of enabledRows) {
      enabledMap.set(row.tool_id, row.is_enabled === 1)
    }

    return catalog.map(tool => ({
      ...tool,
      is_enabled: enabledMap.get(tool.id) ?? true,
      is_assigned: enabledMap.has(tool.id),
    }))
  })

  /**
   * 获取按分类聚合的员工工具列表
   * 返回：每个分类包含总开关 + 分类包含的工具明细
   */
  safeHandle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOL_CATEGORIES, (params: { employee_id: string }) => {
    const enabledRows = getEmployeeToolsStmt.all(params.employee_id) as Array<{ tool_id: string; is_enabled: number }>
    const enabledMap = new Map<string, boolean>()
    for (const row of enabledRows) {
      enabledMap.set(row.tool_id, row.is_enabled === 1)
    }
    const toolLookup = getToolLookupMap()

    return TOOL_CATEGORY_DEFS.map(categoryDef => {
      const tools = categoryDef.toolIds
        .map(tid => toolLookup.get(tid))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map(t => ({
          id: t.id,
          name: t.name,
          title: t.title,
          description: t.description,
        }))

      let enabledCount = 0
      for (const tid of categoryDef.toolIds) {
        const isOn = enabledMap.get(tid) ?? true
        if (isOn) enabledCount++
      }

      const totalCount = categoryDef.toolIds.length
      // 分类开关：只要有一个工具开启就算部分开启，但为了降低用户理解成本，
      // 分类级别的 is_enabled 采用「全量逻辑：全部工具全开启则开，否则关。
      // 但为了兼容部分开启的中间态，UI可以用 indeterminate，这里返回全开启才为 true，
      // 由前端通过 enabled_count / total_count 来表达部分开启
      const isEnabled = enabledCount === totalCount && totalCount > 0

      return {
        id: categoryDef.id,
        name: categoryDef.name,
        title: categoryDef.title,
        description: categoryDef.description,
        icon: categoryDef.icon,
        tool_ids: categoryDef.toolIds,
        tools,
        is_enabled: isEnabled,
        enabled_count: enabledCount,
        total_count: totalCount,
      }
    })
  })

  safeHandle(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, (params: ToolAssignParams) => {
    assignToolStmt.run(generateId(), params.employee_id, params.tool_id, params.is_enabled !== false ? 1 : 0, params.is_enabled !== false ? 1 : 0)
    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true }
  })

  /**
   * 批量分配/切换某个分类下所有工具的启用状态
   * 一次性把该分类的工具 ID 全部按传入的 is_enabled 写入
   */
  safeHandle(IPC_CHANNELS.TOOL_ASSIGN_CATEGORY_TO_EMPLOYEE, (params: ToolCategoryAssignParams) => {
    const categoryDef = TOOL_CATEGORY_DEFS.find(c => c.id === params.category_id)
    if (!categoryDef) {
      return { success: false, error: `未知的工具分类: ${params.category_id}` }
    }

    const enabled = params.is_enabled !== false ? 1 : 0
    const toolIds = categoryDef.toolIds

    // 批量 SQL 写入：因为预编译语句最多支持 20 组 values，按批处理
    for (let offset = 0; offset < toolIds.length; offset += 20) {
      const batch = toolIds.slice(offset, offset + 20)
      const bindParams: any[] = []
      for (const tid of batch) {
        bindParams.push(generateId(), params.employee_id, tid, enabled)
      }
      // 动态构造该批次大小的 SQL
      const placeholders = batch.map(() => '(?, ?, ?, ?)').join(', ')
      const sql = `INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES ${placeholders} ON CONFLICT(employee_id, tool_id) DO UPDATE SET is_enabled = excluded.is_enabled`
      db.prepare(sql).run(...bindParams)
    }

    EmployeeAgentService.getInstance().clearAgentCache(params.employee_id)
    return { success: true, affected_tool_count: toolIds.length }
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
