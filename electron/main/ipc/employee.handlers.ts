import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  EmployeeDeleteParams,
  ConversationListParams,
  ConversationCreateParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
  EmployeeMemoryListParams,
  EmployeeMemoryCreateParams,
  EmployeeMemoryUpdateParams,
  EmployeeMemorySearchParams,
  EmployeeMemoryExtractParams,
  EmployeeMemoryConsolidateParams,
  EmployeeMemoryStatsParams,
} from '../../shared/ipc-channels'
import type WorkspaceManagerService from '../services/workspace-manager.service'
import type EmployeeProfilingService from '../services/employee-profiling.service'
import type EmployeeExportService from '../services/employee-export.service'
import type EmployeeMemoryService from '../services/employee-memory.service'
import { safeHandle } from './_shared'

export function registerEmployeeHandlers(
  workspaceManager: WorkspaceManagerService,
  profilingService: EmployeeProfilingService,
  employeeExportService: EmployeeExportService,
  memoryService: EmployeeMemoryService
) {
  safeHandle(IPC_CHANNELS.EMPLOYEE_LIST, (params?: EmployeeListParams) => {
    return workspaceManager.getEmployeeList(params?.status)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_GET, (id: string) => {
    return workspaceManager.getEmployee(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_CREATE, (params: EmployeeCreateParams) => {
    return workspaceManager.createEmployee(params.name, params.description, params.profile_json)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_UPDATE, (params: EmployeeUpdateParams) => {
    const { id, ...data } = params
    return workspaceManager.updateEmployee(id, data)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_DELETE, (params: EmployeeDeleteParams) => {
    return workspaceManager.deleteEmployee(params.id, params.delete_workspace || false)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_LIST, (params: ConversationListParams) => {
    return workspaceManager.getConversationList(params.employee_id)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_GET, (id: string) => {
    return workspaceManager.getConversation(id)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_CREATE, (params: ConversationCreateParams) => {
    return workspaceManager.createConversation(params.employee_id, params.skill_id, params.title, params.minimal_mode)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_UPDATE, (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number }) => {
    const { id, ...data } = params
    return workspaceManager.updateConversation(id, data)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_DELETE, (id: string) => {
    return workspaceManager.deleteConversation(id)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_DELETE_ALL, (employeeId: string) => {
    return workspaceManager.deleteAllConversations(employeeId)
  })

  // 需要事件回调推送进度，保留 ipcMain.handle + try-catch
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_PROFILE_ANALYZE, async (event, params: EmployeeProfileAnalyzeParams) => {
    try {
      const result = await profilingService.analyzeForEmployee(
        'new',
        params.collection_ids,
        params.provider_id,
        params.model_id,
        params.additional_context,
        (data) => {
          event.sender.send(IPC_CHANNELS.EMPLOYEE_PROFILE_PROGRESS, data)
        }
      )
      return { success: true, profile: result.profile, analysisMethod: result.analysisMethod, warning: result.error, messages: result.messages }
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
      return { success: true, profile: result.profile, messages: result.messages, warning: result.error }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_EXPORT_CONFIG, (params: EmployeeExportConfigParams) => {
    return employeeExportService.exportConfig(params.employee_id, params.export_path)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_IMPORT_CONFIG, (params: EmployeeImportConfigParams) => {
    return employeeExportService.importConfig(params.import_path, params.conflict_strategy)
  })

  // 需要事件回调推送进度，保留 ipcMain.handle；try-catch 兜底确保返回统一错误协议
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_EXPORT_PACKAGE, async (event, params: EmployeeExportPackageParams) => {
    try {
      return await employeeExportService.exportPackage(
        params.employee_id,
        params.export_path,
        (stage, detail) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.EMPLOYEE_EXPORT_PROGRESS, { employee_id: params.employee_id, stage, detail })
          }
        }
      )
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_IMPORT_PACKAGE, async (event, params: EmployeeImportPackageParams) => {
    try {
      return await employeeExportService.importPackage(
        params.import_path,
        params.conflict_strategy,
        (stage, detail) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.EMPLOYEE_IMPORT_PROGRESS, { stage, detail })
          }
        }
      )
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) }
    }
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_LIST, (params: EmployeeMemoryListParams) => {
    return memoryService.listMemories(params.employee_id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_CREATE, (params: EmployeeMemoryCreateParams) => {
    return memoryService.createMemory(params)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_UPDATE, (params: EmployeeMemoryUpdateParams) => {
    const { id, ...data } = params
    return memoryService.updateMemory(id, data)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_DELETE, (id: string) => {
    return memoryService.deleteMemory(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_TOGGLE_PIN, (id: string) => {
    return memoryService.togglePin(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_SEARCH, (params: EmployeeMemorySearchParams) => {
    return memoryService.searchMemories(params.employee_id, params.query, params.limit)
  })

  // 业务语义错误返回 { success: false, error }，与 safeHandle 的 { error } 不同，保留原 try-catch
  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_MEMORY_EXTRACT, async (_, params: EmployeeMemoryExtractParams) => {
    try {
      const result = await memoryService.extractMemoriesFromConversation(
        params.employee_id,
        params.messages,
        params.provider_id,
        params.model_id,
        params.conversation_id
      )
      return { success: true, memories: result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_MEMORY_CONSOLIDATE, async (_, params: EmployeeMemoryConsolidateParams) => {
    try {
      const result = await memoryService.consolidateMemories(
        params.employee_id,
        params.provider_id,
        params.model_id
      )
      return { success: true, ...result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_STATS, (params: EmployeeMemoryStatsParams) => {
    return memoryService.getMemoryStats(params.employee_id)
  })
}
