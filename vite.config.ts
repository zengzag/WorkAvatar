import { defineConfig } from 'vite'
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
  'tesseract.js',
  'unpdf',
  'pdfjs-dist',
  '@node-rs/jieba',
  '@node-rs/jieba/dict',
  'worker_threads',
  'adm-zip',
  // OCR：PaddleOCR ONNX 推理
  'paddleocr',
  'onnxruntime-node',
  // 语音识别：sherpa-onnx 包含 WASM + .node 原生模块，必须外部化
  'sherpa-onnx',
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

export default defineConfig({
  define: {
    // 注入渲染进程可用的全局常量（由 build-info.json 生成，predev/prebuild 自动触发）
    __APP_VERSION__: JSON.stringify(buildInfo.version),
    __APP_COMMIT__: JSON.stringify(buildInfo.commit),
    __APP_BUILD_TIME__: JSON.stringify(buildInfo.buildTime),
  },
  plugins: [
    react(),
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
        }
      }
    }
  }
})
