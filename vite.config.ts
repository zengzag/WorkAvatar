import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'
import fs from 'fs'

// 主进程与 Worker 共用的原生模块外部化列表
// 这些模块必须在打包产物中保留为 require(...)，由 Node 运行时加载
const nativeExternals = [
  'electron',
  'better-sqlite3',
  'sqlite-vec',
  'file2md',
  'mammoth',
  'word-extractor',
  'xlsx',
  'unpdf',
  'pdfjs-dist',
  '@node-rs/jieba',
  '@node-rs/jieba/dict',
  'worker_threads',
  'adm-zip',
  'docx',
  'pptxgenjs',
  // OCR：PaddleOCR ONNX 推理
  'paddleocr',
  'onnxruntime-node',
  'sharp',
  // 语音识别：sherpa-onnx 包含 WASM + .node 原生模块，必须外部化
  'sherpa-onnx',
  'sherpa-onnx-node',
]

// 读取 build-info.json（在 predev/prebuild 中由 scripts/generate-build-info.mjs 生成）
// 缺失时降级为占位值，保证 dev 启动不会因未生成而报错
function readBuildInfo() {
  const fallback = { version: '0.0.0', commit: 'unknown', buildTime: '' }
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'build-info.json'), 'utf-8')
    const data = JSON.parse(raw)
    return {
      version: typeof data.version === 'string' ? data.version : fallback.version,
      commit: typeof data.commit === 'string' ? data.commit : fallback.commit,
      buildTime: typeof data.buildTime === 'string' ? data.buildTime : fallback.buildTime,
    }
  } catch {
    return fallback
  }
}

const buildInfo = readBuildInfo()

// KMS 索引 Worker 产物 banner：运行时 electron 桩。
// 真实 electron 仅在主进程可用，worker_threads 里 require('electron') 会抛
// "Cannot find module 'electron'"。但 KMS Worker 的依赖树会（静态/动态 import）
// 引入部分主进程模块（ipc/_shared、plugin-host、secure-key-storage 等），其顶层
// require('electron') 让 Worker 加载即崩溃。vite-plugin-electron 会对所有入口
// 强制 external electron（优先级高于 resolve.alias / resolveId），故解析级方案无效；
// 改为在产物文件顶部用 banner 拦截 Module._load，把 'electron' 解析到安全桩。
// Worker 实际索引流程不执行主进程专属 API（路径经 workerData 传入、API Key 预解密），
// 桩内全为空实现/安全默认值即可。OCR Worker 导入链干净，无需此栏。
const workerElectronShimBanner = `(function () {
  var mod = require('node:module');
  var origLoad = mod._load;
  function noop() {}
  var appStub = {
    isPackaged: false, getPath: function () { return ''; }, getAppPath: function () { return ''; },
    getVersion: function () { return ''; }, whenReady: function () { return Promise.resolve(); },
    quit: noop, on: noop, once: noop, removeListener: noop, emit: noop, addListener: noop,
    setAppUserModelId: noop, getLoginItemSettings: function () { return {}; },
    setLoginItemSettings: noop, requestSingleInstanceLock: function () { return false; },
    commandLine: { appendSwitch: noop, appendArgument: noop }
  };
  var webContentsStub = {
    send: noop, on: noop, once: noop, removeListener: noop,
    executeJavaScript: function () { return Promise.resolve(); },
    loadURL: function () { return Promise.resolve(); }, loadFile: function () { return Promise.resolve(); },
    getURL: function () { return ''; }, getTitle: function () { return ''; },
    canGoBack: function () { return false; },
    session: { webRequest: { onBeforeRequest: noop } }
  };
  var bwinStub = {
    on: noop, once: noop, removeListener: noop,
    loadURL: function () { return Promise.resolve(); }, loadFile: function () { return Promise.resolve(); },
    close: noop, destroy: noop, show: noop, hide: noop, focus: noop, setMenu: noop, setTitle: noop,
    getBounds: function () { return { x: 0, y: 0, width: 0, height: 0 }; },
    setBounds: noop, getSize: function () { return [0, 0]; }, setSize: noop,
    isDestroyed: function () { return true; }, minimize: noop, maximize: noop,
    unmaximize: noop, restore: noop, isMaximized: function () { return false; },
    isMinimized: function () { return false; }, webContents: webContentsStub
  };
  var ipcStub = { handle: noop, removeHandler: noop, on: noop, once: noop, removeListener: noop, emit: noop };
  var safeStorageStub = {
    isEncryptionAvailable: function () { return false; }, encryptString: function (s) { return s; },
    decryptString: function () { return ''; }, getSelectedStorageBackend: function () { return 'vault'; }
  };
  var stub = {
    app: appStub,
    BrowserWindow: function () { return bwinStub; },
    ipcMain: ipcStub, ipcRenderer: ipcStub,
    safeStorage: safeStorageStub,
    Notification: function () { return { show: noop, on: noop, close: noop, isSupported: function () { return false; }, title: '', body: '' }; },
    dialog: { showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); }, showSaveDialog: function () { return Promise.resolve({ canceled: true, filePath: '' }); }, showMessageBox: function () { return Promise.resolve({ response: 0 }); } },
    shell: { openExternal: function () { return Promise.resolve(); }, openPath: function () { return Promise.resolve(); }, showItemInFolder: noop, openItem: noop, beep: noop },
    Menu: function () { return { popup: noop, append: noop, insert: noop, items: [] }; },
    MenuItem: function (o) { return o || {}; },
    Tray: function () { return { on: noop, setContextMenu: noop, setToolTip: noop, setImage: noop, destroy: noop, isDestroyed: function () { return false; } }; },
    nativeImage: { createFromPath: function () { return { resize: function () { return { toPNG: function () { return Buffer.alloc(0); } }; }, toPNG: function () { return Buffer.alloc(0); }, isEmpty: function () { return true; } }; } },
    protocol: { handle: noop, registerSchemesAsPrivileged: noop, registerFileProtocol: noop },
    session: { defaultSession: { setPermissionRequestHandler: noop, on: noop, once: noop } },
    desktopCapturer: { getSources: function () { return Promise.resolve([]); } },
    powerSaveBlocker: { start: function () { return 0; }, stop: noop, isStarted: function () { return false; } },
    globalShortcut: { register: function () { return false; }, unregister: noop, unregisterAll: noop, isRegistered: function () { return false; } },
    screen: { getPrimaryDisplay: function () { return { size: { width: 0, height: 0 }, workArea: { x: 0, y: 0, width: 0, height: 0 } }; } },
    clipboard: { writeText: noop, readText: function () { return ''; } },
    net: { request: function () { return { on: noop, abort: noop }; } },
    webFrameMain: { fromId: function () { return null; } },
    utilityProcess: { fork: function () { return { on: noop, once: noop, postMessage: noop }; } }
  };
  mod._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return origLoad.call(this, request, parent, isMain);
  };
})();`

// Vditor 在运行时会从 cdn 动态加载 lute/katex/highlight.js 等子资源（请求 {cdn}/dist/js/...），
// Electron 环境无法访问公网 CDN，因此把 node_modules/vditor 暴露到 /vditor 路径。
// dev：用中间件静态服务 node_modules/vditor；build：把 dist/ 复制到 outDir/vditor/dist/。
function serveVditorAssets(): Plugin {
  const vditorRoot = path.resolve(__dirname, 'node_modules/vditor')
  const mimeMap: Record<string, string> = {
    '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif',
    '.jpg': 'image/jpeg', '.webp': 'image/webp',
  }
  const sendFile = (res: any, filePath: string) => {
    const ext = path.extname(filePath).toLowerCase()
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    fs.createReadStream(filePath).pipe(res)
  }
  const handle = (req: any, res: any, next: () => void) => {
    const urlPath = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''))
    if (!urlPath) { next(); return }
    const filePath = path.join(vditorRoot, urlPath)
    if (filePath.startsWith(vditorRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      sendFile(res, filePath)
      return
    }
    next()
  }
  const copyDir = (src: string, dest: string) => {
    if (!fs.existsSync(src)) return
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      if (entry.isDirectory()) copyDir(s, d)
      else fs.copyFileSync(s, d)
    }
  }
  return {
    name: 'serve-vditor-assets',
    configureServer(server) { server.middlewares.use('/vditor', handle) },
    configurePreviewServer(server) { server.middlewares.use('/vditor', handle) },
    writeBundle() {
      // Vditor 请求 {cdn}/dist/...，因此产物路径须为 dist/vditor/dist/...
      copyDir(path.join(vditorRoot, 'dist'), path.resolve(__dirname, 'dist/vditor/dist'))
    },
  }
}

export default defineConfig({
  define: {
    // 注入渲染进程可用的全局常量（由 build-info.json 生成，predev/prebuild 自动触发）
    __APP_VERSION__: JSON.stringify(buildInfo.version),
    __APP_COMMIT__: JSON.stringify(buildInfo.commit),
    __APP_BUILD_TIME__: JSON.stringify(buildInfo.buildTime),
  },
  plugins: [
    react(),
    serveVditorAssets(),
    electron([
      {
        entry: 'electron/main/index.ts',
        onstart(options) {
          options.startup()
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: nativeExternals,
              output: {
                // 主进程是 Electron 直接加载的单文件 CJS 入口，分割无收益；
                // 且 rolldown 对 CJS 多 chunk 的跨模块符号提升在循环依赖下会产出
                // 悬空引用（init_models is not defined），必须禁用分割
                codeSplitting: false,
              }
            }
          }
        }
      },
      {
        // KMS 批量索引 Worker：把 better-sqlite3 同步阻塞操作移出主线程，
        // 避免解析 3000+ 文件时卡死 UI
        entry: 'electron/main/workers/kms-index-worker.ts',
        onstart() {
          // Worker 不需要 startup，主进程运行时按需 spawn
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: nativeExternals,
              output: {
                entryFileNames: 'kms-index-worker.js',
                // 运行时 electron 桩：banner 在产物顶部拦截 Module._load，
                // 让 Worker 内任何 require('electron') 解析到安全桩而非抛错
                banner: workerElectronShimBanner,
                // Worker 是单文件入口，禁用代码分割避免产出多个 chunk
                // （new Worker(filename) 只能加载单文件）
                codeSplitting: false,
              }
            }
          }
        }
      },
      {
        // OCR Worker：将 PaddleOCR / onnxruntime-native 运行在独立 Worker 线程中，
        // onnxruntime 原生崩溃不会杀死主进程
        entry: 'electron/main/workers/ocr-worker.ts',
        onstart() {
          // Worker 不需要 startup，主进程运行时按需 spawn
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: nativeExternals,
              output: {
                entryFileNames: 'ocr-worker.js',
                codeSplitting: false,
              }
            }
          }
        }
      },
      {
        entry: 'electron/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron/preload'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    alias: {
      '@': path.resolve('./src'),
      '@shared': path.resolve('./electron/shared')
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react-markdown|remark-gfm|remark-math|rehype-katex)[\\/]/.test(id)) {
            return 'react-markdown'
          }
          if (/[\\/]node_modules[\\/]react-syntax-highlighter[\\/]/.test(id)) {
            return 'syntax-highlighter'
          }
          if (/[\\/]node_modules[\\/]katex[\\/]/.test(id)) {
            return 'katex'
          }
          if (/[\\/]node_modules[\\/](antd|@ant-design)[\\/]/.test(id)) {
            return 'antd'
          }
          if (/[\\/]node_modules[\\/]@file-viewer[\\/]/.test(id)) {
            return 'file-viewer'
          }
          if (/[\\/]node_modules[\\/]vditor[\\/]/.test(id)) {
            return 'vditor'
          }
        }
      }
    }
  }
})
