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
import { registerAttachmentHandlers } from './attachment.handlers'
import { registerShellBgHandlers } from './shell-bg.handlers'
import { registerSubagentHandlers } from './subagent.handlers'
import { registerTerminalHandlers } from './terminal.handlers'
import TerminalService from '../services/terminal.service'
import AttachmentService from '../services/attachment.service'
import KMSService from '../services/kms/kms.service'
import WorkspaceManagerService from '../services/workspace-manager.service'
import LLMClientService from '../services/llm-client.service'
import DatabaseService from '../services/database.service'
import EmployeeProfilingService from '../services/employee-profiling.service'
import SkillRegistryService from '../services/skill-registry.service'
import EmployeeAgentService from '../services/employee-agent.service'
import SubAgentProfileService from '../services/sub-agent-profile.service'
import EmployeeExportService from '../services/employee-export.service'
import EmployeeMemoryService from '../services/employee-memory.service'
import MemoryRefinementService from '../services/memory-refinement.service'
import McpRegistryService from '../services/mcp-registry.service'
import PowerSaveService from '../services/power-save.service'
import { createLogger } from '../services/logger'
import { startupMark } from '../services/startup-timer'

const backgroundLogger = createLogger('IPC')

export function registerIpcHandlers() {
  const workspaceManager = WorkspaceManagerService.getInstance()
  const llmClient = LLMClientService.getInstance()
  const profilingService = EmployeeProfilingService.getInstance()
  const skillRegistry = SkillRegistryService.getInstance()
  const employeeAgent = EmployeeAgentService.getInstance()
  const employeeExportService = EmployeeExportService.getInstance()
  const memoryService = EmployeeMemoryService.getInstance()
  const db = DatabaseService.getInstance().getDb()
  startupMark('内核服务单例初始化完成')

  registerWorkspaceHandlers()
  registerEmployeeHandlers(workspaceManager, profilingService, employeeExportService, memoryService)
  registerLLMHandlers(llmClient, employeeAgent)
  registerAppHandlers(db)
  registerToolHandlers(db, skillRegistry)
  registerKMSHandlers()
  registerRuntimeEnvHandlers()
  registerMcpHandlers()
  registerPluginHandlers()
  registerAttachmentHandlers()
  registerShellBgHandlers()
  registerSubagentHandlers()
  registerTerminalHandlers()
  startupMark('IPC handlers 注册完成')

  // 播种内置子智能体模板（explore/general）：幂等刷新，作为开箱即用的委托执行者
  SubAgentProfileService.getInstance().seedBuiltinProfiles()
  // 首次安装播种默认员工「通用专家」（普通员工，仅一次；已有员工的老用户不受影响）
  workspaceManager.ensureDefaultEmployee()
  startupMark('内置子智能体模板与默认员工播种完成')

  // 附件后台维护（存量 base64 迁移为附件引用 + 孤儿文件 GC，异步不阻塞启动）
  AttachmentService.getInstance().startupMaintenance()

  // 初始化防休眠服务（监听窗口显隐/关闭变化，窗口未全部关闭时按需阻止系统熄屏/休眠）
  PowerSaveService.getInstance().init()

  // KMS 自动索引与记忆精炼是后台任务，延后到首屏渲染后再启动：
  // 首次访问 KMS 需打开 1GB 级知识库、加载 jieba 词典，放在启动关键路径上会明显拖慢窗口显示
  setTimeout(() => {
    try {
      KMSService.getInstance().initAutoIndex()
    } catch (err: any) {
      backgroundLogger.error('KMS 自动索引初始化失败:', err?.message || err)
    }
    try {
      MemoryRefinementService.getInstance().start()
    } catch (err: any) {
      backgroundLogger.error('记忆精炼服务启动失败:', err?.message || err)
    }
    startupMark('后台服务启动完成（KMS 自动索引/记忆精炼）')
  }, 3000)

  // 应用退出前清理所有活跃 MCP client、任务终端进程与前台防休眠 blocker
  app.on('before-quit', () => {
    McpRegistryService.getInstance().shutdownAll().catch(() => { /* ignore */ })
    PowerSaveService.getInstance().shutdown()
    TerminalService.getInstance().disposeAll()
  })
}
