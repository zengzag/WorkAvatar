import { create } from 'zustand'

/**
 * 全局录音状态 store：
 * 独立于 KMSVoiceView 组件生命周期，用于在导航栏显示录音指示器。
 * 当用户切换到其他功能模块时，录音和语音识别在后台继续运行。
 */
interface VoiceRecordingState {
  /** 是否正在录音（含实时识别） */
  isRecording: boolean
  /** 是否暂停 */
  isPaused: boolean
  /** 当前录音任务 ID */
  recordingTaskId: string | null
  /** 录音时长（秒） */
  duration: number
  /** 音频电平（0-100） */
  audioLevel: number
  /** 录音来源 */
  recordSource: 'mic' | 'system' | 'both' | null

  setRecording: (recording: boolean) => void
  setPaused: (paused: boolean) => void
  setRecordingTaskId: (taskId: string | null) => void
  setDuration: (duration: number) => void
  setAudioLevel: (level: number) => void
  setRecordSource: (source: 'mic' | 'system' | 'both' | null) => void
  /** 重置全部状态 */
  reset: () => void
}

export const useVoiceRecordingStore = create<VoiceRecordingState>((set) => ({
  isRecording: false,
  isPaused: false,
  recordingTaskId: null,
  duration: 0,
  audioLevel: 0,
  recordSource: null,

  setRecording: (recording) => set({ isRecording: recording }),
  setPaused: (paused) => set({ isPaused: paused }),
  setRecordingTaskId: (taskId) => set({ recordingTaskId: taskId }),
  setDuration: (duration) => set({ duration }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setRecordSource: (source) => set({ recordSource: source }),
  reset: () => set({
    isRecording: false,
    isPaused: false,
    recordingTaskId: null,
    duration: 0,
    audioLevel: 0,
    recordSource: null,
  }),
}))
