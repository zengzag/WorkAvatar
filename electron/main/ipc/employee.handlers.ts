import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  SkillListParams,
  SkillCreateParams,
  SkillUpdateParams,
  ConversationListParams,
  ConversationCreateParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
} from '../../shared/ipc-channels'
import type ProjectManagerService from '../services/project-manager.service'
import type EmployeeProfilingService from '../services/employee-profiling.service'
import type EmployeeExportService from '../services/employee-export.service'

export function registerEmployeeHandlers(
  projectManager: ProjectManagerService,
  profilingService: EmployeeProfilingService,
  employeeExportService: EmployeeExportService
) {
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_LIST, (_, params?: EmployeeListParams) => {
    return projectManager.getEmployeeList(params?.project_id, params?.status)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_GET, (_, id: string) => {
    return projectManager.getEmployee(id)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_CREATE, (_, params: EmployeeCreateParams) => {
    return projectManager.createEmployee(params.project_id, params.name, params.description, params.profile_json)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_UPDATE, (_, params: EmployeeUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateEmployee(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_DELETE, (_, id: string) => {
    return projectManager.deleteEmployee(id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, (_, params: SkillListParams) => {
    return projectManager.getSkillList(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_CREATE, (_, params: SkillCreateParams) => {
    return projectManager.createSkill(
      params.employee_id,
      params.type,
      params.name,
      params.description,
      params.prompt_template
    )
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_UPDATE, (_, params: SkillUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateSkill(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, (_, id: string) => {
    return projectManager.deleteSkill(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST, (_, params: ConversationListParams) => {
    return projectManager.getConversationList(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_GET, (_, id: string) => {
    return projectManager.getConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE, (_, params: ConversationCreateParams) => {
    return projectManager.createConversation(params.employee_id, params.skill_id, params.title)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_UPDATE, (_, params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string }) => {
    const { id, ...data } = params
    return projectManager.updateConversation(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, (_, id: string) => {
    return projectManager.deleteConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE_ALL, (_, employeeId: string) => {
    return projectManager.deleteAllConversations(employeeId)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, async (event, params: EmployeeProfileAnalyzeParams) => {
    try {
      const result = await profilingService.analyzeProjectForEmployee(
        params.project_id,
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
    return employeeExportService.importConfig(params.import_path, params.project_id, params.conflict_strategy)
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
      params.project_id,
      params.conflict_strategy,
      (stage, detail) => {
        event.sender.send(IPC_CHANNELS.EMPLOYEE_IMPORT_PROGRESS, { stage, detail })
      }
    )
  })
}