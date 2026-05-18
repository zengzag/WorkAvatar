// Preload pdf-parse in our module context so its debug mode detection
// (!module.parent) evaluates to false. When file2md later requires it,
// the cached version (with isDebugMode=false) is returned, preventing
// the ENOENT crash on test/data/05-versions-space.pdf
import 'pdf-parse'

import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron'
import path from 'path'
import DatabaseService from './services/database.service'
import { registerIpcHandlers } from './ipc-handlers'

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

const isDev = !app.isPackaged

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

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'WorkAvatar 数字员工平台',
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 640,
    icon: getResourcePath('resources', 'icons', 'icon.png'),
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
  tray.setToolTip('WorkAvatar 数字员工平台')

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
  registerIpcHandlers()
  createWindow()
  createTray()
})

app.on('before-quit', () => {
  isQuitting = true
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
