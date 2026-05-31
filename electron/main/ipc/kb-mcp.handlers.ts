import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { KBMCPSetConfigParams } from '../../shared/ipc-channels'
import type KBMCPService from '../services/kb-mcp.service'

export function registerKBMCPHandlers(mcpService: KBMCPService) {
  ipcMain.handle(IPC_CHANNELS.KB_MCP_START, async () => {
    return mcpService.start()
  })

  ipcMain.handle(IPC_CHANNELS.KB_MCP_STOP, async () => {
    return mcpService.stop()
  })

  ipcMain.handle(IPC_CHANNELS.KB_MCP_GET_STATUS, () => {
    return mcpService.getStatus()
  })

  ipcMain.handle(IPC_CHANNELS.KB_MCP_GET_CONFIG, () => {
    return mcpService.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.KB_MCP_SET_CONFIG, (_, params: KBMCPSetConfigParams) => {
    mcpService.updateConfig(params)
    return { success: true }
  })
}
