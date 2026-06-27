import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

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
              external: [
                'electron',
                'better-sqlite3',
                'file2md',
                'mammoth',
                'pdf-parse',
                'xlsx',
                'tesseract.js',
                'unpdf',
                'pdfjs-dist',
              ]
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
        }
      }
    }
  }
})
