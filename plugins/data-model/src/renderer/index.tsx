// data-model 插件渲染端入口

import { setBridge, setHostI18n } from './store'
import { DataModelPage } from './DataModelPage'
import type { PluginRendererEntry, PluginRendererHost } from '../../../plugin-sdk/src/renderer'
import './styles.css'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: DataModelPage }],

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
  }
}

export default entry
