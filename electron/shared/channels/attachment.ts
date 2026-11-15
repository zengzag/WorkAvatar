export const ATTACHMENT_CHANNELS = {
  /** 批量保存 base64 data URL 为附件文件，返回 wa-attachment:// 引用（失败项为 null，调用方回退原 data URL） */
  ATTACHMENT_SAVE_DATA_URLS: 'attachment:save-data-urls',
  /** 把对话图片（data URL 或 wa-attachment:// 引用）写入系统剪贴板 */
  ATTACHMENT_COPY_IMAGE: 'attachment:copy-image',
} as const

export interface AttachmentSaveResult {
  refs: Array<string | null>
}

export interface AttachmentCopyImageResult {
  success: boolean
  error?: string
}
