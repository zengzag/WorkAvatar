import type { ToolDefinition } from '../tool.types'
import ProjectManagerService from '../../project-manager.service'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'

export function createWorkspaceTools(projectId: string): ToolDefinition[] {
  const projectManager = ProjectManagerService.getInstance()
  const project = projectManager.getProject(projectId)
  if (!project) return []

  const workspaceListFiles: ToolDefinition = {
    id: 'workspace_list_files',
    name: 'workspace_list_files',
    title: '列出项目工作区文件',
    description: '列出工作区文件和文件夹，支持子目录和递归。',
    parameters: {
      type: 'object',
      properties: {
        sub_path: { type: 'string', description: '相对于项目工作区的子目录路径，留空表示根目录' },
        recursive: { type: 'boolean', description: '是否递归列出子目录内容（默认false）' },
      },
      required: [],
    },
    handler: (args: any) => {
      return projectManager.listWorkspaceFiles(projectId, args.sub_path, args.recursive)
    },
    source: 'workspace',
  }

  const workspaceReadFile: ToolDefinition = {
    id: 'workspace_read_file',
    name: 'workspace_read_file',
    title: '读取项目工作区文件',
    description: '读取工作区指定文件内容，路径为工作区相对路径。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对于项目工作区的文件路径' },
      },
      required: ['file_path'],
    },
    handler: (args: any) => {
      return projectManager.readWorkspaceFile(projectId, args.file_path)
    },
    source: 'workspace',
  }

  const workspaceWriteFile: ToolDefinition = {
    id: 'workspace_write_file',
    name: 'workspace_write_file',
    title: '写入项目工作区文件',
    description: '向工作区文件写入内容，自动创建父目录，已存在则覆盖。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '相对于项目工作区的文件路径' },
        content: { type: 'string', description: '要写入的文件内容' },
      },
      required: ['file_path', 'content'],
    },
    handler: (args: any) => {
      return projectManager.writeWorkspaceFile(projectId, args.file_path, args.content)
    },
    source: 'workspace',
  }

  const workspaceCreateFolder: ToolDefinition = {
    id: 'workspace_create_folder',
    name: 'workspace_create_folder',
    title: '创建项目工作区文件夹',
    description: '在工作区创建文件夹，自动创建父目录。',
    parameters: {
      type: 'object',
      properties: {
        folder_path: { type: 'string', description: '相对于项目工作区的文件夹路径' },
      },
      required: ['folder_path'],
    },
    handler: (args: any) => {
      return projectManager.createWorkspaceFolder(projectId, args.folder_path)
    },
    source: 'workspace',
  }

  const workspaceDeleteItem: ToolDefinition = {
    id: 'workspace_delete_item',
    name: 'workspace_delete_item',
    title: '删除项目工作区文件或文件夹',
    description: '删除工作区文件或文件夹，需用户确认。',
    parameters: {
      type: 'object',
      properties: {
        item_path: { type: 'string', description: '相对于项目工作区的文件或文件夹路径' },
      },
      required: ['item_path'],
    },
    handler: async (args: any) => {
      const itemPath = String(args.item_path || '').trim()
      if (!itemPath) return { success: false, error: '路径不能为空' }

      const ctx = interactionContext.getStore()
      if (ctx) {
        try {
          const interactionService = UnifiedInteractionService.getInstance()
          const response = await interactionService.request({
            type: 'confirm',
            title: '确认删除',
            message: `即将删除工作区中的 "${itemPath}"，此操作不可撤销。是否确认？`,
            danger: true,
            source: 'security:workspace_delete',
          })

          if (response.cancelled || response.confirmed !== true) {
            return { success: false, error: '用户取消了删除操作' }
          }
        } catch {
          return { success: false, error: '删除确认失败，操作已取消' }
        }
      }

      return projectManager.deleteWorkspaceItem(projectId, args.item_path)
    },
    source: 'workspace',
  }

  const workspaceRenameItem: ToolDefinition = {
    id: 'workspace_rename_item',
    name: 'workspace_rename_item',
    title: '重命名项目工作区文件或文件夹',
    description: '重命名工作区文件或文件夹。',
    parameters: {
      type: 'object',
      properties: {
        item_path: { type: 'string', description: '相对于项目工作区的文件或文件夹路径' },
        new_name: { type: 'string', description: '新的名称（仅文件名/文件夹名，不含路径）' },
      },
      required: ['item_path', 'new_name'],
    },
    handler: (args: any) => {
      return projectManager.renameWorkspaceItem(projectId, args.item_path, args.new_name)
    },
    source: 'workspace',
  }

  return [
    workspaceListFiles,
    workspaceReadFile,
    workspaceWriteFile,
    workspaceCreateFolder,
    workspaceDeleteItem,
    workspaceRenameItem,
  ]
}

export function getWorkspacePrompt(projectId: string): string {
  const projectManager = ProjectManagerService.getInstance()
  const project = projectManager.getProject(projectId)
  if (!project) return ''

  const workspacePath = project.root_path

  return [
    `\n## 项目工作区`,
    `工作区根目录：${workspacePath}`,
    `可用工具：`,
    `  - workspace_list_files：列出文件`,
    `  - workspace_read_file：读取文件`,
    `  - workspace_write_file：写入文件`,
    `  - workspace_create_folder：创建文件夹`,
    `  - workspace_delete_item：删除（需确认）`,
    `  - workspace_rename_item：重命名`,
    `所有路径均为工作区相对路径。`,
  ].join('\n')
}
