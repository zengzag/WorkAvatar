import { app, BrowserWindow, shell, Tray, Menu, nativeImage, protocol, session, desktopCapturer } from 'electron'
import path from 'path'
import fs from 'fs'
import { Readable } from 'stream'
import DatabaseService from './services/database.service'
import KMSIndexManagerService from './services/kms/kms-index-manager.service'
import LLMLoggerService from './services/llm-logger.service'
import NotificationService from './services/notification.service'
import CalendarSchedulerService from './services/calendar/calendar-scheduler.service'
import AutomationSchedulerService from './services/automation/automation-scheduler.service'
import { registerIpcHandlers } from './ipc'
import { createLogger, LoggerBackend } from './services/logger'

const logger = createLogger('Main')

// 全局异常兜底：捕获逃逸的 Promise rejection 和未捕获异常
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason)
})
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error)
})

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

app.setAppUserModelId('com.workavatar.desktop')

const isDev = !app.isPackaged

// 注册 app-file:// 特权协议，让渲染进程能通过 URL 访问本地文件（用于 file-viewer 预览）
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

  // 窗口失焦时暂停 KMS 自动索引定时器，获焦时恢复（避免后台 CPU 占用）
  mainWindow.on('blur', () => {
    try {
      KMSIndexManagerService.getInstance().pauseAutoIndex()
    } catch {
      // KMS 服务可能尚未初始化，忽略
    }
  })
  mainWindow.on('focus', () => {
    try {
      KMSIndexManagerService.getInstance().resumeAutoIndex()
    } catch {
      // KMS 服务可能尚未初始化，忽略
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 注入主窗口引用给通知服务，调度器启动后弹系统通知
  NotificationService.getInstance().setMainWindow(mainWindow)

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(getDistPath('dist', 'index.html'))
  }

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

  // 启动日历提醒调度器（每 30 秒扫描到期提醒并推送通知）
  try {
    CalendarSchedulerService.getInstance().start()
  } catch (err: any) {
    logger.warn('Calendar scheduler start failed:', err?.message || err)
  }

  // 启动自动化任务调度器（每 30 秒扫描到期任务并触发执行）
  try {
    AutomationSchedulerService.getInstance().start()
  } catch (err: any) {
    logger.warn('Automation scheduler start failed:', err?.message || err)
  }
})

app.on('before-quit', () => {
  isQuitting = true
  logger.info('Application quitting, cleaning up resources')
  // 停止日历提醒调度器
  try {
    CalendarSchedulerService.getInstance().stop()
  } catch (error) {
    logger.error('Failed to stop CalendarSchedulerService:', error)
  }
  // 停止自动化任务调度器
  try {
    AutomationSchedulerService.getInstance().stop()
  } catch (error) {
    logger.error('Failed to stop AutomationSchedulerService:', error)
  }
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
  // 关闭悬浮字幕窗口
  try {
    require('./services/voice/subtitle-window.service').default.getInstance().destroy()
  } catch (error) {
    logger.error('Failed to destroy subtitle window:', error)
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
})

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})
