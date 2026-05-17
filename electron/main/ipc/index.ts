import { registerWorkspaceHandlers } from './workspace.handlers'
import { registerEmployeeHandlers } from './employee.handlers'
import { registerLLMHandlers } from './llm.handlers'
import { registerAppHandlers } from './app.handlers'
import { registerToolHandlers } from './tool.handlers'
import { registerKBHandlers } from './kb.handlers'
import { registerTaskHandlers } from './task.handlers'
import { registerEmployeeTaskHandlers } from './employee-task.handlers'
import { registerWorkflowHandlers } from './workflow.handlers'
import WorkspaceManagerService from '../services/workspace-manager.service'
import LLMClientService from '../services/llm-client.service'
import OCRService from '../services/ocr.service'
import DatabaseService from '../services/database.service'
import EmployeeProfilingService from '../services/employee-profiling.service'
import ToolEngineService from '../services/tool-engine.service'
import SkillRegistryService from '../services/skill-registry.service'
import EmployeeAgentService from '../services/employee-agent.service'
import KnowledgeBaseService from '../services/kb.service'
import EmployeeExportService from '../services/employee-export.service'
import EmployeeTaskService from '../services/employee-task.service'
import SchedulerService from '../services/scheduler.service'
import WorkflowService from '../services/workflow.service'

export function registerIpcHandlers() {
  const workspaceManager = WorkspaceManagerService.getInstance()
  const llmClient = LLMClientService.getInstance()
  const ocrService = OCRService.getInstance()
  const profilingService = EmployeeProfilingService.getInstance()
  const toolEngine = ToolEngineService.getInstance()
  const skillRegistry = SkillRegistryService.getInstance()
  const employeeAgent = EmployeeAgentService.getInstance()
  const kbService = KnowledgeBaseService.getInstance()
  const employeeExportService = EmployeeExportService.getInstance()
  const employeeTaskService = EmployeeTaskService.getInstance()
  const schedulerService = SchedulerService.getInstance()
  const workflowService = WorkflowService.getInstance()
  const db = DatabaseService.getInstance().getDb()

  registerWorkspaceHandlers(workspaceManager)
  registerEmployeeHandlers(workspaceManager, profilingService, employeeExportService, employeeAgent)
  registerLLMHandlers(llmClient, employeeAgent)
  registerAppHandlers(db, ocrService)
  registerToolHandlers(db, toolEngine, skillRegistry)
  registerKBHandlers(kbService)
  registerTaskHandlers()
  registerEmployeeTaskHandlers(employeeTaskService, schedulerService)
  registerWorkflowHandlers(workflowService)

  schedulerService.start()
}
