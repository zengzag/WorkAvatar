export const VOICE_CHANNELS = {
  // 录音任务管理
  VOICE_LIST_TASKS: 'voice:list-tasks',
  VOICE_CREATE_TASK: 'voice:create-task',
  VOICE_UPDATE_TASK: 'voice:update-task',
  VOICE_DELETE_TASK: 'voice:delete-task',
  VOICE_GET_TASK: 'voice:get-task',
  // 录音文件保存
  VOICE_SAVE_AUDIO: 'voice:save-audio',
  // 语音识别
  VOICE_TRANSCRIBE: 'voice:transcribe',
  VOICE_CANCEL_TRANSCRIBE: 'voice:cancel-transcribe',
  // 会议纪要生成
  VOICE_GENERATE_MINUTES: 'voice:generate-minutes',
  VOICE_CANCEL_MINUTES: 'voice:cancel-minutes',
  // 进度推送（主进程 → 渲染进程）
  VOICE_PROGRESS: 'voice:progress',
  // 设置
  VOICE_GET_SETTINGS: 'voice:get-settings',
  VOICE_SET_SETTINGS: 'voice:set-settings',
  // 系统音频源（desktopCapturer 在主进程调用）
  VOICE_GET_AUDIO_SOURCES: 'voice:get-audio-sources',
  // 本地模型状态检查
  VOICE_CHECK_LOCAL_MODEL: 'voice:check-local-model',
  // 选择目录对话框
  VOICE_SELECT_DIRECTORY: 'voice:select-directory',
  // 实时识别（边录音边识别）
  VOICE_REALTIME_START: 'voice:realtime-start',
  VOICE_REALTIME_FEED: 'voice:realtime-feed',
  VOICE_REALTIME_STOP: 'voice:realtime-stop',
  VOICE_REALTIME_CANCEL: 'voice:realtime-cancel',
  VOICE_REALTIME_RESULT: 'voice:realtime-result',
  // 双源录音：保存第二路音频 + 合并双源转录文本
  VOICE_SAVE_SECONDARY_AUDIO: 'voice:save-secondary-audio',
  VOICE_MERGE_DUAL_TRANSCRIPT: 'voice:merge-dual-transcript',
  // 悬浮字幕窗口
  VOICE_SUBTITLE_SHOW: 'voice:subtitle-show',
  VOICE_SUBTITLE_HIDE: 'voice:subtitle-hide',
  VOICE_SUBTITLE_TOGGLE: 'voice:subtitle-toggle',
  VOICE_SUBTITLE_UPDATE_TEXT: 'voice:subtitle-update-text',
  VOICE_SUBTITLE_UPDATE_SETTINGS: 'voice:subtitle-update-settings',
  VOICE_SUBTITLE_GET_VISIBLE: 'voice:subtitle-get-visible',
} as const

export interface VoiceCreateTaskParams {
  title: string
  description?: string
}

export interface VoiceUpdateTaskParams {
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
  sttMode?: string
  sttModel?: string
  notes?: string
}

export interface VoiceSaveAudioParams {
  taskId: string
  /** Base64 编码的音频数据（WAV 格式） */
  audioData: string
  format: string
  duration: number
  sampleRate: number
  channels: number
}

/** 双源录音：保存第二路音频（系统音频） */
export interface VoiceSaveSecondaryAudioParams {
  taskId: string
  audioData: string
  format: string
}

/** 双源录音：合并 mic + system 转录文本到主任务 */
export interface VoiceMergeDualTranscriptParams {
  mainTaskId: string
  micTaskId: string
  systemTaskId: string
}

export interface VoiceTranscribeParams {
  taskId: string
  language?: string
}

/** 实时识别参数 */
export interface VoiceRealtimeStartParams {
  taskId: string
  language?: string
}

/** 实时识别音频块参数 */
export interface VoiceRealtimeFeedParams {
  taskId: string
  /** 16kHz 单声道 PCM 采样数据（Float32Array 的 ArrayBuffer） */
  samples: ArrayBuffer
  sampleRate: number
  /** 音频来源标识（'mic' | 'system'），用于区分双源识别 */
  source?: string
}

/** 实时识别结果（推送到前端） */
export interface VoiceRealtimeResult {
  taskId: string
  /** 当前实时累积的文本 */
  text: string
  /** 音频来源标识（'mic' | 'system'） */
  source?: string
  /** 新完成的段落（endpoint 触发时） */
  segment?: { start: number; end: number; text: string }
  /** 是否为最终结果（停止时） */
  isFinal: boolean
}

export interface VoiceGenerateMinutesParams {
  taskId: string
  /** 纪要类型：meeting_minutes | summary | action_items | custom */
  minutesType: string
  customPrompt?: string
}

export interface VoiceSTTApiConfig {
  endpoint: string
  apiKey: string
  model: string
  language: string
}

export type VoiceLocalModelType = 'whisper' | 'paraformer' | 'zipformer'

export interface VoiceSTTLocalConfig {
  modelType: VoiceLocalModelType
  modelDir: string
  language: string
}

export interface VoiceAudioConfig {
  sampleRate: number
  channels: number
}

/** 悬浮字幕窗口外观配置 */
export interface VoiceSubtitleConfig {
  /** 是否启用悬浮字幕 */
  enabled: boolean
  /** 字体大小（px） */
  fontSize: number
  /** 文字颜色 */
  textColor: string
  /** 背景颜色 */
  backgroundColor: string
  /** 背景不透明度（0-100） */
  backgroundOpacity: number
  /** 窗口宽度 */
  windowWidth: number
  /** 窗口高度 */
  windowHeight: number
}

export interface VoiceSettings {
  sttMode: 'api' | 'local'
  apiConfig: VoiceSTTApiConfig
  localConfig: VoiceSTTLocalConfig
  audioConfig: VoiceAudioConfig
  /** 麦克风设备 ID（空字符串表示使用系统默认设备） */
  micDeviceId: string
  /** 会议纪要生成所用的 LLM 模型配置 */
  minutesModel: {
    provider_id: string
    model_id: string
  } | null
  /** 悬浮字幕窗口配置 */
  subtitleConfig: VoiceSubtitleConfig
}

export interface VoiceLocalModelStatus {
  available: boolean
  modelType?: VoiceLocalModelType
  modelDir?: string
  error?: string
}
