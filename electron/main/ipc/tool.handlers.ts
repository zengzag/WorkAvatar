import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ToolAssignParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type ToolEngineService from '../services/tool-engine.service'
import type SkillRegistryService from '../services/skill-registry.service'
import { allBuiltinTools } from '../services/agent/tools'
import { generateId } from '../services/common-utils'

function getUnifiedBuiltinToolCatalog() {
  const agentTools = allBuiltinTools.map(t => ({
    id: t.id,
    name: t.name,
    title: t.title,
    description: t.description,
    category: 'agent' as const,
  }))

  const engineTools = toolEngine.getBuiltinTools().map(t => ({
    id: t.id,
    name: t.name,
    title: t.name,
    description: t.description,
    category: 'engine' as const,
  }))

  const seen = new Set<string>()
  const unified: Array<{ id: string; name: string; title: string; description: string; category: string }> = []

  for (const tool of agentTools) {
    if (!seen.has(tool.id)) {
      seen.add(tool.id)
      unified.push(tool)
    }
  }

  for (const tool of engineTools) {
    if (!seen.has(tool.id)) {
      seen.add(tool.id)
      unified.push(tool)
    }
  }

  return unified
}

let toolEngine: ToolEngineService

export function registerToolHandlers(
  db: ReturnType<DatabaseService['getDb']>,
  toolEngineSvc: ToolEngineService,
  skillRegistry: SkillRegistryService
) {
  toolEngine = toolEngineSvc

  ipcMain.handle(IPC_CHANNELS.TOOL_LIST_BUILTIN, () => {
    return getUnifiedBuiltinToolCatalog()
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_GET_EMPLOYEE_TOOLS, (_, params: { employee_id: string }) => {
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

  ipcMain.handle(IPC_CHANNELS.TOOL_ASSIGN_TO_EMPLOYEE, (_, params: ToolAssignParams) => {
    db.prepare(
      'INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES (?, ?, ?, ?) ON CONFLICT(employee_id, tool_id) DO UPDATE SET is_enabled = ?'
    ).run(generateId(), params.employee_id, params.tool_id, params.is_enabled !== false ? 1 : 0, params.is_enabled !== false ? 1 : 0)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_LIST, () => {
    return skillRegistry.getInstalledSkills()
  })

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

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, async (_, id: string) => {
    const result = await skillRegistry.uninstallSkill(id)
    return { success: result }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_EMPLOYEE_SKILLS, (_, params: { employee_id: string }) => {
    return skillRegistry.getEmployeeSkills(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_ASSIGN_TO_EMPLOYEE, (_, params: { employee_id: string; skill_id: string }) => {
    skillRegistry.assignSkillToEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_REMOVE_FROM_EMPLOYEE, (_, params: { employee_id: string; skill_id: string }) => {
    skillRegistry.removeSkillFromEmployee(params.skill_id, params.employee_id)
    return { success: true }
  })
}
