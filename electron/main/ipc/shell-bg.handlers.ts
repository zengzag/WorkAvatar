import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { ShellBgKillParams, ShellBgKillResult, ShellBgListParams, ShellBgTaskItem } from '../../shared/ipc-channels'
import type { BackgroundShellSnapshot } from '../services/background-shell.service'
import BackgroundShellService from '../services/background-shell.service'
import WorkspaceManagerService from '../services/workspace-manager.service'
import { safeHandle } from './_shared'

/** 传给渲染端的任务信息：剔除属主键等内部字段 */
function toTaskItem(snapshot: BackgroundShellSnapshot): ShellBgTaskItem {
  return {
    id: snapshot.id,
    command: snapshot.command,
    cwd: snapshot.cwd,
    pid: snapshot.pid,
    status: snapshot.status,
    exitCode: snapshot.exitCode,
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    totalChars: snapshot.totalChars,
  }
}

/**
 * 后台终端任务的界面入口：列出 + 手动终止。
 * 这是 agent 异常/中止后仍能停掉后台进程的用户侧兜底（会话删除、应用退出另有自动回收）。
 */
export function registerShellBgHandlers(): void {
  const service = BackgroundShellService.getInstance()

  // 任务启动/结束/被终止/被回收时推送渲染端刷新列表（不推每次输出，避免高频 IPC）
  service.setChangeListener(() => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.SHELL_BG_CHANGED)
      }
    } catch { /* 窗口已销毁等场景忽略 */ }
  })

  safeHandle(IPC_CHANNELS.SHELL_BG_LIST, (params: ShellBgListParams) => {
    const all = service.list()
    const conversationId = params?.conversationId
    if (!conversationId) return all.map(toTaskItem)
    // 含委托子会话：子任务启动的后台进程同样应能在主管会话里看到并停止
    const keys = new Set(WorkspaceManagerService.getInstance().getChildConversationIds(conversationId))
    return all.filter(task => keys.has(task.ownerKey)).map(toTaskItem)
  })

  safeHandle(IPC_CHANNELS.SHELL_BG_KILL, (params: ShellBgKillParams): ShellBgKillResult => {
    const result = service.kill(String(params?.taskId || '').trim())
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  })
}
