import { app } from 'electron'
import { registerWorkspaceHandlers } from './workspace.handlers'
import { registerEmployeeHandlers } from './employee.handlers'
import { registerLLMHandlers } from './llm.handlers'
import { registerAppHandlers } from './app.handlers'
import { registerToolHandlers } from './tool.handlers'
import { registerKMSHandlers } from './kms.handlers'
import { registerRuntimeEnvHandlers } from './runtime-env.handlers'
import { registerMcpHandlers } from './mcp.handlers'
import { registerPluginHandlers } from './plugin.handlers'
import KMSService from '../services/kms/kms.service'
import WorkspaceManagerService from '../services/workspace-manager.service'
import LLMClientService from '../services/llm-client.service'
import DatabaseService from '../services/database.service'
import EmployeeProfilingService from '../services/employee-profiling.service'
import SkillRegistryService from '../services/skill-registry.service'
import EmployeeAgentService from '../services/employee-agent.service'
import EmployeeExportService from '../services/employee-export.service'
import EmployeeMemoryService from '../services/employee-memory.service'
import MemoryRefinementService from '../services/memory-refinement.service'
import McpRegistryService from '../services/mcp-registry.service'
import PowerSaveService from '../services/power-save.service'

export function registerIpcHandlers() {
  const workspaceManager = WorkspaceManagerService.getInstance()
  const llmClient = LLMClientService.getInstance()
  const profilingService = EmployeeProfilingService.getInstance()
  const skillRegistry = SkillRegistryService.getInstance()
  const employeeAgent = EmployeeAgentService.getInstance()
  const employeeExportService = EmployeeExportService.getInstance()
  const memoryService = EmployeeMemoryService.getInstance()
  const db = DatabaseService.getInstance().getDb()

  registerWorkspaceHandlers()
  registerEmployeeHandlers(workspaceManager, profilingService, employeeExportService, memoryService)
  registerLLMHandlers(llmClient, employeeAgent)
  registerAppHandlers(db)
  registerToolHandlers(db, skillRegistry)
  registerKMSHandlers()
  registerRuntimeEnvHandlers()
  registerMcpHandlers()
  registerPluginHandlers()

  // 应用启动时初始化 KMS 自动索引（如果已启用）
  KMSService.getInstance().initAutoIndex()

  // 初始化前台防休眠服务（监听窗口焦点变化，按需阻止系统熄屏/休眠）
  PowerSaveService.getInstance().init()

  // 启动定时记忆精炼服务（空闲对话的记忆提取）
  MemoryRefinementService.getInstance().start()

  // 应用退出前清理所有活跃 MCP client 与前台防休眠 blocker
  app.on('before-quit', () => {
    McpRegistryService.getInstance().shutdownAll().catch(() => { /* ignore */ })
    PowerSaveService.getInstance().shutdown()
  })
}
