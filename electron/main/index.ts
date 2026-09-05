import { app, BrowserWindow, shell, Tray, Menu, nativeImage, protocol, session, desktopCapturer, dialog } from 'electron'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import DatabaseService from './services/database.service'
import LLMLoggerService from './services/llm-logger.service'
import NotificationService from './services/notification.service'
import TabWindowService from './services/tab-window.service'
import PluginHostService from './services/plugin/plugin-host.service'
import EmployeeRegistryService from './services/employee-registry.service'
import WorkspaceManagerService from './services/workspace-manager.service'
import { registerIpcHandlers } from './ipc'
import { IPC_CHANNELS } from '../shared/ipc-channels'
import { PLUGIN_PACKAGE_EXT } from '../shared/channels/plugin'
import { createLogger, LoggerBackend } from './services/logger'

const logger = createLogger('Main')

// 全局异常兜底：捕获逃逸的 Promise rejection 和未捕获异常
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason)
})
// uncaughtException 后进程状态不确定，Node.js 最佳实践是清理后退出而非继续运行。
// 标志位防止多个异常并发触发时重复执行清理逻辑。
let isCrashing = false
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error)
  if (isCrashing) return
  isCrashing = true
  // 延迟 1s 退出，让日志写入磁盘；不可恢复的异常下继续运行会放大损坏
  setTimeout(() => {
    try { LLMLoggerService.getInstance().destroy() } catch { /* ignore */ }
    try { DatabaseService.getInstance().close() } catch { /* ignore */ }
    try { LoggerBackend.getInstance().destroy() } catch { /* ignore */ }
    app.exit(1)
  }, 1000)
})

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

// ====== 外部文件打开（系统右键"打开方式" / 拖到应用图标） ======

/** 待发送给渲染进程的 .md 文件路径队列（窗口未就绪时暂存） */
const pendingOpenFiles: string[] = []
/** 待加载的 .wap 插件包路径队列（应用未就绪时暂存，就绪后弹确认框加载） */
const pendingOpenPluginFiles: string[] = []

/** 从 argv 中提取 .md 文件绝对路径 */
function extractMdFilesFromArgv(argv: string[]): string[] {
  const files: string[] = []
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    // 跳过 electron 可执行文件和主脚本
    if (arg === process.argv0 || arg.endsWith('electron') || arg.endsWith('electron.exe')) continue
    if (arg.endsWith('.js') || arg.endsWith('.cjs') || arg.endsWith('.mjs')) continue
    if (arg.toLowerCase().endsWith('.md')) {
      const resolved = path.resolve(arg)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        files.push(resolved)
      }
    }
  }
  return files
}

/** 从 argv 中提取 .wap 插件包绝对路径 */
function extractPluginFilesFromArgv(argv: string[]): string[] {
  const files: string[] = []
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    if (arg === process.argv0 || arg.endsWith('electron') || arg.endsWith('electron.exe')) continue
    if (arg.endsWith('.js') || arg.endsWith('.cjs') || arg.endsWith('.mjs')) continue
    if (arg.toLowerCase().endsWith(`.${PLUGIN_PACKAGE_EXT}`)) {
      const resolved = path.resolve(arg)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        files.push(resolved)
      }
    }
  }
  return files
}

/** 把待打开的 .md 文件路径推送给渲染进程（窗口未就绪时暂存到队列） */
function sendOpenExternalFile(absPath: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.APP_OPEN_EXTERNAL_FILE, absPath)
  } else {
    pendingOpenFiles.push(absPath)
  }
}

/**
 * 打开 .wap 插件包：弹确认框询问是否加载，确认后导入并热重载生效。
 * 应用未就绪时暂存到队列，就绪后统一处理。
 */
async function handleOpenPluginFile(filePath: string): Promise<void> {
  if (!app.isReady()) {
    pendingOpenPluginFiles.push(filePath)
    return
  }
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: '加载插件',
    message: '是否加载这个插件？',
    detail: `${path.basename(filePath)}\n确认后将安装并加载该插件。`,
    buttons: ['加载', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response !== 0) return

  const host = PluginHostService.getInstance()
  let result = await host.importPluginFromPath(filePath, false)
  // 已安装同 id 插件 → 二次确认覆盖升级
  if (result.needsUpgradeConfirm) {
    const { existingVersion, newVersion } = result.needsUpgradeConfirm
    const { response: upgradeResponse } = await dialog.showMessageBox({
      type: 'warning',
      title: '插件已存在',
      message: '已安装相同插件，是否覆盖升级？',
      detail: `${existingVersion ?? '?'} → ${newVersion ?? '?'}`,
      buttons: ['覆盖升级', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (upgradeResponse !== 0) return
    result = await host.importPluginFromPath(filePath, true)
  }

  if (result.ok) {
    // 导入即增量加载（importPluginFromPath 内部完成激活与 PLUGIN_CHANGED 广播，无需整页 reload）
    dialog.showMessageBox({
      type: 'info',
      title: '插件已加载',
      message: `插件 ${result.id} v${result.version} 已加载`,
      buttons: ['确定'],
    })
  } else if (result.message && result.message !== 'cancelled') {
    dialog.showMessageBox({
      type: 'error',
      title: '加载失败',
      message: result.message,
      buttons: ['确定'],
    })
  }
}

// macOS: 通过 open-file 事件接收文件（Finder 拖到 Dock 图标 / Spotlight 打开）
app.on('open-file', (event, filePath) => {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(`.${PLUGIN_PACKAGE_EXT}`) && fs.existsSync(filePath)) {
    event.preventDefault()
    handleOpenPluginFile(path.resolve(filePath))
    return
  }
  if (lower.endsWith('.md') && fs.existsSync(filePath)) {
    event.preventDefault()
    sendOpenExternalFile(path.resolve(filePath))
  }
})

// 设置应用名称，用于系统通知中标识程序名（macOS/Linux 直接生效，Windows 配合 AUMID 生效）
app.setName('WorkAvatar')
app.setAppUserModelId('com.workavatar.desktop')

const isDev = !app.isPackaged

// 注册 app-file:// 特权协议，让渲染进程能通过 URL 访问本地文件（用于 file-viewer 预览）
// 注册 plugin:// 特权协议，供渲染端动态 import 插件 ESM 入口（CORS 放行跨源模块加载）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

const MIME_MAP: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  pdf: 'application/pdf',
  ofd: 'application/ofd',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'text/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  webm: 'audio/webm',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

function registerAppFileProtocol() {
  protocol.handle('app-file', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (process.platform === 'win32' && filePath.startsWith('/') && /^[a-zA-Z]:/.test(filePath.slice(1))) {
      filePath = filePath.slice(1)
    }
    const resolvedPath = path.resolve(filePath)
    if (!fs.existsSync(resolvedPath)) {
      return new Response('File not found', { status: 404 })
    }
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return new Response('Not a file', { status: 400 })
    }

    const contentType = getMimeType(resolvedPath)
    const fileSize = stat.size

    // 支持 Range 请求（音频/视频播放需要 seek 和准确的总时长）
    const rangeHeader = request.headers.get('range')
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
        const clampedEnd = Math.min(end, fileSize - 1)
        if (start > fileSize - 1 || start > clampedEnd) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` },
          })
        }
        const chunkSize = clampedEnd - start + 1
        const fileStream = fs.createReadStream(resolvedPath, { start, end: clampedEnd })
        return new Response(Readable.toWeb(fileStream) as ReadableStream, {
          status: 206,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(chunkSize),
            'Content-Range': `bytes ${start}-${clampedEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
          },
        })
      }
    }

    // 无 Range 请求时返回完整文件（带 Content-Length，确保音频总时长准确）
    const fileStream = fs.createReadStream(resolvedPath)
    const headers = {
      'Content-Type': contentType,
      'Content-Length': String(fileSize),
      'Accept-Ranges': 'bytes',
    }
    return new Response(Readable.toWeb(fileStream) as ReadableStream, { headers })
  })
}

// 读取构建元信息（prebuild 由 scripts/generate-build-info.mjs 生成），缺失时降级到 app.getVersion()
// 打包模式下文件位于 app.getAppPath()（electron-builder files 列表已包含 build-info.json）
function readBuildInfo(): { version: string; commit: string; buildTime: string } {
  const fallback = { version: app.getVersion(), commit: 'unknown', buildTime: '' }
  try {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const candidate = isDev
      ? path.join(process.cwd(), 'build-info.json')
      : path.join(app.getAppPath(), 'build-info.json')
    if (!fs.existsSync(candidate)) return fallback
    const data = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
    return {
      version: typeof data.version === 'string' ? data.version : fallback.version,
      commit: typeof data.commit === 'string' ? data.commit : fallback.commit,
      buildTime: typeof data.buildTime === 'string' ? data.buildTime : fallback.buildTime,
    }
  } catch {
    return fallback
  }
}

// 初始化日志文件（每次启动新建一个以时间命名的文件），必须在 PathService 可用后尽早调用
try {
  // PathService 依赖 electron.app，需在 app.whenReady 之前也能实例化（它内部 require electron）
  // 但 dataDir 读取发生在 PathService 构造期，这里 app 尚未 ready，仍可调用 getPath
  const PathService = require('./services/path.service').default
  LoggerBackend.getInstance().init(PathService.getInstance().getDataDir())
  const buildInfo = readBuildInfo()
  logger.info(
    `Application starting (v${buildInfo.version}(${buildInfo.commit}), build=${buildInfo.buildTime}, dev=${isDev}, log=${LoggerBackend.getInstance().getLogFilePath()})`
  )
} catch (err: any) {
  // 日志初始化失败不阻断启动
  logger.warn('Logger init failed, falling back to console-only:', err?.message || err)
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function getDistPath(...paths: string[]): string {
  if (isDev) {
    return path.join(process.cwd(), ...paths)
  }
  return path.join(__dirname, '..', '..', ...paths)
}

function getPreloadPath(): string {
  if (isDev) {
    return path.join(process.cwd(), 'dist-electron', 'preload', 'index.js')
  }
  return path.join(__dirname, '..', 'preload', 'index.js')
}

function getResourcePath(...paths: string[]): string {
  if (isDev) {
    return path.join(process.cwd(), ...paths)
  }
  return path.join(process.resourcesPath, ...paths)
}

function getAppIconPath(): string {
  if (process.platform === 'win32') {
    return getResourcePath('resources', 'icons', 'icon.ico')
  }
  if (process.platform === 'darwin') {
    return getResourcePath('resources', 'icons', 'icon.icns')
  }
  return getResourcePath('resources', 'icons', 'icon.png')
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'WorkAvatar 数字员工',
    width: 1160,
    height: 720,
    minWidth: 1024,
    minHeight: 640,
    icon: getAppIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    autoHideMenuBar: true,
    frame: false,
    show: false
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (isDev) {
      mainWindow?.webContents.openDevTools()
    }
  })

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 注入主窗口引用给通知服务，调度器启动后弹系统通知
  NotificationService.getInstance().setMainWindow(mainWindow)
  // 注入主窗口引用给 Tab 独立窗口服务，用于推送 detached 状态变化
  TabWindowService.getInstance().setMainWindow(mainWindow)
  // 主窗口纳入插件广播目标（插件 ctx.ipc.broadcast 推送范围）
  PluginHostService.getInstance().addTarget(mainWindow)

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(getDistPath('dist', 'index.html'))
  }

  // 页面加载完成后，把启动时暂存的待打开 .md 文件推送给渲染进程
  mainWindow.webContents.once('did-finish-load', () => {
    while (pendingOpenFiles.length > 0) {
      const file = pendingOpenFiles.shift()!
      mainWindow?.webContents.send(IPC_CHANNELS.APP_OPEN_EXTERNAL_FILE, file)
    }
  })

  DatabaseService.getInstance()
}

function createTray() {
  const iconPath = getResourcePath('resources', 'icons', 'icon.png')
  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(trayIcon)
  tray.setToolTip('WorkAvatar 数字员工')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出程序',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

app.whenReady().then(() => {
  logger.info('App ready, registering IPC handlers and creating window')

  // 插件协议：plugin://<id>/<相对路径> → 插件目录内文件（宿主校验启停与路径越权）
  protocol.handle('plugin', (request) => {
    return PluginHostService.getInstance().servePluginFile(request.url)
  })

  // 插件加载必须先于内核 agent 服务初始化（registerIpcHandlers 内创建 EmployeeAgentService），
  // 保证插件注册的 agent 工具/贡献点在内核服务装配前就位
  try {
    PluginHostService.getInstance().init()
  } catch (err: any) {
    logger.error('PluginHost init failed:', err?.message || err)
  }

  // 注册员工（内置/插件）影子记录落库：保证 conversations 等外键引用有效（幂等，id 跨版本不变）
  EmployeeRegistryService.getInstance().ensureDbRecords()
  // 注册员工工作区根目录与普通员工统一（employees/ 内），启动时迁移旧 registry-workspaces 目录
  WorkspaceManagerService.getInstance().migrateLegacyRegistryWorkspaces()

  registerAppFileProtocol()
  registerIpcHandlers()

  // 配置 getDisplayMedia 请求处理器，用于系统音频录制（Windows loopback）
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], fetchWindowIcons: false })
      callback({
        video: sources[0],  // 必须提供 video，否则 Electron 会报错
        audio: 'loopback',  // 捕获系统音频（扬声器输出），仅 Windows 支持
      })
    } catch (err) {
      logger.error('getDisplayMedia handler error:', err)
      // 回退：仅提供 audio
      callback({ audio: 'loopback' })
    }
  }, { useSystemPicker: false })

  createWindow()
  createTray()

  // Windows/Linux 首次启动时从 argv 提取 .md 文件（macOS 走 open-file 事件）
  if (process.platform !== 'darwin') {
    const mdFiles = extractMdFilesFromArgv(process.argv)
    for (const file of mdFiles) {
      sendOpenExternalFile(file)
    }
    // 提取 .wap 插件包并弹确认框加载
    const pluginFiles = extractPluginFilesFromArgv(process.argv)
    for (const file of pluginFiles) {
      handleOpenPluginFile(file)
    }
  }
  // 处理应用就绪前暂存的 .wap 插件包
  while (pendingOpenPluginFiles.length > 0) {
    handleOpenPluginFile(pendingOpenPluginFiles.shift()!)
  }

  // 启动自动化任务调度器（已插件化，由 automation 插件经 ctx.services.scheduler 驱动）
})

app.on('before-quit', () => {
  isQuitting = true
  logger.info('Application quitting, cleaning up resources')
  // 插件退出清理：deactivate + 注销插件注册的全局快捷键
  try {
    PluginHostService.getInstance().shutdown()
  } catch (error) {
    logger.error('Failed to shutdown PluginHost:', error)
  }
  // 关闭所有 Tab 独立窗口
  try {
    TabWindowService.getInstance().closeAll()
  } catch (error) {
    logger.error('Failed to close tab windows:', error)
  }
})

// will-quit 在所有窗口关闭后、进程退出前触发，不可被取消，
// 适合执行不可逆清理（DB close / logger destroy）。
// before-quit 可能被其他 handler 取消，若在其中关闭 DB 会导致取消后应用无法继续工作。
app.on('will-quit', () => {
  // 清理资源：关闭 LLM 日志定时器与数据库连接
  try {
    LLMLoggerService.getInstance().destroy()
  } catch (error) {
    logger.error('Failed to destroy LLMLoggerService:', error)
  }
  try {
    DatabaseService.getInstance().close()
  } catch (error) {
    logger.error('Failed to close database:', error)
  }
  // 关闭应用日志文件流
  try {
    LoggerBackend.getInstance().destroy()
  } catch (error) {
    logger.error('Failed to destroy logger:', error)
  }
})

app.on('window-all-closed', () => {
  mainWindow = null
  NotificationService.getInstance().setMainWindow(null)
  TabWindowService.getInstance().setMainWindow(null)
})

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  // Windows/Linux: 第二实例启动时从 argv 提取 .md 文件（系统右键"打开方式"）
  const mdFiles = extractMdFilesFromArgv(argv)
  for (const file of mdFiles) {
    sendOpenExternalFile(file)
  }
  // 第二实例传入的 .wap 插件包 → 弹确认框加载
  const pluginFiles = extractPluginFilesFromArgv(argv)
  for (const file of pluginFiles) {
    handleOpenPluginFile(file)
  }
})
