/** 语音任务 */
export interface VoiceTask {
  id: string
  title: string
  description: string
  status: string
  audio_path: string | null
  audio_format: string
  duration: number
  audio_size: number
  audio_channels: number
  sample_rate: number
  transcript?: string
  transcript_segments_json?: string
  transcript_language: string
  minutes?: string
  minutes_type: string
  error_message: string | null
  stt_mode: string
  stt_model: string
  created_at: number
  updated_at: number
  recorded_at: number | null
  secondary_audio_path: string | null
  notes: string
}

/** 转录片段 */
export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

/** 语音设置 */
export interface VoiceSettings {
  sttMode: 'api' | 'local'
  apiConfig: {
    endpoint: string
    apiKey: string
    model: string
    language: string
  }
  localConfig: {
    modelType: 'whisper' | 'paraformer' | 'zipformer'
    modelDir: string
    language: string
  }
  audioConfig: {
    sampleRate: number
    channels: number
  }
  micDeviceId: string
  minutesModel: {
    provider_id: string
    model_id: string
  } | null
  subtitleConfig: {
    enabled: boolean
    fontSize: number
    textColor: string
    backgroundColor: string
    backgroundOpacity: number
    windowWidth: number
    windowHeight: number
  }
}

/** 本地模型状态 */
export interface VoiceLocalModelStatus {
  available: boolean
  modelType?: string
  modelDir?: string
  error?: string
}

/** 进度 */
export interface VoiceProgress {
  taskId: string
  phase: string
  message: string
  progress?: number
  /** 流式生成时的本次增量片段（generateMinutes 期间） */
  chunk?: string
  /** 流式生成时累积的完整文本（generateMinutes 期间） */
  accumulated?: string
}

/** 音频源 */
export interface AudioSource {
  id: string
  name: string
  display_id: string
}

/** 字幕配置（与主进程 subtitle-window 共享） */
export interface VoiceSubtitleConfig {
  fontSize: number
  textColor: string
  backgroundColor: string
  backgroundOpacity: number
  windowWidth: number
  windowHeight: number
}