/**
 * voice 插件共享状态与宿主桥接。
 * - bridge：宿主注入的通用 IPC 桥（invoke 携带 voice 插件 id 前缀）
 * - hostI18n：宿主受控 i18n（namespace=voice 已注册）
 * - voice：封装全部语音 IPC 通道调用与事件订阅，供各组件使用
 * - 主题从宿主 DOM 标记（data-theme）读取并订阅（useAppearance）
 */
import { useEffect, useState } from 'react'
import type { PluginBridge } from '../../../plugin-sdk/src/renderer'
import type {
  VoiceTask,
  VoiceSettings,
  VoiceLocalModelStatus,
  VoiceProgress,
  AudioSource,
  VoiceSubtitleConfig,
} from './types'

let bridge: PluginBridge | null = null
let hostI18n: ((key: string, options?: Record<string, unknown>) => string) | null = null

export function setBridge(b: PluginBridge): void {
  bridge = b
}
export function setHostI18n(t: (key: string, options?: Record<string, unknown>) => string): void {
  hostI18n = t
}
/** 非组件场景（hook/store）下的宿主 i18n 取词，key 形如 voice.xxx */
export function hostT(key: string, options?: Record<string, unknown>): string {
  if (hostI18n) return hostI18n(key, options)
  return key
}

export function invoke<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  if (!bridge) return Promise.reject(new Error('插件桥未就绪'))
  return bridge.invoke<T>(channel, payload)
}

/** 订阅宿主 broadcast 事件，返回取消订阅函数 */
export function onEvent(event: string, callback: (payload: unknown) => void): () => void {
  if (!bridge) return () => {}
  return bridge.onEvent(event, callback)
}

// ====== DOM 主题 / 语言 ======

export function isDarkTheme(): boolean {
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

/** 订阅宿主 DOM 主题变化（宿主 appearance.store 变更时写入），返回取消订阅 */
export function subscribeAppearance(cb: () => void): () => void {
  const observer = new MutationObserver(() => cb())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

/** React 响应式主题（替代宿主 appearance.store 订阅，DOM 变化自动刷新） */
export function useAppearance(): { isDark: boolean } {
  const [isDark, setIsDark] = useState(() => isDarkTheme())
  useEffect(() => {
    const unsub = subscribeAppearance(() => {
      setIsDark(isDarkTheme())
    })
    return unsub
  }, [])
  return { isDark }
}

// ====== 语音 IPC 通道封装 ======

/** 实时识别结果事件 */
export interface RealtimeResultPayload {
  taskId: string
  text: string
  source?: string
  segment?: { start: number; end: number; text: string }
  isFinal: boolean
}

export const voice = {
  // 任务管理
  listTasks: () => invoke<VoiceTask[]>('list-tasks'),
  getTask: (id: string) => invoke<VoiceTask | null>('get-task', id),
  createTask: (params: { title: string; description?: string }) =>
    invoke<VoiceTask | { error: string }>('create-task', params),
  updateTask: (params: {
    id: string
    title?: string
    description?: string
    status?: string
    transcript?: string
    transcriptSegmentsJson?: string
    transcriptLanguage?: string
    minutes?: string
    minutesType?: string
    errorMessage?: string
    notes?: string
  }) => invoke<VoiceTask | { error: string }>('update-task', params),
  deleteTask: (id: string) => invoke<{ success: boolean }>('delete-task', id),

  // 音频保存
  saveAudio: (params: {
    taskId: string
    audioData: string
    format: string
    duration: number
    sampleRate: number
    channels: number
  }) => invoke<VoiceTask | { error: string }>('save-audio', params),
  saveSecondaryAudio: (params: { taskId: string; audioData: string; format: string }) =>
    invoke<VoiceTask | { error: string }>('save-secondary-audio', params),
  mergeDualSourceTranscript: (params: { mainTaskId: string; micTaskId: string; systemTaskId: string }) =>
    invoke<VoiceTask | null | { error: string }>('merge-dual-transcript', params),

  // 语音识别
  transcribe: (params: { taskId: string; language?: string }) =>
    invoke<VoiceTask | { error: string }>('transcribe', params),
  cancelTranscribe: (taskId: string) => invoke<{ success: boolean }>('cancel-transcribe', taskId),
  generateMinutes: (params: { taskId: string; minutesType: string; customPrompt?: string }) =>
    invoke<VoiceTask | { error: string }>('generate-minutes', params),
  cancelMinutes: (taskId: string) => invoke<{ success: boolean }>('cancel-minutes', taskId),

  // 设置
  getSettings: () => invoke<VoiceSettings | { error: string }>('get-settings'),
  setSettings: (settings: VoiceSettings) => invoke<{ success: boolean }>('set-settings', settings),

  // 系统音频源 / 本地模型 / 目录
  getAudioSources: () => invoke<AudioSource[]>('get-audio-sources'),
  checkLocalModel: () => invoke<VoiceLocalModelStatus>('check-local-model'),
  selectDirectory: () => invoke<string | null>('select-directory'),

  // 实时识别
  realtimeStart: (params: { taskId: string; language?: string }) =>
    invoke<{ ok: boolean; error?: string }>('realtime-start', params),
  realtimeFeed: (params: { taskId: string; samples: ArrayBuffer; sampleRate: number; source?: string }) =>
    invoke<{ ok: boolean }>('realtime-feed', params),
  realtimeStop: (taskId: string) =>
    invoke<VoiceTask | null | { error: string }>('realtime-stop', taskId),
  realtimeCancel: (taskId: string) => invoke<{ success: boolean }>('realtime-cancel', taskId),

  // 悬浮字幕
  subtitleShow: (config?: VoiceSubtitleConfig) => invoke<{ success: boolean }>('subtitle-show', config),
  subtitleHide: () => invoke<{ success: boolean }>('subtitle-hide'),
  subtitleToggle: () => invoke<{ visible: boolean }>('subtitle-toggle'),
  subtitleGetVisible: () => invoke<{ visible: boolean }>('subtitle-get-visible'),

  // 事件订阅（返回取消订阅函数）
  onProgress: (cb: (data: VoiceProgress) => void): (() => void) =>
    onEvent('progress', (payload) => cb(payload as VoiceProgress)),
  onRealtimeResult: (cb: (data: RealtimeResultPayload) => void): (() => void) =>
    onEvent('realtime-result', (payload) => cb(payload as RealtimeResultPayload)),
  onSubtitleText: (cb: (data: { text: string; source?: string }) => void): (() => void) =>
    onEvent('subtitle-text', (payload) => cb(payload as { text: string; source?: string })),
  onSubtitleSettings: (cb: (config: VoiceSubtitleConfig) => void): (() => void) =>
    onEvent('subtitle-settings', (payload) => cb(payload as VoiceSubtitleConfig)),
}

export type { VoiceSettings, VoiceProgress }
