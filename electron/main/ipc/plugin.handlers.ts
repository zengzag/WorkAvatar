import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  PluginDeleteParams,
  PluginImportParams,
  PluginInvokeParams,
  PluginSetEnabledParams,
} from '../../shared/channels/plugin'
import PluginHostService from '../services/plugin/plugin-host.service'

export function registerPluginHandlers(): void {
  const host = PluginHostService.getInstance()

  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST, () => ({
    plugins: host.listPlugins(),
    rendererPlugins: host.getRendererPlugins(),
  }))

  ipcMain.handle(
    IPC_CHANNELS.PLUGIN_INVOKE,
    (_event, params: PluginInvokeParams) => host.dispatch(params.pluginId, params.channel, params.payload)
  )

  ipcMain.handle(IPC_CHANNELS.PLUGIN_SET_ENABLED, (_event, params: PluginSetEnabledParams) => {
    host.setEnabled(params.pluginId, params.enabled)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_DELETE, (_event, params: PluginDeleteParams) => {
    host.deletePlugin(params.pluginId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_IMPORT, (_event, params: PluginImportParams) => {
    return host.importPlugin(params?.overwrite)
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_LIST_MESSAGE_ACTIONS, () => {
    return host.getMessageActions()
  })

  ipcMain.handle(IPC_CHANNELS.PLUGIN_OPEN_DIR, () => {
    host.openUserPluginsDir()
    return { success: true }
  })
}
