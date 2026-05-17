import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  ConversationListParams,
  ConversationCreateParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
  EmployeeKBListParams,
  EmployeeKBLinkParams,
  EmployeeKBUnlinkParams,
} from '../../shared/ipc-channels'
import type WorkspaceManagerService from '../services/workspace-manager.service'
import type EmployeeProfilingService from '../services/employee-profiling.service'
import type EmployeeExportService from '../services/employee-export.service'
import type EmployeeAgentService from '../services/employee-agent.service'

export function registerEmployeeHandlers(
  workspaceManager: WorkspaceManagerService,
  profilingService: EmployeeProfilingService,
  employeeExportService: EmployeeExportService,
  employeeAgentService: EmployeeAgentService
) {
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_LIST, (_, params?: EmployeeListParams) => {
    return workspaceManager.getEmployeeList(params?.status)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_GET, (_, id: string) => {
    return workspaceManager.getEmployee(id)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CREATE, (_, params: EmployeeCreateParams) => {
    return workspaceManager.createEmployee(params.name, params.description, params.profile_json)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_UPDATE, (_, params: EmployeeUpdateParams) => {
    const { id, ...data } = params
    return workspaceManager.updateEmployee(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_DELETE, (_, params: string | { id: string; delete_workspace?: boolean }) => {
    if (typeof params === 'string') {
      return workspaceManager.deleteEmployee(params, false)
    }
    return workspaceManager.deleteEmployee(params.id, params.delete_workspace || false)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, (_, params: ConversationListParams) => {
    return workspaceManager.getConversationList(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, (_, id: string) => {
    return workspaceManager.getConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE, (_, params: ConversationCreateParams) => {
    return workspaceManager.createConversation(params.employee_id, params.skill_id, params.title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE, (_, params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string }) => {
    const { id, ...data } = params
    return workspaceManager.updateConversation(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, (_, id: string) => {
    return workspaceManager.deleteConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE_ALL, (_, employeeId: string) => {
    return workspaceManager.deleteAllConversations(employeeId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, async (event, params: EmployeeProfileAnalyzeParams) => {
    try {
      const result = await profilingService.analyzeForEmployee(
        '',
        params.kb_ids,
        params.provider_id,
        params.model_id,
        params.additional_context,
        (data) => {
          event.sender.send(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, data)
        }
      )
      return { success: true, profile: result.profile, analysisMethod: result.analysisMethod, error: result.error, messages: result.messages }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_PROFILE_REFINE, async (event, params: EmployeeProfileRefineParams) => {
    try {
      const result = await profilingService.refineProfileForEmployee(
        params.previous_messages,
        params.previous_profile as any,
        params.feedback,
        params.provider_id,
        params.model_id,
        (data) => {
          event.sender.send(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, data)
        }
      )
      return { success: true, profile: result.profile, messages: result.messages, error: result.error }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXPORT_CONFIG, (_, params: EmployeeExportConfigParams) => {
    return employeeExportService.exportConfig(params.employee_id, params.export_path)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_IMPORT_CONFIG, (_, params: EmployeeImportConfigParams) => {
    return employeeExportService.importConfig(params.import_path, params.conflict_strategy)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXPORT_PACKAGE, async (event, params: EmployeeExportPackageParams) => {
    return employeeExportService.exportPackage(
      params.employee_id,
      params.export_path,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.EMPLOYEE_EXPORT_PROGRESS, { employee_id: params.employee_id, stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_IMPORT_PACKAGE, async (event, params: EmployeeImportPackageParams) => {
    return employeeExportService.importPackage(
      params.import_path,
      params.conflict_strategy,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.EMPLOYEE_IMPORT_PROGRESS, { stage, detail })
      }
    )
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_KB_LIST, (_, params: EmployeeKBListParams) => {
    return workspaceManager.getKBsForEmployee(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_KB_LINK, (_, params: EmployeeKBLinkParams) => {
    const result = workspaceManager.linkKBToEmployee(params.employee_id, params.kb_id)
    if (result) {
      employeeAgentService.clearAgentCache(params.employee_id)
    }
    return result
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_KB_UNLINK, (_, params: EmployeeKBUnlinkParams) => {
    const result = workspaceManager.unlinkKBFromEmployee(params.employee_id, params.kb_id)
    if (result) {
      employeeAgentService.clearAgentCache(params.employee_id)
    }
    return result
  })
}
