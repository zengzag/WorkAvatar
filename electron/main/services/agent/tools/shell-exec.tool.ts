import type { ToolDefinition } from './types'
import UnifiedInteractionService, { interactionContext } from '../../unified-interaction.service'
import FilePermissionService from '../../file-permission.service'
import { getWorkspacePath } from './fs-tools'
import {
  decideCommandAccess,
  isFileDeletionCommand,
  isFileWriteCommand,
} from './command-analyzer'
import {
  IS_WINDOWS,
  parseHeredoc,
  runCommandPlatform,
  truncateOutput,
} from './exec-shared'

// 不可逆系统破坏类：硬拦截，不提供确认机会
const dangerousPatterns = [
  /\bformat\s+[a-z]:/i, /\bdiskpart\b/i, /\bdd\s+if=/i,
  /\bshutdown\b/i, /\breboot\b/i, /:.*?\(\)\s*\{.*?\};\s*:/,
  // 编码/混淆执行（绕过检测）：PowerShell 完整形式与别名（-enc/-en 均为 -EncodedCommand 官方缩写；
  // 不拦 -e，避免误伤 -ExecutionPolicy）
  /\b(powershell|pwsh)(\.exe)?\s+[^|;&]*-(encodedcommand|enc|en)\b/i,
  // base64 解码管道执行（Unix 侧编码混淆）
  /\bbase64\s+(?:--|-)?(decode|d)\b[^|]*\|\s*(ba)?sh\b/i,
  /\becho\b[^|]*\|\s*\bbase64\s+(?:--|-)?(decode|d)\b[^|]*\|\s*(ba)?sh\b/i,
  /\bcmd\s+\/c\s+.*\becho\b.*\|.*\bclip\b/i,
  // 危险解释器执行（python/node 已被释放，允许智能体使用系统环境）
  /\bperl\s+-e\b/i,
]

/** 命令是否命中不可逆危险操作（含编码混淆执行），供 handler 与测试共用 */
export function matchesDangerousPattern(scriptContent: string): boolean {
  return dangerousPatterns.some((pattern) => pattern.test(scriptContent))
}

const filePermission = FilePermissionService.getInstance()

/** 构造命令失败时的结构化错误上下文 */
function buildErrorContext(params: {
  command: string
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timeoutSec: number
  cwd: string
}): string {
  const { command, code, signal, stdout, stderr, timeoutSec, cwd } = params
  const lines: string[] = []
  lines.push('## 命令执行失败上下文')
  lines.push('')
  lines.push(`- **退出码**: ${code === null ? '(无，被信号终止)' : code}`)
  if (signal) lines.push(`- **终止信号**: ${signal}`)
  lines.push(`- **超时设置**: ${timeoutSec}s`)
  lines.push(`- **工作目录**: ${cwd}`)
  lines.push('- **命令**:')
  lines.push('```')
  lines.push(command.length > 500 ? command.substring(0, 500) + `\n...(命令共 ${command.length} 字符，已截断)` : command)
  lines.push('```')
  if (stdout && stdout.trim()) {
    lines.push('')
    lines.push('- **stdout (标准输出)**:')
    lines.push('```')
    lines.push(truncateOutput(stdout, 2000) || '(空)')
    lines.push('```')
  }
  if (stderr && stderr.trim()) {
    lines.push('')
    lines.push('- **stderr (标准错误)**:')
    lines.push('```')
    lines.push(truncateOutput(stderr, 2000) || '(空)')
    lines.push('```')
  }
  // 常见退出码诊断
  lines.push('')
  lines.push('### 诊断提示')
  if (code === -2 || signal === 'SIGKILL') lines.push('- 命令已超时或被强制 kill：考虑增大 timeout 参数或拆分长命令')
  else if (code === 127) lines.push('- 退出码 127：命令/解释器不存在，检查命令拼写或 PATH')
  else if (code === 126) lines.push('- 退出码 126：文件不可执行或权限不足')
  else if (code === 2 && IS_WINDOWS) lines.push('- Windows 退出码 2：常见于文件未找到或 PowerShell 语法错误')
  else if (code === 1 && IS_WINDOWS && stderr.toLowerCase().includes('executionpolicy')) {
    lines.push('- Windows 执行策略(ExecutionPolicy)限制：PowerShell 脚本被禁止执行')
    lines.push('- 修复：以管理员身份运行 `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`')
  } else if (code === 1 && IS_WINDOWS && stderr.toLowerCase().includes('not recognized')) {
    lines.push('- 命令未识别：该命令不在系统 PATH 中，或需要安装对应工具')
  } else if (code === 1 && IS_WINDOWS && stderr.toLowerCase().includes('access denied')) {
    lines.push('- 权限不足(Access Denied)：需要管理员权限运行，或文件/目录被锁定')
  } else if (code === 1 && IS_WINDOWS && stderr.toLowerCase().includes('long path')) {
    lines.push('- 路径过长(>260 字符)：Windows 默认路径长度限制，建议将项目移到短路径下')
    lines.push('- 修复：注册表启用长路径支持 `HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\LongPathsEnabled=1`')
  } else if ((code ?? 0) !== 0) lines.push(`- 非零退出码：请根据 stderr 与命令内容定位原因`)
  else lines.push('- 退出码为 0 但报错：常见于 stderr 警告 + 上层业务判断失败')
  return lines.join('\n')
}

export const shellExecTool: ToolDefinition = {
  id: 'shell_exec',
  name: 'shell_exec',
  title: 'Shell命令执行',
  summary: `执行系统 shell 命令（${IS_WINDOWS ? 'PowerShell' : 'Bash'}），用于python/node/git/pip/npm/外部exe等系统级操作。`,
  description:
    `执行系统 shell 命令（${IS_WINDOWS ? 'PowerShell' : 'Bash'}）。

**重要使用规则：**
1. **不要在命令末尾加 echo $LASTEXITCODE/echo EXIT=$?** —— 工具已自动正确返回原生命令退出码，加echo会掩盖真实退出码导致 exit_code=0
2. 多行脚本用 stdin_content 参数，command 仅写解释器（如 python -、bash -s），避免 JSON 引号转义
3. 失败时会自动返回 stderr 全文 + 退出码 + 诊断提示，无需额外探测
4. Windows 统一使用 PowerShell，**自动检测 pwsh.exe (PowerShell 7) 优先，回退 powershell.exe (PowerShell 5.1)**，自动设置 UTF-8 编码
5. **长命令会自动写入临时 .ps1 文件执行**，避免命令行参数长度限制
6. **超时会自动使用 taskkill /T /F 彻底杀死进程树**，避免孤儿进程残留
7. **依赖顺序**：如果需要先写文件再执行命令，**必须串行调用**（同一批内不要同时 file_write 和 shell_exec 依赖刚写的文件，会有竞态）

统一 UTF-8 输出，严格分离 stdout/stderr。`,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          '要执行的 shell 命令。配合 stdin_content 时写解释器（如 python -、bash -s）'
      },
      stdin_content: {
        type: 'string',
        description:
          '可选：通过 stdin 传给命令的内容。多行长脚本写在这里，command 仅写解释器（如 python -）'
      },
      working_dir: { type: 'string', description: '可选的工作目录（绝对路径），不传则使用员工工作区' },
      timeout: {
        type: 'number',
        description: '超时时间（秒），默认 30 秒，最大 300 秒',
        minimum: 1,
        maximum: 300
      }
    },
    required: ['command']
  },
  // 设置工具级超时为 310s（略大于最大 300s），避免 middleware 默认 30s 超时截断用户指定的长命令
  timeoutMs: 310_000,
  handler: async (args: any) => {
    try {
      const command = String(args.command || '').trim()
      const stdinContent: string | undefined =
        typeof args.stdin_content === 'string' && args.stdin_content.length > 0
          ? args.stdin_content
          : undefined

      if (!command && !stdinContent) {
        return { success: false, error: 'command 不能为空（stdin_content 存在时 command 仍需指定解释器，如 python -）' }
      }

      // 安全检查：合并 command + heredoc 解析出的 body + stdin_content 一起检查
      const heredocInfo = parseHeredoc(command)
      const scriptContentForCheck = [
        command,
        heredocInfo?.heredocBody || '',
        stdinContent || ''
      ].join('\n')

      for (const pattern of dangerousPatterns) {
        if (pattern.test(scriptContentForCheck)) {
          return { success: false, error: '命令被安全策略拦截：检测到潜在危险操作' }
        }
      }

      const isDeletion = isFileDeletionCommand(scriptContentForCheck)
      const isWrite = isFileWriteCommand(scriptContentForCheck)
      const isModify = isDeletion || isWrite

      const ctx = interactionContext.getStore()
      const highPermission = !!ctx?.highPermission

      const employeeWorkspace = getWorkspacePath()
      const cwd = args.working_dir || employeeWorkspace || process.cwd()

      if (isModify && !highPermission) {
        // 纯函数决策：区外字面路径批量授权 / cwd 区外目录授权 / 变量目标保守确认 / 区内放行
        const decision = decideCommandAccess({
          command: scriptContentForCheck,
          cwd,
          isDeletion,
          isWrite,
          boundary: {
            isInside: p => filePermission.isPathInWorkspace(p),
            isAuthorized: p => filePermission.isPathAuthorized(p),
          },
        })

        if (decision.kind === 'authorize-paths') {
          const result = await filePermission.authorizeFileOperation(decision.operation, decision.paths)
          if (!result.allowed) return { success: false, error: result.error }
        } else if (decision.kind === 'authorize-dir') {
          // 授权范围就是 cwd 本身（含子树），不能取其父目录
          const result = await filePermission.authorizeFileOperation(
            decision.operation, [decision.dir], { scopeDir: decision.dir },
          )
          if (!result.allowed) return { success: false, error: result.error }
        } else if (decision.kind === 'confirm-command') {
          // 目标含变量/波浪线无法静态归类，或删除命令无具体目标，逐条命令保守确认
          if (!ctx) {
            return { success: false, error: `${decision.operation}类命令需要用户确认，但当前无交互上下文（可能是后台任务），已拒绝执行` }
          }
          try {
            const interactionService = UnifiedInteractionService.getInstance()
            const displayCmd = command.length > 200 ? command.substring(0, 200) + '...' : command
            const response = await interactionService.request({
              type: 'confirm',
              title: `确认执行${decision.operation}命令`,
              message: `即将执行可能${decision.operation === '删除' ? '删除文件' : '写入/修改文件'}的命令，其目标路径含变量引用或无法静态解析，无法判定是否位于工作区内：\n\n${displayCmd}\n\n此操作不可撤销，是否确认执行？`,
              danger: true,
              source: 'security:shell_delete',
            })
            if (response.cancelled || response.confirmed !== true) {
              return { success: false, error: `用户取消了${decision.operation}命令的执行` }
            }
          } catch {
            return { success: false, error: `${decision.operation}命令确认失败，操作已取消` }
          }
        }
        // kind === 'allow'：工作区内删除/写入自动放行（工作区即用户授权的沙箱边界）
      }

      const timeoutSec = Math.min(Math.max(Number(args.timeout) || 30, 1), 300)
      const timeoutMs = timeoutSec * 1000

      const runResult = await runCommandPlatform(command, {
        cwd,
        timeoutMs,
        stdinContent,
      })

      const { stdout, stderr, code, signal } = runResult
      const succeeded = code === 0 && !signal

      // 组装输出：严格分离 stdout / stderr，即使成功也显示 stderr 告警
      const MAX_OUTPUT = 10000
      const sections: string[] = []
      if (stdout && stdout.trim()) {
        sections.push('### stdout')
        sections.push('```')
        sections.push(truncateOutput(stdout, MAX_OUTPUT))
        sections.push('```')
      }
      if (stderr && stderr.trim()) {
        sections.push(succeeded ? '### stderr (警告/提示)' : '### stderr')
        sections.push('```')
        sections.push(truncateOutput(stderr, MAX_OUTPUT))
        sections.push('```')
      }
      if (sections.length === 0) {
        sections.push('(命令执行完成，stdout 与 stderr 均为空)')
      }

      // 元信息行
      const meta: string[] = [`exit_code=${code === null ? 'null' : code}`]
      if (signal) meta.push(`signal=${signal}`)
      if (stdout.length > MAX_OUTPUT) meta.push(`stdout_total=${stdout.length}字符(已截断)`)
      if (stderr.length > MAX_OUTPUT) meta.push(`stderr_total=${stderr.length}字符(已截断)`)
      sections.unshift(`_${meta.join(', ')}_`)
      sections.unshift('')

      const output = sections.join('\n')

      if (!succeeded) {
        const errorCtx = buildErrorContext({
          command,
          code,
          signal,
          stdout,
          stderr,
          timeoutSec,
          cwd,
        })
        return {
          success: false,
          error: `命令执行失败（exit_code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`,
          output: output + '\n\n' + errorCtx,
          stdout,
          stderr,
        }
      }

      return { success: true, output, stdout, stderr }
    } catch (error: any) {
      return {
        success: false,
        error: `命令执行异常: ${error?.message || error}`,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        output: error?.message || String(error),
      }
    }
  },
  source: 'builtin',
  // shell_exec 从按需工具提升为常驻工具：直接加入 LLM tools 数组
  onDemand: false,
}
