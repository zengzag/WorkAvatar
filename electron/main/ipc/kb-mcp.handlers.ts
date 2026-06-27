import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type { KBMCPSetConfigParams } from '../../shared/ipc-channels'
import type KBMCPService from '../services/kb-mcp.service'
import { safeHandle } from './_shared'

export function registerKBMCPHandlers(mcpService: KBMCPService) {
  safeHandle(IPC_CHANNELS.KB_MCP_START, async () => {
    return mcpService.start()
  })

  safeHandle(IPC_CHANNELS.KB_MCP_STOP, async () => {
    return mcpService.stop()
  })

  safeHandle(IPC_CHANNELS.KB_MCP_GET_STATUS, () => {
    return mcpService.getStatus()
  })

  safeHandle(IPC_CHANNELS.KB_MCP_GET_CONFIG, () => {
    return mcpService.getConfig()
  })

  safeHandle(IPC_CHANNELS.KB_MCP_SET_CONFIG, (params: KBMCPSetConfigParams) => {
    mcpService.updateConfig(params)
    return { success: true }
  })
}
