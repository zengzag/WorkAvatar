import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  ProjectListParams,
  ProjectCreateParams,
  ProjectUpdateParams,
  FileListParams,
  FileImportParams,
  FileParseParams,
  FileGetContentParams,
} from '../../shared/ipc-channels'
import type ProjectManagerService from '../services/project-manager.service'
import type FileParserService from '../services/file-parser.service'
import type KnowledgeBaseService from '../services/kb.service'

export function registerProjectHandlers(
  projectManager: ProjectManagerService,
  fileParser: FileParserService,
  kbService: KnowledgeBaseService,
) {
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, (_, params?: ProjectListParams) => {
    return projectManager.getProjectList(params?.limit, params?.offset)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, (_, id: string) => {
    return projectManager.getProject(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, (_, params: ProjectCreateParams) => {
    return projectManager.createProject(params.name, params.description, params.root_path)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPDATE, (_, params: ProjectUpdateParams) => {
    const { id, ...data } = params
    return projectManager.updateProject(id, data)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, (_, id: string) => {
    return projectManager.deleteProject(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, (_, params: FileListParams) => {
    return projectManager.getFileList(params.project_id, params.status)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_GET, (_, id: string) => {
    return projectManager.getFile(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_IMPORT, async (_, params: FileImportParams) => {
    const imported = []
    const errors = []

    await kbService.syncForProject(params.project_id)

    for (const filePath of params.paths) {
      try {
        const { kbDocId, reused } = await kbService.importOrSyncToKB(filePath, params.project_id)

        const result = await fileParser.importFile(params.project_id, filePath)
        if (reused && kbDocId) {
          const contentText = kbService.getDocumentContent(kbDocId)
          const parsedJson = kbService.getParsedJson(kbDocId)
          if (contentText && parsedJson) {
            fileParser.updateFileFromKB(result.id, contentText, parsedJson)
          }
        }
        imported.push(result)
      } catch (error) {
        errors.push({
          path: filePath,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return { success: imported.length > 0, imported, errors }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, (_, id: string) => {
    return projectManager.deleteFile(id)
  })

  ipcMain.handle(IPC_CHANNELS.FILE_PARSE, async (_, params: FileParseParams) => {
    try {
      const result = await fileParser.parseFile(params.file_id)
      try {
        const fileRow = projectManager.getFile(params.file_id)
        if (fileRow) {
          await kbService.importOrSyncToKB(
            fileRow.path,
            fileRow.project_id,
            { contentText: result.fullText.substring(0, 100000), parsedJson: JSON.stringify(result) }
          )
        }
      } catch {}
      return { success: true, result }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_GET_CONTENT, (_, params: FileGetContentParams) => {
    const content = fileParser.getFileContent(params.file_id)
    return {
      success: content !== null,
      content: content || undefined,
    }
  })
}
