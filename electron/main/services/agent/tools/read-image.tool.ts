import type { ToolDefinition, ToolHandlerContext } from './types'
import * as fs from 'fs'
import * as path from 'path'
import AttachmentService from '../../attachment.service'
import { resolveToolPath } from './fs-shared'

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
  description: 'Read a local image and hand its visual content to the model (requires an image-capable model). Use it for layout, charts and colours; if you only need the text in the image, prefer ocr_image. Supports png/jpg/jpeg/bmp/tiff/webp/gif, up to 6MB.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Image file path (absolute, or relative to the workspace)' },
    },
    required: ['path'],
  },
  handler: async (args: any, context?: ToolHandlerContext) => {
    try {
      const imagePath = String(args.path || '').trim()
      if (!imagePath) return { success: false, error: '图片路径不能为空' }

      const resolved = resolveToolPath(imagePath)
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
      // 图片以附件引用返回（落盘 hash 去重，前端/历史回放经协议或读盘拿到内容）；落盘失败回退 data URL
      const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
      const ref = AttachmentService.getInstance().saveDataUrl(dataUrl)
      // 模型不支持视觉时输出与实际一致的降级文案，避免"已提供给你"与"看不到图"的矛盾
      const output = context?.imageSupport === false
        ? `Image file read: ${resolved}\nThis model does not support image input, so the image was not sent with the request. Use ocr_image to extract text from it.`
        : `Image file read: ${resolved}\nThe image has been attached for the model to inspect. Call ocr_image if you need to extract text from it.`
      return {
        success: true,
        images: [ref || dataUrl],
        output,
      }
    } catch (error: any) {
      return { success: false, error: `图片读取失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
}
