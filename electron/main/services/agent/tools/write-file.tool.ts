import type { ToolDefinition } from '../tool.types'
import * as fs from 'fs'
import * as path from 'path'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'
import ProjectManagerService from '../../project-manager.service'

function isPathInProject(filePath: string): boolean {
  try {
    const ctx = interactionContext.getStore()
    if (!ctx || !ctx.projectId) return false

    const projectManager = ProjectManagerService.getInstance()
    const project = projectManager.getProject(ctx.projectId)
    if (!project || !project.root_path) return false

    const resolved = path.resolve(filePath)
    const workspaceRoot = path.resolve(project.root_path)
    return resolved.startsWith(workspaceRoot + path.sep) || resolved === workspaceRoot
  } catch {
    return false
  }
}

export const writeFileTool: ToolDefinition = {
  id: 'write_file',
  name: 'write_file',
  title: '写入文件',
  description: '将内容写入本地文件，自动创建父目录。写入工作区外需用户确认。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
      content: { type: 'string', description: '要写入的内容' }
    },
    required: ['path', 'content']
  },
  handler: async (args: any) => {
    try {
      const filePath = String(args.path || '').trim()
      if (!filePath) return { success: false, error: '文件路径不能为空' }

      const resolved = path.resolve(filePath)

      if (!isPathInProject(resolved)) {
        const ctx = interactionContext.getStore()
        if (ctx) {
          try {
            const interactionService = UnifiedInteractionService.getInstance()
            const response = await interactionService.request({
              type: 'confirm',
              title: '确认写入项目外文件',
              message: `即将写入项目工作区外的文件：\n\n${resolved}\n\n此操作可能影响项目外的文件，是否确认？`,
              danger: true,
              source: 'security:write_outside_project',
            })

            if (response.cancelled || response.confirmed !== true) {
              return { success: false, error: '用户取消了写入项目外文件的操作' }
            }
          } catch {
            return { success: false, error: '写入确认失败，操作已取消' }
          }
        }
      }

      const dir = path.dirname(resolved)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      fs.writeFileSync(resolved, String(args.content || ''), 'utf-8')
      return { success: true, output: `成功写入 ${resolved}，共 ${String(args.content || '').length} 字符` }
    } catch (error: any) {
      return { success: false, error: `写入文件失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
