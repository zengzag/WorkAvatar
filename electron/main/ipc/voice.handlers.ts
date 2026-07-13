import { ipcMain, desktopCapturer, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'
import type {
  VoiceCreateTaskParams,
  VoiceUpdateTaskParams,
  VoiceSaveAudioParams,
  VoiceTranscribeParams,
  VoiceGenerateMinutesParams,
  VoiceSettings,
  VoiceRealtimeStartParams,
  VoiceRealtimeFeedParams,
} from '../../shared/ipc-channels'
import VoiceService from '../services/voice/voice.service'
import { safeHandle } from './_shared'
import { createLogger } from '../services/logger'

const logger = createLogger('Voice-Handler')

export function registerVoiceHandlers(): void {
  const voiceService = VoiceService.getInstance()

  // ==================== 任务管理 ====================
  safeHandle(IPC_CHANNELS.VOICE_LIST_TASKS, async () => {
    return voiceService.listTasks()
  })

  safeHandle(IPC_CHANNELS.VOICE_GET_TASK, async (id: string) => {
    return voiceService.getTask(id)
  })

  safeHandle(IPC_CHANNELS.VOICE_CREATE_TASK, async (params: VoiceCreateTaskParams) => {
    return voiceService.createTask(params)
  })

  safeHandle(IPC_CHANNELS.VOICE_UPDATE_TASK, async (params: VoiceUpdateTaskParams) => {
    return voiceService.updateTask(params)
  })

  safeHandle(IPC_CHANNELS.VOICE_DELETE_TASK, async (id: string) => {
    voiceService.deleteTask(id)
    return { success: true }
  })

  // ==================== 音频保存 ====================
  safeHandle(IPC_CHANNELS.VOICE_SAVE_AUDIO, async (params: VoiceSaveAudioParams) => {
    return voiceService.saveAudio(
      params.taskId,
      params.audioData,
      params.format,
      params.duration,
      params.sampleRate,
      params.channels,
    )
  })

  // ==================== 语音识别 ====================
  // 不使用 safeHandle，需要透传 event 用于进度推送，且需要 fire-and-forget 模式
  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_event, params: VoiceTranscribeParams) => {
    try {
      const result = await voiceService.transcribe(params.taskId, params.language)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      logger.error(`IPC handler error [VOICE_TRANSCRIBE]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.VOICE_CANCEL_TRANSCRIBE, async (taskId: string) => {
    voiceService.cancelTranscribe(taskId)
    return { success: true }
  })

  // ==================== 会议纪要生成 ====================
  ipcMain.handle(IPC_CHANNELS.VOICE_GENERATE_MINUTES, async (_event, params: VoiceGenerateMinutesParams) => {
    try {
      const result = await voiceService.generateMinutes(params.taskId, params.minutesType, params.customPrompt)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      logger.error(`IPC handler error [VOICE_GENERATE_MINUTES]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.VOICE_CANCEL_MINUTES, async (taskId: string) => {
    voiceService.cancelMinutes(taskId)
    return { success: true }
  })

  // ==================== 设置 ====================
  safeHandle(IPC_CHANNELS.VOICE_GET_SETTINGS, async () => {
    return voiceService.getSettings()
  })

  safeHandle(IPC_CHANNELS.VOICE_SET_SETTINGS, async (settings: VoiceSettings) => {
    voiceService.setSettings(settings)
    return { success: true }
  })

  // ==================== 系统音频源 ====================
  safeHandle(IPC_CHANNELS.VOICE_GET_AUDIO_SOURCES, async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
    })
    return sources.map(s => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id,
    }))
  })

  // ==================== 本地模型状态检查 ====================
  safeHandle(IPC_CHANNELS.VOICE_CHECK_LOCAL_MODEL, async () => {
    return voiceService.checkLocalModel()
  })

  // ==================== 选择目录对话框 ====================
  safeHandle(IPC_CHANNELS.VOICE_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // ==================== 实时识别（边录音边识别） ====================
  safeHandle(IPC_CHANNELS.VOICE_REALTIME_START, async (params: VoiceRealtimeStartParams) => {
    return voiceService.startRealtime(params.taskId, params.language)
  })

  // feed 不使用 safeHandle（高频调用，减少开销），且需要快速返回
  ipcMain.handle(IPC_CHANNELS.VOICE_REALTIME_FEED, async (_event, params: VoiceRealtimeFeedParams) => {
    try {
      const samples = new Float32Array(params.samples)
      voiceService.feedRealtimeAudio(params.taskId, samples, params.sampleRate)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.VOICE_REALTIME_STOP, async (taskId: string) => {
    try {
      return voiceService.stopRealtime(taskId)
    } catch (err: any) {
      logger.error('Realtime stop error:', err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  safeHandle(IPC_CHANNELS.VOICE_REALTIME_CANCEL, async (taskId: string) => {
    voiceService.cancelRealtime(taskId)
    return { success: true }
  })
}
