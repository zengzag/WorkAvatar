/**
 * 数字员工 MCP server 接入 IPC handlers。
 *
 * 暴露 7 个通道（list/add/update/delete/toggle/test/refresh-tools），
 * 所有写操作完成后会通知 EmployeeAgentService 清除该员工的 agent 缓存，
 * 确保下一次对话使用最新的 MCP 工具配置。
 */

import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  McpSaveParams,
  McpTestParams,
  McpTestResult,
} from '../../shared/ipc-channels'
import McpRegistryService from '../services/mcp-registry.service'
import EmployeeAgentService from '../services/employee-agent.service'
import { safeHandle } from './_shared'
import { createLogger } from '../services/logger'

const logger = createLogger('MCP-Handler')

export function registerMcpHandlers(): void {
  const registry = McpRegistryService.getInstance()
  const agentService = EmployeeAgentService.getInstance()

  // 列出指定员工的所有 MCP server
  safeHandle(IPC_CHANNELS.MCP_LIST, (params: { employee_id: string }) => {
    if (!params?.employee_id) {
      return { error: '缺少 employee_id 参数' }
    }
    return registry.listByEmployee(params.employee_id)
  })

  // 新增 MCP server
  safeHandle(IPC_CHANNELS.MCP_ADD, (params: McpSaveParams) => {
    const result = registry.add(params)
    agentService.clearAgentCache(params.employee_id)
    return result
  })

  // 更新 MCP server 配置
  safeHandle(IPC_CHANNELS.MCP_UPDATE, (params: McpSaveParams) => {
    const result = registry.update(params)
    agentService.clearAgentCache(params.employee_id)
    return result
  })

  // 删除 MCP server
  safeHandle(IPC_CHANNELS.MCP_DELETE, (params: { id: string; employee_id: string }) => {
    registry.delete(params.id)
    agentService.clearAgentCache(params.employee_id)
    return { success: true }
  })

  // 启用 / 禁用 MCP server
  safeHandle(IPC_CHANNELS.MCP_TOGGLE, (params: { id: string; enabled: boolean; employee_id: string }) => {
    const result = registry.toggle(params.id, params.enabled)
    agentService.clearAgentCache(params.employee_id)
    return result
  })

  // 测试连接：每次创建临时 client，不依赖缓存
  safeHandle(IPC_CHANNELS.MCP_TEST, async (params: McpTestParams) => {
    return await registry.testConnection(params.config)
  })

  // 刷新工具缓存：主动连接并 listTools，结果落库
  safeHandle(IPC_CHANNELS.MCP_REFRESH_TOOLS, async (params: { id: string; employee_id: string }) => {
    const result: McpTestResult = await registry.refreshTools(params.id)
    agentService.clearAgentCache(params.employee_id)
    return result
  })

  logger.info('MCP handlers registered')
}
