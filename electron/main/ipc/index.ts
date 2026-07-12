import { registerWorkspaceHandlers } from './workspace.handlers'
import { registerEmployeeHandlers } from './employee.handlers'
import { registerLLMHandlers } from './llm.handlers'
import { registerAppHandlers } from './app.handlers'
import { registerToolHandlers } from './tool.handlers'
import { registerKMSHandlers } from './kms.handlers'
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

  // 应用启动时初始化 KMS 自动索引（如果已启用）
  KMSService.getInstance().initAutoIndex()

  // 启动定时记忆精炼服务（空闲对话的记忆提取）
  MemoryRefinementService.getInstance().start()
}
