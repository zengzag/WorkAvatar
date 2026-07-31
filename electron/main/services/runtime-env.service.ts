import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS, type RuntimeEnvTool, type RuntimeEnvToolId, type RuntimeEnvInstallProgress } from '../../shared/ipc-channels'
import { createLogger } from './logger'

const logger = createLogger('RuntimeEnv')

const IS_WINDOWS = process.platform === 'win32'

/**
 * 单个运行时的检测元数据：
 * - commands: 依次尝试的命令名（PATH 中查找）
 * - versionArgs: 获取版本号的参数
 * - knownLocations: 已知安装位置查找函数，返回候选目录列表（用于 PATH 未命中时回退）
 */
interface DetectConfig {
  commands: string[]
  versionArgs: string[]
  knownLocations: () => string[]
  /** 从 `--version` 输出中提取版本号的首个匹配正则 */
  versionRegex: RegExp
}

const EXE_EXT = IS_WINDOWS ? '.exe' : ''

/**
 * 跨平台 `which`：在 PATH 中查找可执行文件，返回找到的第一个绝对路径。
 * 失败返回 null。
 */
function which(cmd: string): string | null {
  const PATH = process.env.PATH || ''
  const sep = IS_WINDOWS ? ';' : ':'
  const dirs = PATH.split(sep).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd + EXE_EXT)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 忽略不可访问目录
    }
  }
  return null
}

/** 在指定父目录下递归查找匹配的子目录可执行文件（最多 1 层深度） */
function findInDir(parentDir: string, exeName: string, depth = 1): string | null {
  if (!parentDir || !fs.existsSync(parentDir)) return null
  try {
    const direct = path.join(parentDir, exeName + EXE_EXT)
    if (fs.existsSync(direct)) return direct
    if (depth <= 0) return null
    const entries = fs.readdirSync(parentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const found = findInDir(path.join(parentDir, entry.name), exeName, depth - 1)
      if (found) return found
    }
  } catch {
    // 忽略权限错误
  }
  return null
}

const DETECT_CONFIGS: Record<RuntimeEnvToolId, DetectConfig> = {
  uv: {
    commands: ['uv'],
    versionArgs: ['--version'],
    knownLocations: () => {
      const home = os.homedir()
      return [
        path.join(home, '.local', 'bin'),
        path.join(home, '.cargo', 'bin'),
        // macOS Homebrew
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]
    },
    // uv 0.5.4
    versionRegex: /uv\s+(\d+\.\d+\.\d+)/,
  },
  python: {
    // 优先 python，回退 python3（Linux/macOS 通常只有 python3）
    commands: IS_WINDOWS ? ['python', 'python3'] : ['python3', 'python'],
    versionArgs: ['--version'],
    knownLocations: () => {
      if (IS_WINDOWS) {
        const localAppData = process.env.LOCALAPPDATA || ''
        const home = os.homedir()
        return [
          // 官方安装器默认位置：%LOCALAPPDATA%\Programs\Python\PythonXX\python.exe
          localAppData ? path.join(localAppData, 'Programs', 'Python') : '',
          // Microsoft Store 版本
          localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps') : '',
          // 用户级 uv 安装的 Python（uv python dir 默认位置）
          path.join(home, '.local', 'share', 'uv', 'python'),
          // Anaconda
          path.join(home, 'anaconda3'),
          path.join(home, 'miniconda3'),
        ].filter(Boolean)
      }
      const home = os.homedir()
      return [
        '/usr/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local', 'share', 'uv', 'python'),
      ]
    },
    // Python 3.11.5
    versionRegex: /Python\s+(\d+\.\d+\.\d+)/,
  },
  node: {
    commands: ['node'],
    versionArgs: ['--version'],
    knownLocations: () => {
      if (IS_WINDOWS) {
        const programFiles = process.env.ProgramFiles || ''
        const localAppData = process.env.LOCALAPPDATA || ''
        return [
          programFiles ? path.join(programFiles, 'nodejs') : '',
          // nvm-windows
          localAppData ? path.join(localAppData, 'nvm') : '',
          // Volta
          localAppData ? path.join(localAppData, 'Volta', 'bin') : '',
        ].filter(Boolean)
      }
      const home = os.homedir()
      return [
        '/usr/bin',
        '/usr/local/bin',
        '/opt/homebrew/bin',
        // nvm
        path.join(home, '.nvm', 'versions', 'node'),
        // Volta
        path.join(home, '.volta', 'bin'),
      ]
    },
    // v20.11.0
    versionRegex: /v(\d+\.\d+\.\d+)/,
  },
  pip: {
    // pip 通过 `python -m pip --version` 检测；这里 commands 仅作占位，特殊处理
    commands: [],
    versionArgs: ['--version'],
    knownLocations: () => [],
    // pip 23.2.1
    versionRegex: /pip\s+(\d+\.\d+\.\d+)/,
  },
}

/**
 * 异步执行命令并返回 stdout（trim）。
 * 失败（非零退出、超时、找不到命令）返回 null。
 */
function runCommand(cmd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: opts.env || process.env,
        timeout: opts.timeout,
      })
    } catch (err) {
      resolve({ stdout: '', stderr: String(err), code: -1 })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code })
    }
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      // ENOENT 表示命令不存在
      if (!settled) {
        settled = true
        resolve({ stdout: '', stderr: err.message, code: -1 })
      }
    })
    child.on('close', (code) => finish(code))
    // 兜底超时
    if (opts.timeout) {
      setTimeout(() => {
        if (!settled) {
          try { child.kill('SIGKILL') } catch { /* noop */ }
          finish(-2)
        }
      }, opts.timeout + 500)
    }
  })
}

/**
 * 在指定可执行文件路径上执行 `--version`，解析并返回版本号与原始路径。
 */
async function detectByExe(exePath: string, config: DetectConfig): Promise<{ version?: string } | null> {
  const result = await runCommand(exePath, config.versionArgs, { timeout: 8000 })
  if (result.code !== 0 && !result.stdout) return null
  const output = `${result.stdout}\n${result.stderr}`
  const match = output.match(config.versionRegex)
  return match ? { version: match[1] } : { version: undefined }
}

/**
 * 检测单个运行时：
 * 1. 在 PATH 中查找（which）
 * 2. 未命中则在已知安装位置中查找
 * 3. 找到后运行 `--version` 获取版本
 *
 * 特殊：pip 通过 python -m pip 检测，依赖 python 已安装
 */
async function detectTool(toolId: RuntimeEnvToolId): Promise<{ installed: boolean; version?: string; path?: string }> {
  const config = DETECT_CONFIGS[toolId]

  if (toolId === 'pip') {
    // pip 通过 python -m pip --version 检测
    const pythonResult = await detectTool('python')
    if (!pythonResult.installed || !pythonResult.path) return { installed: false }
    const pyExe = pythonResult.path
    const result = await runCommand(pyExe, ['-m', 'pip', '--version'], { timeout: 8000 })
    if (result.code !== 0 && !result.stdout) return { installed: false, path: pyExe }
    const match = result.stdout.match(config.versionRegex)
    return { installed: true, version: match ? match[1] : undefined, path: pyExe }
  }

  // 1. PATH 查找
  for (const cmd of config.commands) {
    const found = which(cmd)
    if (found) {
      const v = await detectByExe(found, config)
      if (v) return { installed: true, version: v.version, path: found }
    }
    // 直接尝试运行（有些系统 PATH 已包含但 fs.existsSync 因权限查不到）
    const v = await detectByExe(cmd + EXE_EXT, config)
    if (v) return { installed: true, version: v.version, path: cmd }
  }

  // 2. 已知位置回退
  for (const dir of config.knownLocations()) {
    const found = findInDir(dir, config.commands[0], 2)
    if (found) {
      const v = await detectByExe(found, config)
      if (v) return { installed: true, version: v.version, path: found }
    }
  }

  return { installed: false }
}

/**
 * 工具元信息（展示文案与可安装性）。
 * 文案以中文为主，由前端 i18n 进一步本地化展示。
 */
function getToolMeta(toolId: RuntimeEnvToolId): { name: string; description: string; installable: boolean; installHint?: string } {
  switch (toolId) {
    case 'uv':
      return {
        name: 'uv',
        description: 'Python 包管理器，可一键安装并管理 Python 解释器，是脚本运行 Python 的首选依赖',
        installable: true,
      }
    case 'python':
      return {
        name: 'Python',
        description: '运行 Python 脚本（.py 文件）',
        installable: true,
        installHint: '请先安装 uv，再通过 uv 一键安装 Python',
      }
    case 'node':
      return {
        name: 'Node.js',
        description: '运行 JavaScript / TypeScript 脚本，并提供 npm 包管理',
        installable: IS_WINDOWS,
        installHint: IS_WINDOWS ? undefined : '请前往 https://nodejs.org 下载安装',
      }
    case 'pip':
      return {
        name: 'pip',
        description: 'Python 包管理工具，随 Python 一同安装，用于安装脚本所需的 Python 依赖包',
        installable: true,
        installHint: 'pip 随 Python 一同安装，请先安装 Python',
      }
  }
}

/** 工具检测顺序：uv → python → node → pip（pip 依赖 python） */
const TOOL_ORDER: RuntimeEnvToolId[] = ['uv', 'python', 'node', 'pip']

class RuntimeEnvService {
  private static instance: RuntimeEnvService
  /** 当前正在安装的工具（同一时刻只允许一个） */
  private installingTool: RuntimeEnvToolId | null = null
  /** 当前安装进程的子进程引用，用于取消 */
  private currentChild: ReturnType<typeof spawn> | null = null
  /** 当前安装是否被用户取消 */
  private cancelled = false

  private constructor() {}

  static getInstance(): RuntimeEnvService {
    if (!RuntimeEnvService.instance) {
      RuntimeEnvService.instance = new RuntimeEnvService()
    }
    return RuntimeEnvService.instance
  }

  /**
   * 检测所有受支持运行时的安装状态。
   * 并行检测以降低延迟（pip 内部依赖 python 检测，会串行等待）。
   */
  async detectAll(): Promise<RuntimeEnvTool[]> {
    const results = await Promise.all(TOOL_ORDER.map(async (id) => {
      const meta = getToolMeta(id)
      const detected = await detectTool(id)
      return {
        id,
        name: meta.name,
        description: meta.description,
        installed: detected.installed,
        version: detected.version,
        path: detected.path,
        installable: meta.installable,
        installHint: meta.installHint,
        installing: this.installingTool === id,
      } satisfies RuntimeEnvTool
    }))
    return results
  }

  /** 当前是否有安装任务在进行 */
  isInstalling(): boolean {
    return this.installingTool !== null
  }

  /** 取消正在进行的安装任务 */
  cancelInstall(): boolean {
    if (!this.installingTool) return false
    this.cancelled = true
    if (this.currentChild) {
      try {
        // 杀掉整个进程树（Windows 下需 /T 才能杀子进程）
        this.currentChild.kill(IS_WINDOWS ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // noop
      }
    }
    return true
  }

  /**
   * 安装指定运行时。
   * 安装策略：
   * - uv：调用官方安装脚本（Windows PowerShell / Unix shell）
   * - python：调用 `uv python install`（依赖 uv 已安装）
   * - node：Windows 优先 winget，缺失则打开浏览器下载页
   * - pip：通过 `python -m ensurepip --upgrade` 修复
   */
  async install(toolId: RuntimeEnvToolId): Promise<{ success: boolean; error?: string }> {
    if (this.installingTool) {
      return { success: false, error: '已有安装任务正在进行，请等待完成或取消' }
    }
    this.installingTool = toolId
    this.cancelled = false
    try {
      switch (toolId) {
        case 'uv':
          return await this.installUv()
        case 'python':
          return await this.installPython()
        case 'node':
          return await this.installNode()
        case 'pip':
          return await this.installPip()
      }
    } finally {
      this.installingTool = null
      this.currentChild = null
      this.cancelled = false
    }
  }

  private emitProgress(progress: RuntimeEnvInstallProgress): void {
    try {
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.RUNTIME_ENV_PROGRESS, progress)
        }
      }
    } catch (err) {
      logger.warn('Failed to emit runtime env progress:', err)
    }
  }

  /** 检查是否被取消，被取消则抛出错误 */
  private throwIfCancelled(): void {
    if (this.cancelled) {
      throw new Error('INSTALL_CANCELLED')
    }
  }

  /**
   * 运行安装命令，流式收集输出并通过进度事件推送。
   * @param command 命令（如 powershell / sh / winget）
   * @param args 参数
   * @param opts.phase 用于进度事件的阶段标签
   * @param opts.env 自定义环境变量
   * @returns 完整 stdout + stderr 合并文本
   */
  private runInstallCommand(
    command: string,
    args: string[],
    opts: { phase: RuntimeEnvInstallProgress['phase']; message: string; timeout?: number; env?: NodeJS.ProcessEnv }
  ): Promise<{ output: string; code: number | null; cancelled: boolean }> {
    return new Promise((resolve) => {
      this.emitProgress({ toolId: this.installingTool!, phase: opts.phase, message: opts.message })

      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
          env: opts.env || process.env,
        })
      } catch (err: any) {
        resolve({ output: String(err?.message || err), code: -1, cancelled: false })
        return
      }
      this.currentChild = child

      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        const cancelled = this.cancelled
        this.currentChild = null
        resolve({ output: `${stdout}\n${stderr}`, code, cancelled })
      }
      child.stdout?.on('data', (d) => {
        const text = d.toString()
        stdout += text
        // 流式推送日志，message 截断避免事件过大
        this.emitProgress({
          toolId: this.installingTool!,
          phase: opts.phase,
          message: text.split('\n').slice(-2)[0]?.trim().substring(0, 200) || opts.message,
        })
      })
      child.stderr?.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('error', (err) => {
        if (!settled) {
          settled = true
          this.currentChild = null
          resolve({ output: `${stdout}\n${err.message}`, code: -1, cancelled: this.cancelled })
        }
      })
      child.on('close', (code) => finish(code))

      if (opts.timeout) {
        setTimeout(() => {
          if (!settled) {
            try { child.kill('SIGKILL') } catch { /* noop */ }
          }
        }, opts.timeout)
      }
    })
  }

  /**
   * 安装 uv：
   * - Windows: `powershell -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"`
   * - Unix: `sh -c "curl -LsSf https://astral.sh/uv/install.sh | sh"`
   */
  private async installUv(): Promise<{ success: boolean; error?: string }> {
    const result = IS_WINDOWS
      ? await this.runInstallCommand(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          'irm https://astral.sh/uv/install.ps1 | iex'],
        { phase: 'installing', message: '正在通过官方脚本安装 uv...', timeout: 5 * 60 * 1000 }
      )
      : await this.runInstallCommand(
        'sh',
        ['-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
        { phase: 'installing', message: '正在通过官方脚本安装 uv...', timeout: 5 * 60 * 1000 }
      )

    this.throwIfCancelled()

    if (result.code !== 0) {
      this.emitProgress({ toolId: 'uv', phase: 'error', message: `uv 安装失败：${result.output.substring(0, 300)}` })
      return { success: false, error: `uv 安装失败（退出码 ${result.code}）` }
    }

    // 安装后，将 uv 所在目录补充到当前进程 PATH，便于后续 python 安装（uv python install）使用
    // uv 在 Windows 与 Unix 上都默认安装到 ~/.local/bin
    const home = os.homedir()
    const uvBinDir = path.join(home, '.local', 'bin')
    if (fs.existsSync(uvBinDir) && !process.env.PATH?.split(IS_WINDOWS ? ';' : ':').includes(uvBinDir)) {
      process.env.PATH = `${uvBinDir}${IS_WINDOWS ? ';' : ':'}${process.env.PATH || ''}`
    }

    // 验证安装：重新检测
    this.emitProgress({ toolId: 'uv', phase: 'verifying', message: '正在验证 uv 安装...' })
    const detected = await detectTool('uv')
    if (!detected.installed) {
      this.emitProgress({ toolId: 'uv', phase: 'error', message: 'uv 安装后未检测到可执行文件，请重启应用后再试' })
      return { success: false, error: 'uv 安装后未检测到可执行文件，可能需要重启应用以刷新 PATH' }
    }

    this.emitProgress({ toolId: 'uv', phase: 'done', message: `uv 安装成功（版本 ${detected.version || '未知'}）` })
    return { success: true }
  }

  /**
   * 安装 Python：通过 `uv python install` 拉取 uv 管理的 Python 解释器。
   * 前置条件：uv 已安装。
   */
  private async installPython(): Promise<{ success: boolean; error?: string }> {
    const uvDetect = await detectTool('uv')
    if (!uvDetect.installed) {
      this.emitProgress({ toolId: 'python', phase: 'error', message: '尚未安装 uv，请先一键安装 uv' })
      return { success: false, error: '尚未安装 uv，请先安装 uv 再安装 Python' }
    }
    const uvExe = uvDetect.path || 'uv'

    const result = await this.runInstallCommand(
      uvExe,
      ['python', 'install'],
      { phase: 'installing', message: '正在通过 uv 安装 Python 解释器...', timeout: 10 * 60 * 1000 }
    )

    this.throwIfCancelled()

    if (result.code !== 0) {
      this.emitProgress({ toolId: 'python', phase: 'error', message: `Python 安装失败：${result.output.substring(0, 300)}` })
      return { success: false, error: `Python 安装失败（退出码 ${result.code}）` }
    }

    this.emitProgress({ toolId: 'python', phase: 'verifying', message: '正在验证 Python 安装...' })
    const detected = await detectTool('python')
    if (!detected.installed) {
      // uv 安装的 Python 不在系统 PATH 中是正常的；只要 uv python list 能看到就算成功
      this.emitProgress({ toolId: 'python', phase: 'done', message: 'Python 已通过 uv 安装（uv 管理的 Python 不在系统 PATH 中，脚本运行时会自动通过 uv 解析）' })
      return { success: true }
    }
    this.emitProgress({ toolId: 'python', phase: 'done', message: `Python 安装成功（版本 ${detected.version || '未知'}）` })
    return { success: true }
  }

  /**
   * 安装 Node.js：
   * - Windows：优先使用 winget 安装 LTS 版本；winget 不可用则打开官方下载页
   * - Unix：打开官方下载页（无法静默安装）
   */
  private async installNode(): Promise<{ success: boolean; error?: string }> {
    if (IS_WINDOWS) {
      // 优先 winget
      const wingetResult = await this.runInstallCommand(
        'winget.exe',
        ['install', '--id', 'OpenJS.NodeJS.LTS', '--accept-source-agreements', '--accept-package-agreements', '--silent'],
        { phase: 'installing', message: '正在通过 winget 安装 Node.js LTS...', timeout: 10 * 60 * 1000 }
      )

      this.throwIfCancelled()

      if (wingetResult.code === 0) {
        this.emitProgress({ toolId: 'node', phase: 'verifying', message: '正在验证 Node.js 安装...' })
        const detected = await detectTool('node')
        if (detected.installed) {
          this.emitProgress({ toolId: 'node', phase: 'done', message: `Node.js 安装成功（版本 ${detected.version || '未知'}），可能需要重启应用以生效` })
          return { success: true }
        }
        this.emitProgress({ toolId: 'node', phase: 'done', message: 'winget 安装命令已完成，可能需要重启应用以使 Node.js 进入 PATH' })
        return { success: true }
      }

      // winget 失败：打开浏览器下载页
      this.emitProgress({ toolId: 'node', phase: 'error', message: 'winget 安装失败，已打开 Node.js 官方下载页，请手动下载安装' })
      const { shell } = require('electron')
      await shell.openExternal('https://nodejs.org/zh-cn/download/')
      return { success: false, error: 'winget 不可用或安装失败，已打开 Node.js 官方下载页请手动安装' }
    }

    // Unix：打开下载页
    this.emitProgress({ toolId: 'node', phase: 'error', message: '当前平台不支持一键安装，已打开 Node.js 官方下载页' })
    const { shell } = require('electron')
    await shell.openExternal('https://nodejs.org/zh-cn/download/')
    return { success: false, error: '当前平台不支持一键安装 Node.js' }
  }

  /**
   * 修复 pip：通过 `python -m ensurepip --upgrade` 引导内置 pip，
   * 再执行 `python -m pip install --upgrade pip` 升级到最新版。
   */
  private async installPip(): Promise<{ success: boolean; error?: string }> {
    const pyDetect = await detectTool('python')
    if (!pyDetect.installed) {
      this.emitProgress({ toolId: 'pip', phase: 'error', message: '尚未安装 Python，pip 随 Python 一同提供' })
      return { success: false, error: '尚未安装 Python，请先安装 Python' }
    }
    const pyExe = pyDetect.path || 'python'

    const ensureResult = await this.runInstallCommand(
      pyExe,
      ['-m', 'ensurepip', '--upgrade'],
      { phase: 'installing', message: '正在通过 ensurepip 引导 pip...', timeout: 60 * 1000 }
    )
    this.throwIfCancelled()
    if (ensureResult.code !== 0) {
      this.emitProgress({ toolId: 'pip', phase: 'error', message: `pip 引导失败：${ensureResult.output.substring(0, 300)}` })
      return { success: false, error: `ensurepip 失败（退出码 ${ensureResult.code}）` }
    }

    // 升级 pip
    await this.runInstallCommand(
      pyExe,
      ['-m', 'pip', 'install', '--upgrade', 'pip'],
      { phase: 'installing', message: '正在升级 pip 到最新版本...', timeout: 2 * 60 * 1000 }
    )
    this.throwIfCancelled()

    this.emitProgress({ toolId: 'pip', phase: 'verifying', message: '正在验证 pip...' })
    const detected = await detectTool('pip')
    if (!detected.installed) {
      this.emitProgress({ toolId: 'pip', phase: 'error', message: 'pip 安装后仍未检测到，请检查 Python 安装是否完整' })
      return { success: false, error: 'pip 安装后仍未检测到' }
    }
    this.emitProgress({ toolId: 'pip', phase: 'done', message: `pip 安装成功（版本 ${detected.version || '未知'}）` })
    return { success: true }
  }
}

export default RuntimeEnvService