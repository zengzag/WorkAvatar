import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  EmployeeCreateParams,
  EmployeeUpdateParams,
  EmployeeDeleteParams,
  ConversationListParams,
  ConversationListWithEmployeeParams,
  ConversationCreateParams,
  ConversationSearchParams,
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
  EmployeeMemoryExtractConversationParams,
} from '../../shared/ipc-channels'
import type WorkspaceManagerService from '../services/workspace-manager.service'
import type EmployeeProfilingService from '../services/employee-profiling.service'
import type EmployeeExportService from '../services/employee-export.service'
import type EmployeeMemoryService from '../services/employee-memory.service'
import UnifiedInteractionService from '../services/unified-interaction.service'
import MemoryRefinementService from '../services/memory-refinement.service'
import AutomationService from '../services/automation/automation.service'
import EmployeeAgentService from '../services/employee-agent.service'
import { safeHandle } from './_shared'

export function registerEmployeeHandlers(
  workspaceManager: WorkspaceManagerService,
  profilingService: EmployeeProfilingService,
  employeeExportService: EmployeeExportService,
  memoryService: EmployeeMemoryService
) {
  safeHandle(IPC_CHANNELS.EMPLOYEE_LIST, () => {
    return workspaceManager.getEmployeeList()
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_GET, (id: string) => {
    return workspaceManager.getEmployee(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_CREATE, (params: EmployeeCreateParams) => {
    return workspaceManager.createEmployee(params.name, params.description, params.profile_json)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_UPDATE, (params: EmployeeUpdateParams) => {
    const { id, ...data } = params
    const result = workspaceManager.updateEmployee(id, data)
    // 员工配置变更后清除 Agent 缓存，避免使用过期的 system prompt / 配置
    if (result) {
      try { EmployeeAgentService.getInstance().clearAgentCache(id) } catch { /* ignore */ }
    }
    return result
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_DELETE, (params: EmployeeDeleteParams) => {
    const ok = workspaceManager.deleteEmployee(params.id, params.delete_workspace || false)
    if (ok) {
      // 删除员工时清除关联的 Agent 缓存
      try { EmployeeAgentService.getInstance().clearAgentCache(params.id) } catch { /* ignore */ }
    }
    return ok
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_LIST, (params: ConversationListParams) => {
    return workspaceManager.getConversationList(params?.employee_id)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_LIST_ALL, (params?: ConversationListWithEmployeeParams) => {
    return workspaceManager.getAllConversationsWithEmployee(params)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_GET, (id: string) => {
    return workspaceManager.getConversation(id)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_CREATE, (params: ConversationCreateParams) => {
    return workspaceManager.createConversation(params.employee_id, params.skill_id, params.title, params.minimal_mode)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_UPDATE, (params: { id: string; title?: string; messages_json?: string; message_count?: number; status?: string; minimal_mode?: boolean; last_message_at?: number; employee_id?: string; context_stats_json?: string }) => {
    const { id, ...data } = params
    return workspaceManager.updateConversation(id, data)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_DELETE, (id: string) => {
    // 删除前先收集所有子会话 ID（含自身），用于清理授权缓存
    const allConvIds = workspaceManager.getChildConversationIds(id)
    const result = workspaceManager.deleteConversation(id)
    if (result.ok) {
      // 清理该会话及其所有子会话的 allowAlways 授权缓存，避免授权残留
      for (const cid of allConvIds) {
        UnifiedInteractionService.getInstance().clearAllowedSources(cid)
      }
      // 同步删除自动化执行历史中关联的记录（双向同步：员工对话删除 → 自动化历史删除）
      try { AutomationService.getInstance().deleteRunByConversation(id) } catch { /* ignore */ }
    }
    return result
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_DELETE_ALL, (employeeId: string) => {
    // 收集该员工下所有顶层会话及其子会话，清理授权缓存和自动化历史关联记录
    const conversations = workspaceManager.getConversationList(employeeId)
    for (const conv of conversations) {
      const allConvIds = workspaceManager.getChildConversationIds(conv.id)
      for (const cid of allConvIds) {
        UnifiedInteractionService.getInstance().clearAllowedSources(cid)
      }
      // 同步删除自动化执行历史中关联的记录（与 CONVERSATION_DELETE 保持一致）
      try { AutomationService.getInstance().deleteRunByConversation(conv.id) } catch { /* ignore */ }
    }
    return workspaceManager.deleteAllConversations(employeeId)
  })

  safeHandle(IPC_CHANNELS.CONVERSATION_SEARCH_GLOBAL, (params: ConversationSearchParams) => {
    return workspaceManager.searchConversationsGlobal({
      query: params.query,
      employeeIds: params.employee_ids,
      limit: params.limit,
    })
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
        params.context_file,
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
      // 前端可能未传 model_id，统一用 resolveEmployeeLLM 解析
      let providerId = params.provider_id
      let modelId = params.model_id
      if (!providerId || !modelId?.trim()) {
        const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
        if (!resolved) {
          return { success: false, error: 'NO_LLM_PROVIDER' }
        }
        providerId = resolved.providerId
        modelId = resolved.modelId
      }
      const result = await memoryService.extractMemoriesFromConversation(
        params.employee_id,
        params.messages,
        providerId,
        modelId,
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
      // 前端可能未传 model_id（旧版调用方或 provider.model 为空），统一用 resolveEmployeeLLM 解析
      let providerId = params.provider_id
      let modelId = params.model_id
      if (!providerId || !modelId?.trim()) {
        const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
        if (!resolved) {
          return { success: false, error: 'NO_LLM_PROVIDER' }
        }
        providerId = resolved.providerId
        modelId = resolved.modelId
      }
      const result = await memoryService.consolidateMemories(
        params.employee_id,
        providerId,
        modelId
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

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_LIST_TRASH, (params: EmployeeMemoryListParams) => {
    return memoryService.listTrashedMemories(params.employee_id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_RESTORE, (id: string) => {
    return memoryService.restoreMemory(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_PURGE, (id: string) => {
    return memoryService.purgeMemory(id)
  })

  safeHandle(IPC_CHANNELS.EMPLOYEE_MEMORY_EMPTY_TRASH, (params: EmployeeMemoryListParams) => {
    return memoryService.emptyTrash(params.employee_id)
  })

  ipcMain.handle(IPC_CHANNELS.EMPLOYEE_MEMORY_EXTRACT_CONVERSATION, async (_, params: EmployeeMemoryExtractConversationParams) => {
    try {
      const result = await MemoryRefinementService.getInstance().extractManually(params.conversation_id)
      return result
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}
