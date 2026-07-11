import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import DatabaseService from './services/database.service'
import KMSIndexManagerService from './services/kms/kms-index-manager.service'
import LLMLoggerService from './services/llm-logger.service'
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

// 初始化日志文件（每次启动新建一个以时间命名的文件），必须在 PathService 可用后尽早调用
try {
  // PathService 依赖 electron.app，需在 app.whenReady 之前也能实例化（它内部 require electron）
  // 但 dataDir 读取发生在 PathService 构造期，这里 app 尚未 ready，仍可调用 getPath
  const PathService = require('./services/path.service').default
  LoggerBackend.getInstance().init(PathService.getInstance().getDataDir())
  logger.info(`Application starting (v${app.getVersion()}, dev=${isDev}, log=${LoggerBackend.getInstance().getLogFilePath()})`)
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
    title: 'WorkAvatar 数字员工平台',
    width: 1280,
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
    frame: true,
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
  registerIpcHandlers()
  createWindow()
  createTray()
})

app.on('before-quit', () => {
  isQuitting = true
  logger.info('Application quitting, cleaning up resources')
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
