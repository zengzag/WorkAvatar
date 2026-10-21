import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { TerminalExecParams, TerminalExecResult } from '../../shared/ipc-channels'
import TerminalService from '../services/terminal.service'
import { safeHandle } from './_shared'

/**
 * 任务侧边栏终端：用户逐条执行命令，输出通过 TERMINAL_EVENT 推送到所有窗口，
 * 渲染端按 terminalId 过滤，避免多个任务面板互相串扰。
 */
export function registerTerminalHandlers(): void {
  const service = TerminalService.getInstance()

  service.setEventListener((event) => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.TERMINAL_EVENT, event)
      }
    } catch { /* 窗口销毁等场景忽略 */ }
  })

  safeHandle(IPC_CHANNELS.TERMINAL_EXEC, (params: TerminalExecParams): TerminalExecResult => {
    const result = service.exec(
      String(params?.terminalId || ''),
      String(params?.cwd || ''),
      String(params?.command || ''),
    )
    return result.ok
      ? { ok: true, cwd: result.cwd, running: !!result.running }
      : { ok: false, error: result.error }
  })

  safeHandle(IPC_CHANNELS.TERMINAL_STOP, (params: { terminalId: string }) => {
    service.stop(String(params?.terminalId || ''))
    return { ok: true }
  })
}
