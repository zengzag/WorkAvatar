import { registerWorkspaceHandlers } from './workspace.handlers'
import { registerEmployeeHandlers } from './employee.handlers'
import { registerLLMHandlers } from './llm.handlers'
import { registerAppHandlers } from './app.handlers'
import { registerToolHandlers } from './tool.handlers'
import { registerKBHandlers } from './kb.handlers'
import { registerTaskHandlers } from './task.handlers'
import { registerKBMCPHandlers } from './kb-mcp.handlers'
import { registerKMSHandlers } from './kms.handlers'
import WorkspaceManagerService from '../services/workspace-manager.service'
import LLMClientService from '../services/llm-client.service'
import DatabaseService from '../services/database.service'
import EmployeeProfilingService from '../services/employee-profiling.service'
import ToolEngineService from '../services/tool-engine.service'
import SkillRegistryService from '../services/skill-registry.service'
import EmployeeAgentService from '../services/employee-agent.service'
import KnowledgeBaseService from '../services/kb.service'
import EmployeeExportService from '../services/employee-export.service'
import EmployeeMemoryService from '../services/employee-memory.service'
import KBMCPService from '../services/kb-mcp.service'

export function registerIpcHandlers() {
  const workspaceManager = WorkspaceManagerService.getInstance()
  const llmClient = LLMClientService.getInstance()
  const profilingService = EmployeeProfilingService.getInstance()
  const toolEngine = ToolEngineService.getInstance()
  const skillRegistry = SkillRegistryService.getInstance()
  const employeeAgent = EmployeeAgentService.getInstance()
  const kbService = KnowledgeBaseService.getInstance()
  const employeeExportService = EmployeeExportService.getInstance()
  const memoryService = EmployeeMemoryService.getInstance()
  const mcpService = KBMCPService.getInstance()
  const db = DatabaseService.getInstance().getDb()

  registerWorkspaceHandlers(workspaceManager)
  registerEmployeeHandlers(workspaceManager, profilingService, employeeExportService, memoryService)
  registerLLMHandlers(llmClient, employeeAgent)
  registerAppHandlers(db)
  registerToolHandlers(db, toolEngine, skillRegistry)
  registerKBHandlers(kbService)
  registerTaskHandlers()
  registerKBMCPHandlers(mcpService)
  registerKMSHandlers()
}
