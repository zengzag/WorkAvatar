import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

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
  'sharp',
]

export default defineConfig({
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
