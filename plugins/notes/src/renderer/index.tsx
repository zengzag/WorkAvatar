/**
 * notes 插件渲染端入口
 */
import './notes.css'
import { setBridge, setHostI18n, setHostCapabilities } from './store'
import NotesPage from './NotesPage'
import type { PluginRendererEntry, PluginRendererHost } from '../../../plugin-sdk/src/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: NotesPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
    setHostCapabilities(host.hostCapabilities)
  },

  dispose(): void {
    // 清理由 React 卸载自动完成
  },
}

export default entry