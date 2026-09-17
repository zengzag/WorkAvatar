import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tiff', 'webp', 'gif'])
const MAX_FILE_SIZE = 6 * 1024 * 1024

/**
 * 图片读取工具（常驻）。
 *
 * 读取本地图片并以 data URL 形式返回，由消息注入层把图片放入 LLM 可见的
 * 视觉消息中（vision 模型可直接"看图"）。纯文本模型请改用 ocr_image。
 */
export const readImageTool: ToolDefinition = {
  id: 'read_image',
  name: 'read_image',
  title: '读取图片',
  summary: '读取本地图片供视觉模型直接查看图片内容。',
  description: '读取本地图片文件，把图片视觉内容提供给模型直接查看（需要当前模型支持图片输入）。适合识别布局、图表、颜色等非文字信息；若只关注图片中的文字，优先使用 ocr_image。支持 png/jpg/jpeg/bmp/tiff/webp/gif 格式，单文件不超过 6MB。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '图片文件绝对路径' },
    },
    required: ['path'],
  },
  handler: async (args: any) => {
    try {
      const imagePath = String(args.path || '').trim()
      if (!imagePath) return { success: false, error: '图片路径不能为空' }

      const resolved = path.resolve(imagePath)
      if (!fs.existsSync(resolved)) return { success: false, error: `图片文件不存在: ${imagePath}` }

      const stats = fs.statSync(resolved)
      if (!stats.isFile()) return { success: false, error: `路径不是文件: ${imagePath}` }
      if (stats.size > MAX_FILE_SIZE) {
        return { success: false, error: `图片过大 (${(stats.size / 1024 / 1024).toFixed(1)}MB)，仅支持 6MB 以内` }
      }

      const ext = path.extname(resolved).toLowerCase().slice(1)
      if (!IMAGE_EXTENSIONS.has(ext)) {
        return { success: false, error: `不支持的图片格式: ${ext || '(无扩展名)'}` }
      }

      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      const buf = await fs.promises.readFile(resolved)
      return {
        success: true,
        images: [`data:${mime};base64,${buf.toString('base64')}`],
        output: `已读取图片文件: ${resolved}\n图片内容已随消息提供给模型查看。如需提取图中文字，可继续调用 ocr_image。`,
      }
    } catch (error: any) {
      return { success: false, error: `图片读取失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
}
