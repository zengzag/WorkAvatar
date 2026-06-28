import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ToolAssignParams,
  SearchOpenWindowParams,
  SearchCloseWindowParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type SkillRegistryService from '../services/skill-registry.service'
import { allBuiltinTools, createKMSTools, createKMSCollectionTools } from '../services/agent/tools'
import { generateId } from '../services/common-utils'
import { internetSearchService } from '../services/internet-search.service'
import { safeHandle } from './_shared'

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
  const kmsCollectionTools = createKMSCollectionTools({ current: [] }).map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'kms_collection' as const,
  }))

  const seen = new Set<string>()
  const unified: Array<{ id: string; name: string; title: string; description: string; category: string }> = []

  for (const tool of [...agentTools, ...kmsTools, ...kmsCollectionTools]) {
    if (!seen.has(tool.id)) {
      seen.add(tool.id)
      unified.push(tool)
    }
  }

  return unified
}

export function registerToolHandlers(
  db: ReturnType<DatabaseService['getDb']>,
  skillRegistry: SkillRegistryService
) {
  safeHandle(IPC_CHANNELS.TOOL_LIST_BUILTIN, () => {
    return getUnifiedBuiltinToolCatalog()
  })

  safeHandle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, (params: { employee_id: string }) => {
    const catalog = getUnifiedBuiltinToolCatalog()

    const enabledRows = db.prepare(
      'SELECT tool_id, is_enabled FROM employee_tools WHERE employee_id = ?'
    ).all(params.employee_id) as any[]

    const enabledMap = new Map<string, boolean>()
    for (const row of enabledRows) {
      enabledMap.set(row.tool_id, row.is_enabled === 1)
    }

    return catalog.map(tool => ({
      ...tool,
      is_enabled: enabledMap.has(tool.id) ? enabledMap.get(tool.id)! : true,
      is_assigned: enabledMap.has(tool.id),
    }))
  })

  safeHandle(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, (params: ToolAssignParams) => {
    db.prepare(
      'INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES (?, ?, ?, ?) ON CONFLICT(employee_id, tool_id) DO UPDATE SET is_enabled = ?'
    ).run(generateId(), params.employee_id, params.tool_id, params.is_enabled !== false ? 1 : 0, params.is_enabled !== false ? 1 : 0)
    return { success: true }
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
      return { success: false, error: error.message }
    }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, async (id: string) => {
    const result = await skillRegistry.uninstallSkill(id)
    return { success: result }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, (params: { employee_id: string }) => {
    return skillRegistry.getEmployeeSkills(params.employee_id)
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, (params: { employee_id: string; skill_id: string }) => {
    skillRegistry.assignSkillToEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, (params: { employee_id: string; skill_id: string }) => {
    skillRegistry.removeSkillFromEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })

  safeHandle(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE_FOR_EMPLOYEE, (params: { employee_id: string; skill_id: string; enabled: boolean }) => {
    skillRegistry.toggleSkillForEmployee(params.skill_id, params.employee_id, params.enabled)
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
      return { success: false, error: error.message }
    }
  })

  safeHandle(IPC_CHANNELS.SEARCH_CLOSE_WINDOW, (params: SearchCloseWindowParams) => {
    internetSearchService.closeSearchWindow(params.engine as any)
    return { success: true }
  })
}
