import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as os from 'os'
import { IS_WINDOWS, runCommandPlatform, truncateOutput } from './exec-shared'
import { getWorkspacePath } from './fs-shared'
import { emptyWorkspaceRoot } from '../../sandbox.service'

/** 探测的命令行工具清单（版本探测统一用 --version） */
const PROBE_CANDIDATES = [
  'node', 'npm', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'pip', 'uv',
  'git', 'rg', 'docker',
  'go', 'cargo', 'java', 'gcc', 'make',
]

const PROBE_TIMEOUT_MS = 30_000
const MAX_VERSION_CHARS = 120

/**
 * 探测本机环境与可用命令行工具。
 * 命令为固定字面量、不含任何外部输入，因此不经过 shell_exec 的命令策略判定（无注入面），
 * 但与 shell_exec 共用同一套文件沙箱（只读探测，可写边界取工作区）。
 */
export const envProbeTool: ToolDefinition = {
  id: 'env_probe',
  name: 'env_probe',
  title: '环境探测',
  summary: 'Probe the OS, shell, workspace, and availability/version of common command-line tools (node, python, git, etc.).',
  description: `Probe the execution environment and return the OS, shell type, working directory, and whether common command-line tools are installed (node, npm, pnpm, python, pip, uv, git, rg, docker, go, cargo, java, gcc, make).

When to use:
- Once before running external commands, to avoid the wrong runtime or repeated blind attempts.
- Before installing dependencies, running scripts, or building a project, to choose the available toolchain.
- Takes no arguments, is read-only, and modifies no files.`,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const shellDesc = IS_WINDOWS
      ? 'PowerShell（优先 pwsh 7，回退 powershell.exe 5.1）'
      : '/bin/bash'
    // 无工作区上下文时用空目录当可写边界，避免把应用目录当沙箱（沙箱会改目录 ACL）
    const workspacePath = getWorkspacePath()
    // 工作区懒创建：任务未写过文件时目录还不存在，spawn 会因 cwd 缺失失败，探测改用临时目录兜底
    const workspaceMissing = !!workspacePath && !fs.existsSync(workspacePath)
    const sandboxRoot = workspacePath && !workspaceMissing ? workspacePath : emptyWorkspaceRoot()

    const lines: string[] = [
      '# 环境探测',
      `- 操作系统: ${os.platform()} ${os.release()} (${os.arch()})`,
      `- Shell: ${shellDesc}`,
      `- 当前工作目录: ${sandboxRoot}`,
      `- 路径分隔符: ${IS_WINDOWS ? '\\' : '/'}；换行: ${IS_WINDOWS ? 'CRLF' : 'LF'}`,
      `- 宿主运行时: Node.js ${process.version}（Electron 内置，非系统 Node）`,
    ]
    if (workspaceMissing) {
      lines.push(`- 注意: 任务工作区 ${workspacePath} 尚未创建（首次写入文件时自动创建），本次探测在临时目录执行`)
    }

    const probe = await runCommandPlatform(buildProbeScript(), {
      cwd: sandboxRoot,
      workspaceRoot: sandboxRoot,
      timeoutMs: PROBE_TIMEOUT_MS,
    })

    const found: Array<{ name: string; version: string }> = []
    const missing: string[] = []
    for (const raw of probe.stdout.split(/\r?\n/)) {
      const m = raw.match(/^([A-Za-z0-9_.-]+)::(OK|MISSING)(?:::([\s\S]*))?$/)
      if (!m) continue
      if (m[2] === 'OK') {
        found.push({ name: m[1], version: (m[3] || '').trim().slice(0, MAX_VERSION_CHARS) || '(无版本输出)' })
      } else {
        missing.push(m[1])
      }
    }

    if (found.length + missing.length === 0) {
      const detail = truncateOutput((probe.stderr || probe.stdout || '').trim(), 1000) || '(无输出)'
      return { success: false, error: `环境探测未取得结果（退出码 ${probe.code ?? 'null'}）:\n${detail}` }
    }

    lines.push('', '## 已安装的命令行工具')
    if (found.length === 0) lines.push('- （无）')
    for (const f of found) lines.push(`- ${f.name}: ${f.version}`)

    lines.push('', '## 未安装')
    lines.push(missing.length > 0 ? `- ${missing.join(', ')}` : '- （无，全部可用）')

    lines.push(
      '',
      '## 使用建议',
      `- 执行命令统一用 shell_exec（${IS_WINDOWS ? 'Windows 为 PowerShell 语法' : 'Unix 为 bash 语法'}），路径可用 \\ 或 /。`,
      '- 优先使用上表「已安装」的工具链；缺依赖时先安装再运行，不要反复盲试不存在的命令。',
    )

    return { success: true, output: lines.join('\n') }
  },
  source: 'builtin',
  permission: 'safe',
  onDemand: true,
  noRetry: true,
  timeoutMs: PROBE_TIMEOUT_MS + 5000,
}

/** 单次 shell 调用内串行探测全部候选工具，避免逐个起进程 */
function buildProbeScript(): string {
  if (IS_WINDOWS) {
    const targets = PROBE_CANDIDATES.map(t => `'${t}'`).join(',')
    return `$targets = @(${targets})
foreach ($t in $targets) {
  $cmd = Get-Command $t -CommandType Application -ErrorAction SilentlyContinue
  if ($cmd) {
    $v = (& $t --version 2>&1 | Select-Object -First 1)
    Write-Output "\${t}::OK::\${v}"
  } else {
    Write-Output "\${t}::MISSING"
  }
}
$LASTEXITCODE = 0`
  }
  return PROBE_CANDIDATES.map(t => `if command -v "${t}" >/dev/null 2>&1; then echo "${t}::OK::$("${t}" --version 2>&1 | head -n 1)"; else echo "${t}::MISSING"; fi`).join('\n')
}
