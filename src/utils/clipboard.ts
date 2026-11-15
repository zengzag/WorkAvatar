/** 复制对话图片到系统剪贴板：data URL / wa-attachment:// 引用均由主进程解析，避免渲染端跨协议图片导出失败 */
export const copyImageToClipboard = async (source: string): Promise<boolean> => {
  if (!source) return false
  try {
    const result = await window.electronAPI?.attachment?.copyImage(source)
    return !!result?.success
  } catch {
    return false
  }
}
