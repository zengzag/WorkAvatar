import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  WorkspaceInfoParams,
  WorkspaceListFilesParams,
  WorkspaceReadFileParams,
  WorkspaceWriteFileParams,
  WorkspaceCreateFolderParams,
  WorkspaceDeleteItemParams,
  WorkspaceRenameItemParams,
  WorkspaceImportParams,
} from '../../shared/ipc-channels'
import type WorkspaceManagerService from '../services/workspace-manager.service'

export function registerWorkspaceHandlers(
  workspaceManager: WorkspaceManagerService,
) {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_INFO, (_, params: WorkspaceInfoParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.getWorkspaceInfo(employee.workspace_path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_FILES, (_, params: WorkspaceListFilesParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.listWorkspaceFiles(employee.workspace_path, params.sub_path, params.recursive)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, (_, params: WorkspaceReadFileParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.readWorkspaceFile(employee.workspace_path, params.file_path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_WRITE_FILE, (_, params: WorkspaceWriteFileParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.writeWorkspaceFile(employee.workspace_path, params.file_path, params.content)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE_FOLDER, (_, params: WorkspaceCreateFolderParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.createWorkspaceFolder(employee.workspace_path, params.folder_path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE_ITEM, (_, params: WorkspaceDeleteItemParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.deleteWorkspaceItem(employee.workspace_path, params.item_path)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RENAME_ITEM, (_, params: WorkspaceRenameItemParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, error: '工作区路径未设置' }
    return workspaceManager.renameWorkspaceItem(employee.workspace_path, params.item_path, params.new_name)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_IMPORT, (_, params: WorkspaceImportParams) => {
    const employee = workspaceManager.getEmployee(params.employee_id)
    if (!employee || !employee.workspace_path) return { success: false, errors: [{ path: '', error: '工作区路径未设置' }] }
    return workspaceManager.importToWorkspace(employee.workspace_path, params.source_paths, params.target_folder)
  })
}
