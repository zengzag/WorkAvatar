import * as fs from 'fs'
import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { AttachmentCopyImageResult } from '../../shared/channels/attachment'
import AttachmentService from '../services/attachment.service'
import { safeHandle } from './_shared'

export function registerAttachmentHandlers() {
  safeHandle(IPC_CHANNELS.ATTACHMENT_SAVE_DATA_URLS, (dataUrls: string[]) => {
    const refs = (Array.isArray(dataUrls) ? dataUrls : []).map(d => AttachmentService.getInstance().saveDataUrl(d))
    return { refs }
  })

  // 对话图片复制：渲染端只有 data URL / wa-attachment:// 引用，统一由主进程解析后写入剪贴板
  safeHandle(IPC_CHANNELS.ATTACHMENT_COPY_IMAGE, async (source: string): Promise<AttachmentCopyImageResult> => {
    const src = typeof source === 'string' ? source : ''
    let image: Electron.NativeImage | null = null
    if (src.startsWith('data:image/')) {
      image = nativeImage.createFromDataURL(src)
    } else {
      const filePath = AttachmentService.getInstance().getFilePathFromRef(src)
      if (!filePath || !fs.existsSync(filePath)) return { success: false, error: 'attachment-not-found' }
      image = nativeImage.createFromPath(filePath)
    }
    if (!image || image.isEmpty()) return { success: false, error: 'invalid-image' }
    const png = image.toPNG()
    const bytes = new Uint8Array(png.byteLength)
    bytes.set(png)
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    return { success: true }
  })
}
