import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ToolExecuteParams,
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
} from '../../shared/ipc-channels'
import type DatabaseService from '../services/database.service'
import type ToolEngineService from '../services/tool-engine.service'
import type SkillRegistryService from '../services/skill-registry.service'
import { allBuiltinTools } from '../services/agent/builtin-tools'

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

  ipcMain.handle(IPC_CHANNELS.TOOL_EXECUTE, async (_, params: ToolExecuteParams) => {
    return toolEngine.executeTool(params.tool_id, params.args)
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
    const crypto = require('crypto')
    db.prepare(
      'INSERT INTO employee_tools (id, employee_id, tool_id, is_enabled) VALUES (?, ?, ?, ?) ON CONFLICT(employee_id, tool_id) DO UPDATE SET is_enabled = ?'
    ).run(crypto.randomUUID(), params.employee_id, params.tool_id, params.is_enabled !== false ? 1 : 0, params.is_enabled !== false ? 1 : 0)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.TOOL_REMOVE_FROM_EMPLOYEE, (_, params: { employee_id: string; tool_id: string }) => {
    db.prepare('DELETE FROM employee_tools WHERE employee_id = ? AND tool_id = ?').run(params.employee_id, params.tool_id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_LIST, () => {
    return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all()
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_CREATE, (_, params: MCPServerCreateParams) => {
    const crypto = require('crypto')
    const id = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO mcp_servers (id, name, command, args_json, env_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, params.name, params.command, JSON.stringify(params.args || []), JSON.stringify(params.env || {}), now, now)
    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_UPDATE, (_, params: MCPServerUpdateParams) => {
    const { id, ...data } = params
    const updates: string[] = []
    const values: any[] = []

    if (data.name !== undefined) { updates.push('name = ?'); values.push(data.name) }
    if (data.command !== undefined) { updates.push('command = ?'); values.push(data.command) }
    if (data.args !== undefined) { updates.push('args_json = ?'); values.push(JSON.stringify(data.args)) }
    if (data.env !== undefined) { updates.push('env_json = ?'); values.push(JSON.stringify(data.env)) }
    if (data.is_enabled !== undefined) { updates.push('is_enabled = ?'); values.push(data.is_enabled ? 1 : 0) }

    if (updates.length > 0) {
      updates.push('updated_at = unixepoch()')
      values.push(id)
      db.prepare(`UPDATE mcp_servers SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    }

    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id)
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_DELETE, (_, id: string) => {
    const result = db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return { success: result.changes > 0 }
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_CONNECT, async (_, id: string) => {
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any
    if (!server) return { success: false, error: 'Server not found' }

    const result = await toolEngine.connectMCPServer({
      id: server.id,
      name: server.name,
      command: server.command,
      args: JSON.parse(server.args_json || '[]'),
      env: JSON.parse(server.env_json || '{}'),
      enabled: server.is_enabled === 1,
    })

    if (result.success) {
      db.prepare("UPDATE mcp_servers SET status = 'connected', last_error = NULL, updated_at = unixepoch() WHERE id = ?").run(id)
    } else {
      db.prepare("UPDATE mcp_servers SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?").run(result.error || 'Unknown error', id)
    }

    return result
  })

  ipcMain.handle(IPC_CHANNELS.MCP_SERVER_DISCONNECT, async (_, id: string) => {
    await toolEngine.disconnectMCPServer(id)
    db.prepare("UPDATE mcp_servers SET status = 'disconnected', updated_at = unixepoch() WHERE id = ?").run(id)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_LIST, () => {
    return skillRegistry.getInstalledSkills()
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET, (_, id: string) => {
    return skillRegistry.getSkillById(id)
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

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_TOGGLE, (_, params: { id: string; enabled: boolean }) => {
    skillRegistry.toggleSkill(params.id, params.enabled)
    return { success: true }
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