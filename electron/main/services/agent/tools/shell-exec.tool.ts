import type { ToolDefinition } from './types'
import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import { isPathInWorkspace, confirmOutsideWorkspace, getWorkspacePath } from './fs-tools'

const execAsync = promisify(execCb)
const IS_WINDOWS = process.platform === 'win32'

const dangerousPatterns = [
  /\brm\s+-[rf]{1,2}\b/i, /\bdel\s+\/f\b/i, /\brmdir\s+\/s\b/i,
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\breboot\b/i, /:.*?\(\)\s*\{.*?\};\s*:/,
]

// 删除类命令模式
const fileDeletionPatterns = [
  /\brm\s+/i, /\bdel\s+/i, /\brmdir\s+/i, /\berase\s+/i,
  /\bRemove-Item\b/i, /\brd\s+\/s/i, /\brd\s+\/q/i,
]

// 写入/新建/移动/复制类命令模式
const fileWritePatterns = [
  /\bcopy\s+/i, /\bcp\s+/i,                          // 复制
  /\bmove\s+/i, /\bmv\s+/i,                          // 移动/重命名
  /\bxcopy\s+/i, /\brobocopy\s+/i,                   // Windows 批量复制
  /\bCopy-Item\b/i, /\bMove-Item\b/i,                // PowerShell 复制/移动
  /\bSet-Content\b/i, /\bAdd-Content\b/i,            // PowerShell 写入
  /\bOut-File\b/i,                                   // PowerShell 输出到文件
  /\bNew-Item\b/i,                                   // PowerShell 新建
  /\bmkdir\s+/i, /\bmd\s+/i,                         // 新建目录
  /\btouch\s+/i,                                     // 新建空文件
  /\btee\s+/i,                                       // 写入
]

function isFileDeletionCommand(command: string): boolean {
  return fileDeletionPatterns.some(p => p.test(command))
}

/** 检测重定向写入（> file, >> file），避免误匹配比较运算符 */
function hasRedirection(command: string): boolean {
  // 匹配 > 或 >> 后紧跟路径首字符（盘符/斜杠/引号/点），排除 2>&1 等句柄重定向
  return /(^|[\s|&;(])>>?\s*(?=[A-Za-z"'/])/.test(command)
}

function isFileWriteCommand(command: string): boolean {
  return fileWritePatterns.some(p => p.test(command)) || hasRedirection(command)
}

/** 从命令中提取绝对路径（用于非工作区确认） */
function extractPathsFromCommand(command: string): string[] {
  const paths: string[] = []
  let m: RegExpExecArray | null
  // 1. 引号包裹的绝对路径
  const quotedRe = /["']([A-Za-z]:[\\/][^"'\n]*|\/[^"'\n]+)["']/g
  while ((m = quotedRe.exec(command)) !== null) paths.push(m[1])
  // 2. 重定向后的路径
  const redirRe = /(?:>>|>)\s*([A-Za-z]:[\\/][^\s|&;\n]+|\/[^\s|&;\n]+)/g
  while ((m = redirRe.exec(command)) !== null) paths.push(m[1])
  // 3. 未引用的绝对路径（Windows 盘符 或 Unix 常见根目录）
  const unquotedRe = /\b([A-Za-z]:[\\/][^\s|&;,\n]+|\/(?:home|tmp|usr|var|etc|root|opt|mnt|srv|Users|ProgramData|Windows)[^\s|&;,\n]*)/g
  while ((m = unquotedRe.exec(command)) !== null) paths.push(m[1])
  return [...new Set(paths)]
}

export const shellExecTool: ToolDefinition = {
  id: 'shell_exec',
  name: 'shell_exec',
  title: 'Shell命令执行',
  summary: `执行系统 shell 命令（${IS_WINDOWS ? 'PowerShell/CMD' : 'Bash'}）。运行系统命令、脚本时使用。`,
  description: `执行系统shell命令。${IS_WINDOWS ? 'Windows环境，支持PowerShell/CMD。' : '类Unix环境，支持Bash。'}`,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的shell命令' },
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

      const isDeletion = isFileDeletionCommand(command)
      const isWrite = isFileWriteCommand(command)
      const isModify = isDeletion || isWrite

      const ctx = interactionContext.getStore()
      const highPermission = !!ctx?.highPermission

      if (isModify && !highPermission) {
        // 提取命令中的绝对路径，对非工作区路径弹窗确认
        const paths = extractPathsFromCommand(command)
        const nonWorkspacePaths = paths.filter(p => !isPathInWorkspace(p))

        if (nonWorkspacePaths.length > 0) {
          // 涉及工作区外文件：逐个确认（覆盖删除/写入/新建/移动/复制）
          if (!ctx) {
            const op = isDeletion ? '删除' : '修改'
            return { success: false, error: `文件${op}操作涉及工作区外路径，但当前无交互上下文（可能是后台任务），已拒绝执行` }
          }
          const operation = isDeletion ? '删除' : '修改'
          for (const p of nonWorkspacePaths) {
            const result = await confirmOutsideWorkspace(operation, p)
            if (!result.ok) return { success: false, error: result.error }
          }
        } else if (isDeletion) {
          // 工作区内删除：保留原有命令级确认逻辑
          if (!ctx) {
            return { success: false, error: '删除类命令需要用户确认，但当前无交互上下文（可能是后台任务），已拒绝执行' }
          }
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

      const employeeWorkspace = getWorkspacePath()
      const cwd = args.working_dir || employeeWorkspace || process.cwd()
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

      // 收集可预览的生成文件（仅从命令中已提取的绝对路径中收集）
      const generatedFiles: any[] = []
      const PREVIEWABLE_EXTS = new Set([
        'docx', 'docm', 'dotx', 'dotm', 'doc', 'rtf', 'odt',
        'xlsx', 'xltx', 'xlsm', 'xlsb', 'xls', 'csv', 'ods',
        'pptx', 'pptm', 'potx', 'ppsx', 'ppsm', 'odp',
        'pdf', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'yaml', 'yml',
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp',
      ])
      const candidatePaths = extractPathsFromCommand(command)
      for (const p of candidatePaths) {
        try {
          const resolved = path.resolve(p)
          if (!fs.existsSync(resolved)) continue
          const stat = fs.statSync(resolved)
          if (!stat.isFile()) continue
          const ext = path.extname(resolved).slice(1).toLowerCase()
          if (!PREVIEWABLE_EXTS.has(ext)) continue
          generatedFiles.push({
            path: resolved,
            name: path.basename(resolved),
            ext,
            size: stat.size,
            mtime: stat.mtimeMs,
          })
        } catch { /* 忽略单个文件检查失败 */ }
      }

      return { success: true, output: finalOutput, generatedFiles }
    } catch (error: any) {
      return {
        success: false,
        error: `命令执行失败: ${error.message || error}`,
        stderr: error.stderr || '',
        stdout: error.stdout || ''
      }
    }
  },
  source: 'builtin',
  onDemand: true,
}
