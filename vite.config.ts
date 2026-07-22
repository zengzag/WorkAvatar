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
              external: nativeExternals
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
