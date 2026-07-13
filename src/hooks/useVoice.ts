import { useState, useCallback, useEffect, useRef } from 'react'

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
  transcript: string
  transcript_segments_json: string
  transcript_language: string
  minutes: string
  minutes_type: string
  error_message: string | null
  stt_mode: string
  stt_model: string
  created_at: number
  updated_at: number
  recorded_at: number | null
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
}

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
  minutesModel: {
    provider_id: string
    model_id: string
  } | null
}

export interface VoiceLocalModelStatus {
  available: boolean
  modelType?: string
  modelDir?: string
  error?: string
}

export interface VoiceProgress {
  taskId: string
  phase: string
  message: string
  progress?: number
}

export interface AudioSource {
  id: string
  name: string
  display_id: string
}

export function useVoice() {
  const [tasks, setTasks] = useState<VoiceTask[]>([])
  const [settings, setSettings] = useState<VoiceSettings | null>(null)
  const [progress, setProgress] = useState<VoiceProgress | null>(null)
  const [audioSources, setAudioSources] = useState<AudioSource[]>([])
  const progressUnsubscribe = useRef<(() => void) | null>(null)

  // 进度监听
  useEffect(() => {
    progressUnsubscribe.current = window.electronAPI.voice.onProgress((data) => {
      setProgress(data)
      // 终止阶段刷新任务列表
      if (data.phase === 'done' || data.phase === 'error' || data.phase === 'cancelled') {
        loadTasks()
      }
    })
    return () => {
      progressUnsubscribe.current?.()
    }
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.listTasks()
      setTasks(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('Failed to load voice tasks:', err)
    }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.getSettings()
      if (result && !result.error) {
        setSettings(result)
      }
    } catch (err) {
      console.error('Failed to load voice settings:', err)
    }
  }, [])

  const saveSettings = useCallback(async (newSettings: VoiceSettings) => {
    try {
      await window.electronAPI.voice.setSettings(newSettings)
      setSettings(newSettings)
      return true
    } catch (err) {
      console.error('Failed to save voice settings:', err)
      return false
    }
  }, [])

  const createTask = useCallback(async (title: string, description?: string) => {
    try {
      const result = await window.electronAPI.voice.createTask({ title, description })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to create voice task:', err)
      throw err
    }
  }, [loadTasks])

  const updateTask = useCallback(async (id: string, updates: Partial<VoiceTask>) => {
    try {
      const result = await window.electronAPI.voice.updateTask({
        id,
        title: updates.title,
        description: updates.description,
        status: updates.status,
        transcript: updates.transcript,
        transcriptSegmentsJson: updates.transcript_segments_json,
        transcriptLanguage: updates.transcript_language,
        minutes: updates.minutes,
        minutesType: updates.minutes_type,
        errorMessage: updates.error_message ?? undefined,
      })
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to update voice task:', err)
      throw err
    }
  }, [loadTasks])

  const deleteTask = useCallback(async (id: string) => {
    try {
      await window.electronAPI.voice.deleteTask(id)
      await loadTasks()
    } catch (err) {
      console.error('Failed to delete voice task:', err)
      throw err
    }
  }, [loadTasks])

  const saveAudio = useCallback(async (taskId: string, audioBlob: Blob, format: string, duration: number, sampleRate: number, channels: number) => {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer()
      // 分块转换为 base64，避免展开运算符导致的栈溢出
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[])
      }
      const base64 = btoa(binary)
      const result = await window.electronAPI.voice.saveAudio({
        taskId,
        audioData: base64,
        format,
        duration,
        sampleRate,
        channels,
      })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to save audio:', err)
      throw err
    }
  }, [loadTasks])

  const transcribe = useCallback(async (taskId: string, language?: string) => {
    try {
      const result = await window.electronAPI.voice.transcribe({ taskId, language })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to transcribe:', err)
      throw err
    }
  }, [loadTasks])

  const cancelTranscribe = useCallback(async (taskId: string) => {
    try {
      await window.electronAPI.voice.cancelTranscribe(taskId)
    } catch (err) {
      console.error('Failed to cancel transcribe:', err)
    }
  }, [])

  const generateMinutes = useCallback(async (taskId: string, minutesType: string, customPrompt?: string) => {
    try {
      const result = await window.electronAPI.voice.generateMinutes({ taskId, minutesType, customPrompt })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to generate minutes:', err)
      throw err
    }
  }, [loadTasks])

  const cancelMinutes = useCallback(async (taskId: string) => {
    try {
      await window.electronAPI.voice.cancelMinutes(taskId)
    } catch (err) {
      console.error('Failed to cancel minutes:', err)
    }
  }, [])

  const loadAudioSources = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.getAudioSources()
      setAudioSources(Array.isArray(result) ? result : [])
    } catch (err) {
      console.error('Failed to load audio sources:', err)
    }
  }, [])

  const checkLocalModel = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.checkLocalModel()
      return result as VoiceLocalModelStatus
    } catch (err) {
      console.error('Failed to check local model:', err)
      return { available: false, error: String(err) } as VoiceLocalModelStatus
    }
  }, [])

  const selectDirectory = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.selectDirectory()
      return result as string | null
    } catch (err) {
      console.error('Failed to select directory:', err)
      return null
    }
  }, [])

  // ==================== 实时识别（边录音边识别） ====================

  const realtimeStart = useCallback(async (taskId: string, language?: string) => {
    try {
      const result = await window.electronAPI.voice.realtimeStart({ taskId, language })
      return result as { ok: boolean; error?: string }
    } catch (err) {
      console.error('Failed to start realtime recognition:', err)
      return { ok: false, error: String(err) }
    }
  }, [])

  const realtimeFeed = useCallback(async (taskId: string, samples: Float32Array, sampleRate: number) => {
    try {
      // 传输 ArrayBuffer 的副本（避免 transfer 后原数据不可用）
      const buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer
      await window.electronAPI.voice.realtimeFeed({ taskId, samples: buffer, sampleRate })
    } catch (err) {
      console.error('Failed to feed realtime audio:', err)
    }
  }, [])

  const realtimeStop = useCallback(async (taskId: string) => {
    try {
      const result = await window.electronAPI.voice.realtimeStop(taskId)
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask | null
    } catch (err) {
      console.error('Failed to stop realtime recognition:', err)
      throw err
    }
  }, [loadTasks])

  const realtimeCancel = useCallback(async (taskId: string) => {
    try {
      await window.electronAPI.voice.realtimeCancel(taskId)
    } catch (err) {
      console.error('Failed to cancel realtime recognition:', err)
    }
  }, [])

  const onRealtimeResult = useCallback((callback: (data: { taskId: string; text: string; segment?: { start: number; end: number; text: string }; isFinal: boolean }) => void) => {
    return window.electronAPI.voice.onRealtimeResult(callback)
  }, [])

  return {
    tasks,
    settings,
    progress,
    audioSources,
    loadTasks,
    loadSettings,
    saveSettings,
    createTask,
    updateTask,
    deleteTask,
    saveAudio,
    transcribe,
    cancelTranscribe,
    generateMinutes,
    cancelMinutes,
    loadAudioSources,
    checkLocalModel,
    selectDirectory,
    realtimeStart,
    realtimeFeed,
    realtimeStop,
    realtimeCancel,
    onRealtimeResult,
  }
}
