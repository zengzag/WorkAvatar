import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createLogger } from './logger'

const logger = createLogger('Sandbox')

/**
 * 文件沙箱：默认「可读全部 + 只可写工作区」。
 * - Windows：受限令牌（WRITE_RESTRICTED）+ 能力 SID 的目录 ACL + Low 完整性标签，由独立 runner 进程执行
 * - macOS：/usr/bin/sandbox-exec 载入 Seatbelt profile
 * - Linux：bubblewrap（只读根 + 工作区/私有临时目录可写）
 * 判定发生在内核的文件访问检查里，不依赖对命令文本的静态分析。
 */

export type SandboxMode = 'workspace-write' | 'danger-full-access'
export type SandboxBackend = 'windows-acl' | 'seatbelt' | 'bubblewrap' | 'none'
export type SandboxEnforcement = 'full' | 'partial'

export interface SandboxFacts {
  mode: SandboxMode
  backend: SandboxBackend
  /** full=完整覆盖「只可写工作区」；partial=存在已知旁路（如 NTFS 硬链接） */
  enforcement: SandboxEnforcement
  /** 本次执行是否出现过策略拒绝 */
  denied: boolean
}

export interface ConfineInput {
  program: string
  args: readonly string[]
  /** 命令的工作目录（working_dir）；各平台都按它执行，不因沙箱改成工作区 */
  cwd: string
  /** 可写边界：只有该目录子树（+ 私有临时目录）允许写入 */
  workspaceRoot: string
  mode: SandboxMode
}

export interface ConfinedLaunch {
  program: string
  args: string[]
  /** 需要合并进子进程环境变量的覆盖项（TMP/TEMP/TMPDIR 指向私有临时目录） */
  env: NodeJS.ProcessEnv
  facts: SandboxFacts
  /** 进程结束后必须调用：清理私有临时目录与 profile 文件 */
  cleanup: () => void
}

/** 沙箱主体不可用：调用方必须拒绝执行，不能静默降级为无约束运行 */
export class SandboxUnavailableError extends Error {}

/** Windows runner 的失败标记（runner 自身故障，不是命令被策略拒绝） */
const WINDOWS_RUNNER_SIGNATURE = 'workavatar-sandbox:'

/** 各平台的「策略拒绝」方言；命中即视为沙箱拦截（含系统本地化文案与 errno 码） */
const DENIAL_SIGNATURES: Record<string, readonly string[]> = {
  win32: [
    'access is denied',
    'access to the path',
    'permission denied',
    'operation not permitted',
    // Node/Python 等运行时经常只打印 errno 码（ERROR_ACCESS_DENIED → EPERM/EACCES）
    'eperm',
    'eacces',
    '拒绝访问',
    '访问被拒绝',
    '权限不足',
    '未经授权的操作',
  ],
  darwin: [
    'operation not permitted',
    'permission denied',
    'read-only file system',
    'eacces',
    'eperm',
  ],
  linux: [
    'read-only file system',
    'permission denied',
    'operation not permitted',
    'eacces',
    'erofs',
  ],
}

/** stderr 是否表明「沙箱正常生效、命令被策略拒绝」 */
export function isSandboxDenial(stderr: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!stderr) return false
  const text = stderr.toLowerCase()
  const signatures = DENIAL_SIGNATURES[platform] ?? []
  return signatures.some((sig) => text.includes(sig))
}

/** stderr 是否表明沙箱运行器自身故障（命令根本没跑） */
export function isSandboxRunnerFailure(stderr: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!stderr) return false
  if (platform === 'win32') return stderr.includes(WINDOWS_RUNNER_SIGNATURE)
  if (platform === 'darwin') return /(^|\n)sandbox-exec:/.test(stderr)
  if (platform === 'linux') return /(^|\n)bwrap:/.test(stderr)
  return false
}

/** 资源根目录：开发期取项目 resources/，打包后取 extraResources 里的 resources/ */
let cachedResourcesDir: string | undefined
function resourcesDir(): string {
  if (cachedResourcesDir) return cachedResourcesDir
  try {
    // 延迟 require，保证本服务在单测/worker 环境可独立加载
    const { app } = require('electron')
    cachedResourcesDir = app?.isPackaged
      ? path.join(process.resourcesPath, 'resources')
      : path.join(app.getAppPath(), 'resources')
  } catch {
    cachedResourcesDir = path.join(process.cwd(), 'resources')
  }
  return cachedResourcesDir
}

/** Windows runner 可执行文件路径 */
export function windowsRunnerPath(): string {
  return path.join(resourcesDir(), 'sandbox', 'WorkAvatarSandbox.exe')
}

/** macOS Seatbelt 的路径匹配基于真实路径，必须先把符号链接（如 /var → /private/var）解析掉 */
function realPath(target: string): string {
  try { return fs.realpathSync(target) } catch { return target }
}

/** 无工作区上下文（直聊/测试）时的可写边界：空目录，绝不把应用目录当成沙箱 */
export function emptyWorkspaceRoot(): string {
  const dir = path.join(os.tmpdir(), 'workavatar-no-workspace')
  try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 已存在或不可创建时交由沙箱报错 */ }
  return dir
}

/** Seatbelt 路径字面量（SBPL 字符串） */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 生成 Seatbelt profile：默认允许一切，仅拒绝文件写入，再把工作区与私有临时目录放行。
 * 与 Windows 侧语义保持一致（读全部放行、写限工作区 + 临时目录）。
 */
export function buildSeatbeltProfile(workspaceRoot: string, tempDir: string): string {
  const writable = [
    `(subpath ${sbplString(workspaceRoot)})`,
    `(subpath ${sbplString(tempDir)})`,
    '(literal "/dev/null")',
    '(literal "/dev/zero")',
    '(literal "/dev/stdout")',
    '(literal "/dev/stderr")',
    '(literal "/dev/tty")',
    '(subpath "/dev/fd")',
  ].join('\n    ')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    `    ${writable})`,
    '',
  ].join('\n')
}

class SandboxService {
  private static instance: SandboxService
  /** 测试注入：覆盖 Windows runner 路径（null 表示缺失）；生产环境不设置 */
  private runnerPathOverride: string | null | undefined

  static getInstance(): SandboxService {
    if (!SandboxService.instance) SandboxService.instance = new SandboxService()
    return SandboxService.instance
  }

  setRunnerPathOverride(path: string | null | undefined): void {
    this.runnerPathOverride = path
  }

  private windowsRunner(): string | null {
    return this.runnerPathOverride === undefined ? windowsRunnerPath() : this.runnerPathOverride
  }

  /**
   * 把一次命令启动包装成受限执行。
   * danger-full-access 原样返回；其余模式必须拿到可用的平台后端，否则抛 SandboxUnavailableError。
   */
  confine(input: ConfineInput): ConfinedLaunch {
    if (input.mode === 'danger-full-access') {
      return {
        program: input.program,
        args: [...input.args],
        env: {},
        facts: { mode: 'danger-full-access', backend: 'none', enforcement: 'full', denied: false },
        cleanup: () => {},
      }
    }
    if (process.platform === 'win32') return this.confineWindows(input)
    if (process.platform === 'darwin') return this.confineMacos(input)
    if (process.platform === 'linux') return this.confineLinux(input)
    throw new SandboxUnavailableError('当前平台暂不支持文件沙箱')
  }

  /** Windows：交给受限令牌 runner，由它建令牌、授权目录、启动子进程 */
  private confineWindows(input: ConfineInput): ConfinedLaunch {
    const runner = this.windowsRunner()
    if (!runner || !fs.existsSync(runner)) {
      throw new SandboxUnavailableError(
        `沙箱运行器缺失：${runner ?? windowsRunnerPath()}。请执行 npm run gen:sandbox 重新构建，或使用高权限模式。`,
      )
    }
    const workspaceRoot = path.resolve(input.workspaceRoot)
    if (!fs.existsSync(workspaceRoot)) {
      fs.mkdirSync(workspaceRoot, { recursive: true })
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-'))
    const env: NodeJS.ProcessEnv = { TMP: tempDir, TEMP: tempDir }
    logger.info(`Windows 沙箱启动: workspace=${workspaceRoot} temp=${tempDir}`)

    return {
      program: runner,
      args: [
        '--workspace', workspaceRoot,
        '--temp', tempDir,
        '--cwd', path.resolve(input.cwd),
        '--mode', 'workspace-write',
        '--',
        input.program,
        ...input.args,
      ],
      env,
      facts: { mode: 'workspace-write', backend: 'windows-acl', enforcement: 'partial', denied: false },
      cleanup: () => removeDirQuietly(tempDir),
    }
  }

  /** macOS：sandbox-exec 载入临时 profile */
  private confineMacos(input: ConfineInput): ConfinedLaunch {
    const sandboxExec = '/usr/bin/sandbox-exec'
    if (!fs.existsSync(sandboxExec)) {
      throw new SandboxUnavailableError(`沙箱不可用：未找到 ${sandboxExec}。可使用高权限模式执行本次命令。`)
    }
    // 先确保目录存在，再解析真实路径（父目录可能是符号链接）
    const workspacePath = path.resolve(input.workspaceRoot)
    if (!fs.existsSync(workspacePath)) {
      fs.mkdirSync(workspacePath, { recursive: true })
    }
    const workspaceRoot = realPath(workspacePath)
    const tempDir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-')))
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-profile-'))
    const profilePath = path.join(profileDir, 'sandbox.sb')
    fs.writeFileSync(profilePath, buildSeatbeltProfile(workspaceRoot, tempDir), 'utf-8')
    logger.info(`macOS 沙箱启动: workspace=${workspaceRoot} temp=${tempDir}`)

    return {
      program: sandboxExec,
      args: ['-f', profilePath, '--', input.program, ...input.args],
      env: { TMPDIR: tempDir },
      facts: { mode: 'workspace-write', backend: 'seatbelt', enforcement: 'full', denied: false },
      cleanup: () => {
        removeDirQuietly(profileDir)
        removeDirQuietly(tempDir)
      },
    }
  }

  /** Linux：bubblewrap（只读根 + 工作区/临时目录可写） */
  private confineLinux(input: ConfineInput): ConfinedLaunch {
    const bwrap = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/snap/bin/bwrap']
      .find((candidate) => fs.existsSync(candidate))
    if (!bwrap) {
      throw new SandboxUnavailableError('沙箱不可用：未找到 bubblewrap（bwrap）。请安装 bwrap，或使用高权限模式执行本次命令。')
    }
    const workspaceRoot = path.resolve(input.workspaceRoot)
    if (!fs.existsSync(workspaceRoot)) {
      fs.mkdirSync(workspaceRoot, { recursive: true })
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sbx-'))
    logger.info(`Linux 沙箱启动: workspace=${workspaceRoot} temp=${tempDir}`)

    return {
      program: bwrap,
      args: [
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--bind', workspaceRoot, workspaceRoot,
        '--bind', tempDir, tempDir,
        '--unshare-pid',
        '--die-with-parent',
        '--chdir', input.cwd,
        '--',
        input.program,
        ...input.args,
      ],
      env: { TMPDIR: tempDir },
      facts: { mode: 'workspace-write', backend: 'bubblewrap', enforcement: 'full', denied: false },
      cleanup: () => removeDirQuietly(tempDir),
    }
  }
}

function removeDirQuietly(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
}

export default SandboxService
