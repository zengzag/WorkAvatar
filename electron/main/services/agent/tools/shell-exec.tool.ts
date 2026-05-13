import type { ToolDefinition } from '../tool.types'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import UnifiedInteractionService from '../../unified-interaction.service'
import { interactionContext } from '../../unified-interaction.service'

const execAsync = promisify(execCb)
const IS_WINDOWS = process.platform === 'win32'

const dangerousPatterns = [
  /\brm\s+-[rf]{1,2}\b/i, /\bdel\s+\/f\b/i, /\brmdir\s+\/s\b/i,
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\breboot\b/i, /:.*?\(\)\s*\{.*?\};\s*:/,
]

const fileDeletionPatterns = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brm\s+-/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
]

function isFileDeletionCommand(command: string): boolean {
  return fileDeletionPatterns.some(p => p.test(command))
}

export const shellExecTool: ToolDefinition = {
  id: 'shell_exec',
  name: 'shell_exec',
  title: 'Shell命令执行',
  description: `执行系统shell命令并返回输出。${IS_WINDOWS ? '当前运行在Windows环境，支持PowerShell和CMD命令。' : '当前运行在类Unix环境，支持Bash命令。'}支持常用文件操作、系统信息查询、网络测试等。禁止执行格式化磁盘、删除系统文件等危险操作。涉及文件删除的命令需要用户确认后方可执行。`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的shell命令。Windows下可用dir、type、findstr、ipconfig等；避免使用rm -rf、format等危险命令' },
      working_dir: { type: 'string', description: '可选的工作目录' },
      timeout: { type: 'number', description: '超时时间（秒），默认30秒，最大300秒', minimum: 1, maximum: 300 }
    },
    required: ['command']
  },
  handler: async (args: any) => {
    try {
      const command = String(args.command || '').trim()
      if (!command) return { success: false, error: '命令不能为空' }

      for (const pattern of dangerousPatterns) {
        if (pattern.test(command)) {
          return { success: false, error: '命令被安全策略拦截：检测到潜在危险操作' }
        }
      }

      if (isFileDeletionCommand(command)) {
        const ctx = interactionContext.getStore()
        if (ctx) {
          try {
            const interactionService = UnifiedInteractionService.getInstance()
            const response = await interactionService.request({
              type: 'confirm',
              title: '确认执行删除命令',
              message: `即将执行可能删除文件的命令：\n\n${command.length > 200 ? command.substring(0, 200) + '...' : command}\n\n此操作不可撤销，是否确认执行？`,
              danger: true,
              source: 'security:shell_delete',
            })

            if (response.cancelled || response.confirmed !== true) {
              return { success: false, error: '用户取消了删除命令的执行' }
            }
          } catch {
            return { success: false, error: '删除命令确认失败，操作已取消' }
          }
        }
      }

      const cwd = args.working_dir || process.cwd()
      const timeout = Math.min(Math.max((args.timeout || 30), 1), 300) * 1000

      const { stdout, stderr } = await execAsync(command, {
        cwd, timeout, encoding: 'utf-8', windowsHide: true,
        env: { ...process.env }
      })

      const output: string[] = []
      if (stdout) output.push(stdout)
      if (stderr) output.push(`STDERR:\n${stderr}`)

      const result = output.join('\n') || '(命令执行成功，无输出)'
      const maxOutput = 10000
      const finalOutput = result.length > maxOutput
        ? result.substring(0, maxOutput / 2) + `\n\n... (${result.length - maxOutput} 字符已截断) ...\n\n` + result.substring(result.length - maxOutput / 2)
        : result

      return { success: true, output: finalOutput }
    } catch (error: any) {
      return {
        success: false,
        error: `命令执行失败: ${error.message || error}`,
        stderr: error.stderr || '',
        stdout: error.stdout || ''
      }
    }
  },
  source: 'builtin'
}
