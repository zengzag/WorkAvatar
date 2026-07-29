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
  /** 流式生成时的本次增量片段（generateMinutes 期间） */
  chunk?: string
  /** 流式生成时累积的完整文本（generateMinutes 期间） */
  accumulated?: string
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
  /** 流式生成的纪要内容：taskId → 累积文本。done/error/cancelled 时清空对应条目 */
  const [streamingMinutes, setStreamingMinutes] = useState<Record<string, string>>({})
  const progressUnsubscribe = useRef<(() => void) | null>(null)

  // 进度监听
  useEffect(() => {
    progressUnsubscribe.current = window.electronAPI.voice.onProgress((data) => {
      setProgress(data)
      // 生成中：同步 task.status 并累积流式文本
      if (data.phase === 'generating_minutes' && data.taskId) {
        setTasks(prev => prev.map(t => t.id === data.taskId && t.status !== 'generating_minutes' ? { ...t, status: 'generating_minutes' } : t))
        if (data.accumulated !== undefined) {
          setStreamingMinutes(prev => ({ ...prev, [data.taskId]: data.accumulated as string }))
        }
      }
      // 转写中：同步 task.status
      if (data.phase === 'transcribing' && data.taskId) {
        setTasks(prev => prev.map(t => t.id === data.taskId && t.status !== 'transcribing' ? { ...t, status: 'transcribing' } : t))
      }
      // 终止阶段刷新任务列表，并清理流式状态
      if (data.phase === 'done' || data.phase === 'error' || data.phase === 'cancelled') {
        loadTasks()
        if (data.taskId) {
          setStreamingMinutes(prev => {
            if (!(data.taskId in prev)) return prev
            const next = { ...prev }
            delete next[data.taskId]
            return next
          })
        }
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
        notes: updates.notes,
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

  const saveSecondaryAudio = useCallback(async (taskId: string, audioBlob: Blob, format: string) => {
    try {
      const arrayBuffer = await audioBlob.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      let binary = ''
      const chunkSize = 8192
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[])
      }
      const base64 = btoa(binary)
      const result = await window.electronAPI.voice.saveSecondaryAudio({ taskId, audioData: base64, format })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask
    } catch (err) {
      console.error('Failed to save secondary audio:', err)
      throw err
    }
  }, [loadTasks])

  const mergeDualSourceTranscript = useCallback(async (mainTaskId: string, micTaskId: string, systemTaskId: string) => {
    try {
      const result = await window.electronAPI.voice.mergeDualSourceTranscript({ mainTaskId, micTaskId, systemTaskId })
      if (result && (result as any).error) {
        throw new Error((result as any).error)
      }
      await loadTasks()
      return result as VoiceTask | null
    } catch (err) {
      console.error('Failed to merge dual source transcript:', err)
      throw err
    }
  }, [loadTasks])

  const transcribe = useCallback(async (taskId: string, language?: string) => {
    try {
      // 乐观更新：立即进入 transcribing 状态，让 UI 即时反馈（进度条、禁用按钮等）
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'transcribing' } : t))
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
      // 乐观更新：立即进入 generating_minutes 状态，让进度条和流式渲染立即生效
      // 否则前端 task.status 仍是旧值（如 completed），isBusy 判断失效，用户看不到反馈
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: 'generating_minutes' } : t))
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

  const realtimeFeed = useCallback(async (taskId: string, samples: Float32Array, sampleRate: number, source?: string) => {
    try {
      // 传输 ArrayBuffer 的副本（避免 transfer 后原数据不可用）
      const buffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer
      await window.electronAPI.voice.realtimeFeed({ taskId, samples: buffer, sampleRate, source })
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

  const onRealtimeResult = useCallback((callback: (data: { taskId: string; text: string; source?: string; segment?: { start: number; end: number; text: string }; isFinal: boolean }) => void) => {
    return window.electronAPI.voice.onRealtimeResult(callback)
  }, [])

  // ==================== 悬浮字幕 ====================

  const subtitleShow = useCallback(async (config?: VoiceSettings['subtitleConfig']) => {
    try {
      await window.electronAPI.voice.subtitleShow(config)
    } catch (err) {
      console.error('Failed to show subtitle window:', err)
    }
  }, [])

  const subtitleHide = useCallback(async () => {
    try {
      await window.electronAPI.voice.subtitleHide()
    } catch (err) {
      console.error('Failed to hide subtitle window:', err)
    }
  }, [])

  const subtitleToggle = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.subtitleToggle()
      return result as { visible: boolean }
    } catch (err) {
      console.error('Failed to toggle subtitle window:', err)
      return { visible: false }
    }
  }, [])

  const subtitleGetVisible = useCallback(async () => {
    try {
      const result = await window.electronAPI.voice.subtitleGetVisible()
      return (result as { visible: boolean })?.visible ?? false
    } catch (err) {
      console.error('Failed to get subtitle visibility:', err)
      return false
    }
  }, [])

  // 加载单个任务的完整详情（含 transcript / transcript_segments_json / minutes 等大文本字段）。
  // listTasks 出于性能仅返回元数据，详情视图需要大文本字段时按需调用。
  const getTask = useCallback(async (id: string): Promise<VoiceTask | null> => {
    try {
      const result = await window.electronAPI.voice.getTask(id)
      return (result as VoiceTask | null) || null
    } catch (err) {
      console.error('Failed to get voice task:', err)
      return null
    }
  }, [])

  return {
    tasks,
    settings,
    progress,
    audioSources,
    streamingMinutes,
    loadTasks,
    loadSettings,
    saveSettings,
    createTask,
    updateTask,
    deleteTask,
    getTask,
    saveAudio,
    saveSecondaryAudio,
    mergeDualSourceTranscript,
    transcribe,
    cancelTranscribe,
    generateMinutes,
    cancelMinutes,
    loadAudioSources,
    checkLocalModel,
    realtimeStart,
    realtimeFeed,
    realtimeStop,
    realtimeCancel,
    onRealtimeResult,
    subtitleShow,
    subtitleHide,
    subtitleToggle,
    subtitleGetVisible,
  }
}
