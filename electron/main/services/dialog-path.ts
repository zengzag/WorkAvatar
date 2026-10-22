import path from 'node:path'

/**
 * 记住最近一次文件对话框使用的目录。
 *
 * Electron 43 起（Chromium 上游行为）：`dialog.showOpenDialog/showSaveDialog` 未传 `defaultPath`
 * 时初始目录固定为「下载」，且系统不再记忆上次访问的目录。这里自行记忆，
 * 让文件/目录选择对话框保持升级前「记住上次目录」的体验。
 */
let lastDialogDir: string | undefined

/** 解析对话框初始路径：调用方显式指定优先，否则回退到上次使用目录 */
export function resolveDialogDefaultPath(defaultPath?: string): string | undefined {
  return defaultPath || lastDialogDir
}

/** 记录用户本次选择结果所在目录（取消或无路径时忽略） */
export function rememberDialogPath(pickedPath?: string): void {
  if (!pickedPath) return
  const dir = path.dirname(pickedPath)
  if (dir && dir !== '.' && dir !== pickedPath) lastDialogDir = dir
}
