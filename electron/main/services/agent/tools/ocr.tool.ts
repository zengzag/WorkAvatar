import type { ToolDefinition } from './types'
import OCRService from '../../ocr.service'
import * as fs from 'fs'
import * as path from 'path'
import { resolveToolPath } from './fs-shared'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp'])

/**
 * 图片 OCR 识别工具（常驻）。
 *
 * 底层 OCRService.recognize 将 PaddleOCR 推理运行在独立 Worker 线程中，
 * 因此本工具 handler 不会阻塞主进程。
 */
export const ocrImageTool: ToolDefinition = {
  id: 'ocr_image',
  name: 'ocr_image',
  title: '图片识别',
  summary: '对图片进行 OCR 文字识别，提取图片中的文字内容。',
  description: '对本地图片做 OCR 文字识别，提取图片中的文字。支持 png/jpg/jpeg/bmp/tiff/webp 格式。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片文件路径（绝对路径，或相对工作区）' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      const imagePath = String(args.path || '').trim()
      if (!imagePath) return { success: false, error: '图片路径不能为空' }

      const resolved = resolveToolPath(imagePath)
      if (!fs.existsSync(resolved)) return { success: false, error: `图片文件不存在: ${imagePath}` }

      const stats = fs.statSync(resolved)
      if (!stats.isFile()) return { success: false, error: `路径不是文件: ${imagePath}` }

      const ext = path.extname(resolved).toLowerCase().slice(1)
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return { success: false, error: `不支持的图片格式: ${ext || '(无扩展名)'}（支持 png/jpg/jpeg/bmp/tiff/webp）` }
      }

      const result = await OCRService.getInstance().recognize(resolved)
      if (!result.text.trim()) {
        return { success: true, output: '未识别到文字内容' }
      }

      return { success: true, output: result.text }
    } catch (error: any) {
      return { success: false, error: `图片识别失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
  onDemand: false,
}