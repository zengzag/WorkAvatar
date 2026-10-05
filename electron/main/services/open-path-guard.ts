import FilePermissionService from './file-permission.service'

/**
 * 危险可执行/脚本扩展名：shell.openPath 会以系统默认程序直接执行，禁止从打开入口触发。
 * 打开入口同时服务任务生成文件/附件等应用数据文件，故不采用严格白名单（会误伤正常预览）。
 */
const EXECUTABLE_EXT_RE = /\.(exe|com|scr|pif|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|dll|jar|sh|bash|zsh|app|desktop|run|bin)$/i

/** 打开/定位前的路径校验：拒绝空值、可执行脚本、敏感路径（凭据/密钥/版本库） */
export function isBlockedOpenPath(filePath: unknown): boolean {
  if (!filePath || typeof filePath !== 'string') return true
  if (EXECUTABLE_EXT_RE.test(filePath)) return true
  return FilePermissionService.getInstance().isSensitivePath(filePath)
}
