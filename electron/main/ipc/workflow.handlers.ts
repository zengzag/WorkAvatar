import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { WorkflowCreateParams, WorkflowUpdateParams } from '../../shared/ipc-channels'
import type WorkflowService from '../services/workflow.service'

export function registerWorkflowHandlers(workflowService: WorkflowService) {
  ipcMain.handle(IPC_CHANNELS.WORKFLOW_LIST, (_event) => {
    return workflowService.listWorkflows()
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_GET, (_, id: string) => {
    return workflowService.getWorkflow(id)
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_CREATE, (_, params: WorkflowCreateParams) => {
    return workflowService.createWorkflow(params)
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_UPDATE, (_, params: WorkflowUpdateParams) => {
    const { id, ...data } = params
    return workflowService.updateWorkflow(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_DELETE, (_, id: string) => {
    return workflowService.deleteWorkflow(id)
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_EXECUTE, async (event, workflowId: string) => {
    try {
      const mainWindow = BrowserWindow.fromWebContents(event.sender)!
      const executionId = await workflowService.executeWorkflow(workflowId, mainWindow)
      return { success: true, executionId }
    } catch (error: any) {
      return { success: false, error: error.message || String(error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.WORKFLOW_ABORT_EXECUTION, (_, executionId: string) => {
    return workflowService.abortExecution(executionId)
  })
}
