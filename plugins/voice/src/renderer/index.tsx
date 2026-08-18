/**
 * voice 插件渲染端入口。
 * 路由挂载于 /plugin/voice/ 命名空间。
 * navIcon 读取全局录音状态 store，实现"录音中导航图标变红/暂停变黄"。
 */
import './voice.css'
import React from 'react'
import { AudioOutlined } from '@ant-design/icons'
import { setBridge, setHostI18n } from './store'
import { useVoiceRecordingStore } from './voice-recording.store'
import VoicePage from './VoicePage'
import type { PluginRendererEntry, PluginRendererHost } from '../../../plugin-sdk/src/renderer'

/** 动态导航图标：录音中变红、暂停变黄 */
const VoiceNavIcon: React.FC<{ active: boolean }> = () => {
  const isRecording = useVoiceRecordingStore(s => s.isRecording)
  const isPaused = useVoiceRecordingStore(s => s.isPaused)
  return <AudioOutlined style={isRecording ? { color: isPaused ? '#faad14' : '#ff4d4f' } : undefined} />
}

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: VoicePage }],
  navIcon: VoiceNavIcon,

  init(host: PluginRendererHost): void {
    setBridge(host.bridge)
    setHostI18n(host.i18n.t)
  },

  dispose(): void {
    // 清理由 React 卸载自动完成
  },
}

export default entry