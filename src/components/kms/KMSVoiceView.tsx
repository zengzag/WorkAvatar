import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Space, Typography, Tag, Input, App, theme, Tooltip,
  Dropdown, Progress, Empty as AntEmpty, Radio, Select,
} from 'antd'
import {
  AudioOutlined, PlusOutlined, DeleteOutlined,
  SoundOutlined, DesktopOutlined, ReloadOutlined,
  FileTextOutlined, ProfileOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, ClockCircleOutlined, EditOutlined, CopyOutlined, DownOutlined,
  StopOutlined, ExclamationCircleOutlined, ThunderboltOutlined,
  PauseOutlined, PlayCircleOutlined, FontSizeOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
  CloudServerOutlined, SettingOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import dayjs from 'dayjs'
import { useVoice, type VoiceTask, type TranscriptSegment } from '../../hooks/useVoice'
import { pathToAppFileUrl } from '../../utils/file-url'

const { Text, Title, Paragraph } = Typography

/** 格式化时长（秒 → mm:ss 或 h:mm:ss） */
function formatDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 格式化时间戳 */
function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 格式化时间戳范围（start - end） */
function formatTimestampRange(start: number, end: number): string {
  return `${formatTimestamp(start)} - ${formatTimestamp(end)}`
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 降采样 */
function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const newLength = Math.round(samples.length / ratio)
  const result = new Float32Array(newLength)
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio
    const srcIndexFloor = Math.floor(srcIndex)
    const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1)
    const fraction = srcIndex - srcIndexFloor
    result[i] = samples[srcIndexFloor] * (1 - fraction) + samples[srcIndexCeil] * fraction
  }
  return result
}

/** 将 Float32Array 采样数据编码为 16-bit PCM WAV Blob */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // audio format (PCM)
  view.setUint16(22, 1, true) // num channels (mono)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  // Write PCM samples
  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
    offset += 2
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

/** 将 WebM Blob 转换为 16kHz 单声道 WAV Blob */
async function webmToWavBlob(webmBlob: Blob, targetSampleRate = 16000): Promise<{ blob: Blob; sampleRate: number }> {
  const arrayBuffer = await webmBlob.arrayBuffer()
  const audioContext = new AudioContext()
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)

    // 混合为单声道
    let samples: Float32Array
    if (audioBuffer.numberOfChannels > 1) {
      samples = new Float32Array(audioBuffer.length)
      for (let i = 0; i < audioBuffer.length; i++) {
        let sum = 0
        for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
          sum += audioBuffer.getChannelData(c)[i]
        }
        samples[i] = sum / audioBuffer.numberOfChannels
      }
    } else {
      samples = audioBuffer.getChannelData(0)
    }

    // 降采样到目标采样率
    if (audioBuffer.sampleRate !== targetSampleRate) {
      samples = downsample(samples, audioBuffer.sampleRate, targetSampleRate)
    }

    const wavBlob = encodeWav(samples, targetSampleRate)
    return { blob: wavBlob, sampleRate: targetSampleRate }
  } finally {
    audioContext.close().catch(() => {})
  }
}

const STATUS_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  created: { color: 'default', icon: <ClockCircleOutlined /> },
  recording: { color: 'processing', icon: <AudioOutlined /> },
  recorded: { color: 'blue', icon: <SoundOutlined /> },
  transcribing: { color: 'processing', icon: <LoadingOutlined /> },
  transcribed: { color: 'cyan', icon: <FileTextOutlined /> },
  generating_minutes: { color: 'processing', icon: <LoadingOutlined /> },
  completed: { color: 'success', icon: <CheckCircleOutlined /> },
  failed: { color: 'error', icon: <CloseCircleOutlined /> },
}

type RecordSource = 'mic' | 'system' | 'both'

interface KMSVoiceViewProps {
  onOpenSettings?: () => void
}

const KMSVoiceView: React.FC<KMSVoiceViewProps> = ({ onOpenSettings }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // 检测暗色主题（用于 audio 元素兼容）
  const isDarkMode = useMemo(() => {
    const hex = token.colorBgContainer.replace('#', '')
    if (hex.length < 6) return false
    const r = parseInt(hex.substring(0, 2), 16)
    const g = parseInt(hex.substring(2, 4), 16)
    const b = parseInt(hex.substring(4, 6), 16)
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
  }, [token.colorBgContainer])
  const { message, modal } = App.useApp()
  const {
    tasks, settings, progress,
    loadTasks, loadSettings,
    createTask, updateTask, deleteTask,
    saveAudio, saveSecondaryAudio, mergeDualSourceTranscript,
    transcribe, cancelTranscribe,
    generateMinutes, cancelMinutes, loadAudioSources,
    realtimeStart, realtimeFeed, realtimeStop, realtimeCancel, onRealtimeResult,
    subtitleShow, subtitleHide, getTask,
  } = useVoice()

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [recordSource, setRecordSource] = useState<RecordSource>('mic')
  /** 每个任务的 STT 引擎模式（优先于全局设置） */
  const [taskSttMode, setTaskSttMode] = useState<'local' | 'api'>(() => (settings?.sttMode as 'local' | 'api') || 'local')

  // 全局设置变化时同步任务级别默认值
  useEffect(() => {
    if (settings?.sttMode) {
      setTaskSttMode(settings.sttMode as 'local' | 'api')
    }
  }, [settings?.sttMode])
  const [recordDuration, setRecordDuration] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  // 每个来源的实时识别状态
  const [realtimeTextBySource, setRealtimeTextBySource] = useState<Record<string, string>>({})
  const [realtimeSegmentsBySource, setRealtimeSegmentsBySource] = useState<Record<string, { start: number; end: number; text: string }[]>>({})
  const [realtimeError, setRealtimeError] = useState('')
  // 每个来源的暂停状态
  const [micPaused, setMicPaused] = useState(false)
  const [systemPaused, setSystemPaused] = useState(false)
  const [subtitleVisible, setSubtitleVisible] = useState(false)
  const [taskListCollapsed, setTaskListCollapsed] = useState(false)
  const [isPreparing, setIsPreparing] = useState(false)
  const [notesText, setNotesText] = useState('')
  const notesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaRecorderMicRef = useRef<MediaRecorder | null>(null)
  const mediaRecorderSystemRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const audioChunksMicRef = useRef<Blob[]>([])
  const audioChunksSystemRef = useRef<Blob[]>([])
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const combinedStreamRef = useRef<MediaStream | null>(null)
  const recordStartTimeRef = useRef<number>(0)
  const pausedDurationRef = useRef<number>(0)
  const pauseStartTimeRef = useRef<number>(0)
  // 每个来源的实时识别 refs
  const scriptProcessorMicRef = useRef<ScriptProcessorNode | null>(null)
  const scriptProcessorSystemRef = useRef<ScriptProcessorNode | null>(null)
  const realtimeSourceMicRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const realtimeSourceSystemRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const realtimeTaskIdRef = useRef<string | null>(null)
  const realtimeTaskIdMicRef = useRef<string | null>(null)
  const realtimeTaskIdSystemRef = useRef<string | null>(null)
  const realtimeUnsubscribeRef = useRef<(() => void) | null>(null)
  const realtimeFeedTimerMicRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const realtimeFeedTimerSystemRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const realtimeBufferMicRef = useRef<Float32Array[]>([])
  const realtimeBufferSystemRef = useRef<Float32Array[]>([])
  const realtimeActiveRef = useRef<boolean>(false)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const micPausedRef = useRef(false)
  const systemPausedRef = useRef(false)
  const recordingTaskIdRef = useRef<string | null>(null)
  const dualRecorderStopCountRef = useRef<number>(0)

  useEffect(() => {
    loadTasks()
    loadSettings()
    loadAudioSources()
  }, [loadTasks, loadSettings, loadAudioSources])

  // 监听实时识别结果（按来源分组）
  useEffect(() => {
    realtimeUnsubscribeRef.current = onRealtimeResult((data) => {
      const source = data.source || 'mic'
      const activeIds = [realtimeTaskIdMicRef.current, realtimeTaskIdSystemRef.current, realtimeTaskIdRef.current]
      if (!activeIds.includes(data.taskId)) return

      if (data.isFinal) {
        setRealtimeTextBySource(prev => ({ ...prev, [source]: data.text }))
      } else {
        setRealtimeTextBySource(prev => ({ ...prev, [source]: data.text }))
        if (data.segment) {
          setRealtimeSegmentsBySource(prev => ({
            ...prev,
            [source]: [...(prev[source] || []), data.segment!],
          }))
        }
      }
    })
    return () => {
      realtimeUnsubscribeRef.current?.()
      realtimeUnsubscribeRef.current = null
    }
  }, [onRealtimeResult])

  // 字幕区自动滚动到底部
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [realtimeTextBySource, realtimeSegmentsBySource])

  // 组件卸载时清理实时识别
  useEffect(() => {
    return () => {
      if (realtimeFeedTimerMicRef.current) clearInterval(realtimeFeedTimerMicRef.current)
      if (realtimeFeedTimerSystemRef.current) clearInterval(realtimeFeedTimerSystemRef.current)
      if (realtimeTaskIdMicRef.current && realtimeActiveRef.current) {
        realtimeCancel(realtimeTaskIdMicRef.current)
      }
      if (realtimeTaskIdSystemRef.current && realtimeActiveRef.current) {
        realtimeCancel(realtimeTaskIdSystemRef.current)
      }
      if (realtimeTaskIdRef.current && realtimeActiveRef.current) {
        realtimeCancel(realtimeTaskIdRef.current)
      }
    }
  }, [realtimeCancel])

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  )

  // 完整任务详情：listTasks 出于性能仅返回元数据，不含 transcript / minutes 等大文本字段。
  // 详情视图需要这些字段，因此选中任务时按需通过 getTask 加载完整数据。
  const [taskDetail, setTaskDetail] = useState<VoiceTask | null>(null)
  const prevSelectedTaskIdRef = useRef<string | null>(null)

  // 依赖 selectedTask?.updated_at：转写/纪要/实时识别完成都会触发 loadTasks → updated_at 变化，
  // 从而在此自动重新拉取完整详情，让转录文本和摘要卡片随之刷新。
  useEffect(() => {
    if (prevSelectedTaskIdRef.current !== selectedTaskId) {
      prevSelectedTaskIdRef.current = selectedTaskId
      // 切换任务时清除旧详情，避免上一个任务的大文本字段串台到新任务
      setTaskDetail(null)
    }
    if (!selectedTaskId) return
    let cancelled = false
    getTask(selectedTaskId).then(task => {
      if (!cancelled) setTaskDetail(task)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [selectedTaskId, selectedTask?.updated_at, getTask])

  // 渲染用任务：以列表元数据（状态/时长等实时刷新）为基底，叠加完整详情的大文本字段。
  // taskDetail 未就绪或属于其它任务时回退到纯元数据，卡片条件会自然推迟到数据就绪后再渲染。
  const activeTask = useMemo<VoiceTask | null>(() => {
    if (!selectedTask) return null
    if (!taskDetail || taskDetail.id !== selectedTask.id) return selectedTask
    return {
      ...selectedTask,
      transcript: taskDetail.transcript,
      transcript_segments_json: taskDetail.transcript_segments_json,
      minutes: taskDetail.minutes,
    }
  }, [selectedTask, taskDetail])

  // 切换任务时同步 notes 文本
  useEffect(() => {
    setNotesText(selectedTask?.notes || '')
  }, [selectedTaskId])

  // 防抖保存 notes
  const handleNotesChange = useCallback((value: string) => {
    setNotesText(value)
    if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current)
    if (!selectedTaskId) return
    notesSaveTimerRef.current = setTimeout(async () => {
      try {
        await updateTask(selectedTaskId, { notes: value })
      } catch (err) {
        // 静默失败，不打断用户输入
      }
    }, 1000)
  }, [selectedTaskId, updateTask])

  // ==================== Recording Logic ====================

  const createFeedTimer = useCallback((taskId: string, bufferRef: React.MutableRefObject<Float32Array[]>, source: string) => {
    return setInterval(() => {
      const buffers = bufferRef.current
      if (buffers.length === 0) return
      bufferRef.current = []
      const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
      const merged = new Float32Array(totalLength)
      let offset = 0
      for (const b of buffers) {
        merged.set(b, offset)
        offset += b.length
      }
      realtimeFeed(taskId, merged, 16000, source)
    }, 300)
  }, [realtimeFeed])

  const createSourceProcessor = useCallback((audioCtx: AudioContext, stream: MediaStream, bufferRef: React.MutableRefObject<Float32Array[]>) => {
    const inputSampleRate = audioCtx.sampleRate
    const source = audioCtx.createMediaStreamSource(stream)
    const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1)
    scriptProcessor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0)
      const downsampled = downsample(new Float32Array(inputData), inputSampleRate, 16000)
      bufferRef.current.push(downsampled)
    }
    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0
    source.connect(scriptProcessor)
    scriptProcessor.connect(silentGain)
    silentGain.connect(audioCtx.destination)
    return { source, scriptProcessor }
  }, [])

  const handleDualSourceStop = useCallback(async (taskId: string, mimeType: string) => {
    const duration = (Date.now() - recordStartTimeRef.current) / 1000
    const micWebmBlob = new Blob(audioChunksMicRef.current, { type: mimeType })
    const systemWebmBlob = new Blob(audioChunksSystemRef.current, { type: mimeType })

    try {
      // 分别转换为 16kHz 单声道 WAV
      const [micWav, systemWav] = await Promise.all([
        webmToWavBlob(micWebmBlob, 16000),
        webmToWavBlob(systemWebmBlob, 16000),
      ])
      // 保存 mic 音频为主音频，system 音频为副音频
      await saveAudio(taskId, micWav.blob, 'wav', duration, micWav.sampleRate, 1)
      await saveSecondaryAudio(taskId, systemWav.blob, 'wav')
      message.success(t('voice.recordingSaved'))
    } catch (err: any) {
      message.error(t('voice.recordingSaveFailed') + ': ' + (err?.message || ''))
    }

    // 停止实时识别 - 分别停止 mic 和 system，然后合并转录
    if (realtimeActiveRef.current) {
      const micTaskId = realtimeTaskIdMicRef.current
      const systemTaskId = realtimeTaskIdSystemRef.current

      if (micTaskId) {
        try { await realtimeStop(micTaskId) } catch (err: any) { console.error('Realtime stop (mic) failed:', err?.message) }
        realtimeTaskIdMicRef.current = null
      }
      if (systemTaskId) {
        try { await realtimeStop(systemTaskId) } catch (err: any) { console.error('Realtime stop (system) failed:', err?.message) }
        realtimeTaskIdSystemRef.current = null
      }
      realtimeActiveRef.current = false

      // 合并双源转录文本到主任务
      if (micTaskId && systemTaskId) {
        try {
          await mergeDualSourceTranscript(taskId, micTaskId, systemTaskId)
        } catch (err: any) {
          console.error('Merge dual source transcript failed:', err?.message)
        }
      }
    }

    // 清理 recorder refs
    mediaRecorderMicRef.current = null
    mediaRecorderSystemRef.current = null

    setRealtimeTextBySource({})
    setRealtimeSegmentsBySource({})
    setRecordDuration(0)
    subtitleHide()
  }, [saveAudio, saveSecondaryAudio, mergeDualSourceTranscript, realtimeStop, subtitleHide, t, message])

  const stopRecording = useCallback(async () => {
    // 停止所有 recorder（单源或双源）
    const stopRecorder = (rec: MediaRecorder | null) => {
      if (rec && rec.state !== 'inactive') {
        rec.stop()
      }
    }
    stopRecorder(mediaRecorderRef.current)
    stopRecorder(mediaRecorderMicRef.current)
    stopRecorder(mediaRecorderSystemRef.current)
    // 停止实时识别音频采集 - mic source
    if (scriptProcessorMicRef.current) {
      scriptProcessorMicRef.current.disconnect()
      scriptProcessorMicRef.current = null
    }
    if (realtimeSourceMicRef.current) {
      realtimeSourceMicRef.current.disconnect()
      realtimeSourceMicRef.current = null
    }
    // 停止实时识别音频采集 - system source
    if (scriptProcessorSystemRef.current) {
      scriptProcessorSystemRef.current.disconnect()
      scriptProcessorSystemRef.current = null
    }
    if (realtimeSourceSystemRef.current) {
      realtimeSourceSystemRef.current.disconnect()
      realtimeSourceSystemRef.current = null
    }
    // 清除 feed timers
    if (realtimeFeedTimerMicRef.current) {
      clearInterval(realtimeFeedTimerMicRef.current)
      realtimeFeedTimerMicRef.current = null
    }
    if (realtimeFeedTimerSystemRef.current) {
      clearInterval(realtimeFeedTimerSystemRef.current)
      realtimeFeedTimerSystemRef.current = null
    }
    // Cleanup streams
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    systemStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
    systemStreamRef.current = null
    combinedStreamRef.current = null

    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {})
      audioContextRef.current = null
    }
    analyserRef.current = null
    setAudioLevel(0)
    setIsRecording(false)
    setIsPaused(false)
    setMicPaused(false)
    setSystemPaused(false)
    micPausedRef.current = false
    systemPausedRef.current = false
    pausedDurationRef.current = 0
    pauseStartTimeRef.current = 0
    // 不在此处清空实时文本和隐藏字幕，由 onstop 回调处理（确保转录结果保存后再清理）
  }, [])

  const pauseRecording = useCallback(() => {
    const pauseRec = (rec: MediaRecorder | null) => {
      if (rec && rec.state === 'recording') {
        rec.pause()
      }
    }
    pauseRec(mediaRecorderRef.current)
    pauseRec(mediaRecorderMicRef.current)
    pauseRec(mediaRecorderSystemRef.current)
    pauseStartTimeRef.current = Date.now()
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    // 暂停实时识别音频采集 - both sources
    if (realtimeFeedTimerMicRef.current) {
      clearInterval(realtimeFeedTimerMicRef.current)
      realtimeFeedTimerMicRef.current = null
    }
    if (realtimeFeedTimerSystemRef.current) {
      clearInterval(realtimeFeedTimerSystemRef.current)
      realtimeFeedTimerSystemRef.current = null
    }
    setIsPaused(true)
    setMicPaused(true)
    setSystemPaused(true)
    micPausedRef.current = true
    systemPausedRef.current = true
  }, [])

  const resumeRecording = useCallback(() => {
    const resumeRec = (rec: MediaRecorder | null) => {
      if (rec && rec.state === 'paused') {
        rec.resume()
      }
    }
    resumeRec(mediaRecorderRef.current)
    resumeRec(mediaRecorderMicRef.current)
    resumeRec(mediaRecorderSystemRef.current)
    if (pauseStartTimeRef.current) {
      pausedDurationRef.current += Date.now() - pauseStartTimeRef.current
      pauseStartTimeRef.current = 0
    }
    // 重启计时器
    timerRef.current = setInterval(() => {
      setRecordDuration((Date.now() - recordStartTimeRef.current - pausedDurationRef.current) / 1000)
    }, 200)
    // 重启音量可视化
    const analyser = analyserRef.current
    if (analyser) {
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const updateLevel = () => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
          setAudioLevel(Math.min(100, (avg / 128) * 100))
          animationFrameRef.current = requestAnimationFrame(updateLevel)
        }
      }
      updateLevel()
    }
    setIsPaused(false)
    setMicPaused(false)
    setSystemPaused(false)
    micPausedRef.current = false
    systemPausedRef.current = false
    // 恢复实时识别音频采集 - mic feed timer
    if (realtimeActiveRef.current && realtimeTaskIdMicRef.current && !realtimeFeedTimerMicRef.current) {
      realtimeFeedTimerMicRef.current = createFeedTimer(realtimeTaskIdMicRef.current, realtimeBufferMicRef, 'mic')
    }
    // 恢复实时识别音频采集 - system feed timer
    if (realtimeActiveRef.current && realtimeTaskIdSystemRef.current && !realtimeFeedTimerSystemRef.current) {
      realtimeFeedTimerSystemRef.current = createFeedTimer(realtimeTaskIdSystemRef.current, realtimeBufferSystemRef, 'system')
    }
    // 恢复实时识别音频采集 - single source (non-both mode)
    if (realtimeActiveRef.current && realtimeTaskIdRef.current && !realtimeFeedTimerMicRef.current && !realtimeFeedTimerSystemRef.current) {
      const source = recordSource === 'system' ? 'system' : 'mic'
      const bufferRef = source === 'system' ? realtimeBufferSystemRef : realtimeBufferMicRef
      const timerRefForSource = source === 'system' ? realtimeFeedTimerSystemRef : realtimeFeedTimerMicRef
      if (!timerRefForSource.current) {
        timerRefForSource.current = createFeedTimer(realtimeTaskIdRef.current, bufferRef, source)
      }
    }
  }, [createFeedTimer, recordSource])

  const togglePauseSource = useCallback((source: 'mic' | 'system') => {
    if (source === 'mic') {
      const newPaused = !micPausedRef.current
      setMicPaused(newPaused)
      micPausedRef.current = newPaused
      if (newPaused) {
        // Pausing mic - clear feed timer and buffer
        if (realtimeFeedTimerMicRef.current) {
          clearInterval(realtimeFeedTimerMicRef.current)
          realtimeFeedTimerMicRef.current = null
        }
        realtimeBufferMicRef.current = []
      } else {
        // Resuming mic - restart feed timer
        const taskId = realtimeTaskIdMicRef.current || realtimeTaskIdRef.current
        if (realtimeActiveRef.current && taskId && !realtimeFeedTimerMicRef.current) {
          realtimeFeedTimerMicRef.current = createFeedTimer(taskId, realtimeBufferMicRef, 'mic')
        }
      }
    } else {
      const newPaused = !systemPausedRef.current
      setSystemPaused(newPaused)
      systemPausedRef.current = newPaused
      if (newPaused) {
        // Pausing system - clear feed timer and buffer
        if (realtimeFeedTimerSystemRef.current) {
          clearInterval(realtimeFeedTimerSystemRef.current)
          realtimeFeedTimerSystemRef.current = null
        }
        realtimeBufferSystemRef.current = []
      } else {
        // Resuming system - restart feed timer
        const taskId = realtimeTaskIdSystemRef.current || realtimeTaskIdRef.current
        if (realtimeActiveRef.current && taskId && !realtimeFeedTimerSystemRef.current) {
          realtimeFeedTimerSystemRef.current = createFeedTimer(taskId, realtimeBufferSystemRef, 'system')
        }
      }
    }
  }, [createFeedTimer])

  const startRecording = useCallback(async (taskId: string) => {
    try {
      audioChunksRef.current = []
      audioChunksMicRef.current = []
      audioChunksSystemRef.current = []
      dualRecorderStopCountRef.current = 0
      recordingTaskIdRef.current = taskId
      const isLocalMode = taskSttMode === 'local'
      // 本地模式需要加载识别模型，显示准备状态
      if (isLocalMode) setIsPreparing(true)
      const streams: MediaStream[] = []

      // Microphone - 使用配置的麦克风设备（Issue 3: 默认系统推荐设备）
      if (recordSource === 'mic' || recordSource === 'both') {
        try {
          const micConstraints: MediaTrackConstraints = {
            echoCancellation: true,
            noiseSuppression: true,
            channelCount: 1,
          }
          const micDeviceId = settings?.micDeviceId
          if (micDeviceId) {
            micConstraints.deviceId = { exact: micDeviceId }
          }
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: micConstraints,
          })
          micStreamRef.current = micStream
          streams.push(micStream)
        } catch (err: any) {
          if (err.name === 'NotAllowedError') {
            message.error(t('voice.micPermissionDenied'))
            return
          }
          throw err
        }
      }

      // System audio via getDisplayMedia (modern Electron approach)
      if (recordSource === 'system' || recordSource === 'both') {
        try {
          const displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,   // Required by spec, stopped immediately after
            audio: true,   // Request system audio (loopback)
          })
          // Stop video tracks immediately - we only want audio
          displayStream.getVideoTracks().forEach(t => t.stop())
          const audioTracks = displayStream.getAudioTracks()
          if (audioTracks.length === 0) {
            if (recordSource === 'system') {
              message.warning(t('voice.noSystemAudioTrack'))
              return
            }
            message.warning(t('voice.systemAudioFallback'))
          } else {
            const systemStream = new MediaStream(audioTracks)
            systemStreamRef.current = systemStream
            streams.push(systemStream)
          }
        } catch (err: any) {
          console.warn('System audio capture failed:', err?.message)
          if (err.name === 'NotAllowedError') {
            if (recordSource === 'system') {
              message.error(t('voice.systemAudioPermissionDenied'))
              return
            }
          } else if (recordSource === 'system') {
            message.error(t('voice.systemAudioFailed'))
            return
          }
          // For 'both', continue with mic only
          message.warning(t('voice.systemAudioFallback'))
        }
      }

      if (streams.length === 0) {
        message.error(t('voice.noAudioStream'))
        return
      }

      // 音频上下文（用于可视化和实时采集）
      const audioCtx = new AudioContext()
      audioContextRef.current = audioCtx

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const isDual = recordSource === 'both' && micStreamRef.current && systemStreamRef.current

      if (isDual) {
        // ========== 双源模式：为 mic 和 system 分别创建 MediaRecorder ==========
        const destination = audioCtx.createMediaStreamDestination()
        audioCtx.createMediaStreamSource(micStreamRef.current!).connect(destination)
        audioCtx.createMediaStreamSource(systemStreamRef.current!).connect(destination)
        combinedStreamRef.current = destination.stream

        // 音量可视化基于合并流
        const vizSource = audioCtx.createMediaStreamSource(destination.stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        vizSource.connect(analyser)
        analyserRef.current = analyser
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          if (analyserRef.current) {
            analyserRef.current.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
            setAudioLevel(Math.min(100, (avg / 128) * 100))
            animationFrameRef.current = requestAnimationFrame(updateLevel)
          }
        }
        updateLevel()

        // ScriptProcessorNodes for realtime PCM capture
        const { source: micSource, scriptProcessor: micProcessor } = createSourceProcessor(audioCtx, micStreamRef.current!, realtimeBufferMicRef)
        scriptProcessorMicRef.current = micProcessor
        realtimeSourceMicRef.current = micSource
        const { source: systemSource, scriptProcessor: systemProcessor } = createSourceProcessor(audioCtx, systemStreamRef.current!, realtimeBufferSystemRef)
        scriptProcessorSystemRef.current = systemProcessor
        realtimeSourceSystemRef.current = systemSource

        // Mic recorder
        const micRecorder = new MediaRecorder(micStreamRef.current!, { mimeType })
        mediaRecorderMicRef.current = micRecorder
        micRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksMicRef.current.push(e.data)
        }
        micRecorder.onstop = async () => {
          dualRecorderStopCountRef.current++
          if (dualRecorderStopCountRef.current >= 2) {
            await handleDualSourceStop(taskId, mimeType)
          }
        }

        // System recorder
        const systemRecorder = new MediaRecorder(systemStreamRef.current!, { mimeType })
        mediaRecorderSystemRef.current = systemRecorder
        systemRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunksSystemRef.current.push(e.data)
        }
        systemRecorder.onstop = async () => {
          dualRecorderStopCountRef.current++
          if (dualRecorderStopCountRef.current >= 2) {
            await handleDualSourceStop(taskId, mimeType)
          }
        }

        micRecorder.start(1000)
        systemRecorder.start(1000)
      } else {
        // ========== 单源模式 ==========
        const recordStream = streams[0]

        // 音量可视化
        const vizSource = audioCtx.createMediaStreamSource(recordStream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        vizSource.connect(analyser)
        analyserRef.current = analyser
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          if (analyserRef.current) {
            analyserRef.current.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
            setAudioLevel(Math.min(100, (avg / 128) * 100))
            animationFrameRef.current = requestAnimationFrame(updateLevel)
          }
        }
        updateLevel()

        // ScriptProcessorNodes for realtime PCM capture
        if (micStreamRef.current) {
          const { source: micSource, scriptProcessor: micProcessor } = createSourceProcessor(audioCtx, micStreamRef.current, realtimeBufferMicRef)
          scriptProcessorMicRef.current = micProcessor
          realtimeSourceMicRef.current = micSource
        }
        if (systemStreamRef.current) {
          const { source: systemSource, scriptProcessor: systemProcessor } = createSourceProcessor(audioCtx, systemStreamRef.current, realtimeBufferSystemRef)
          scriptProcessorSystemRef.current = systemProcessor
          realtimeSourceSystemRef.current = systemSource
        }

        const recorder = new MediaRecorder(recordStream, { mimeType })
        mediaRecorderRef.current = recorder

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data)
          }
        }

        recorder.onstop = async () => {
          const duration = (Date.now() - recordStartTimeRef.current) / 1000
          const webmBlob = new Blob(audioChunksRef.current, { type: mimeType })

          try {
            const { blob: wavBlob, sampleRate } = await webmToWavBlob(webmBlob, 16000)
            await saveAudio(taskId, wavBlob, 'wav', duration, sampleRate, 1)
            message.success(t('voice.recordingSaved'))
          } catch (err: any) {
            message.error(t('voice.recordingSaveFailed') + ': ' + (err?.message || ''))
          }

          // 停止实时识别
          if (realtimeActiveRef.current) {
            if (realtimeTaskIdMicRef.current) {
              try { await realtimeStop(realtimeTaskIdMicRef.current) } catch (err: any) { console.error('Realtime stop (mic) failed:', err?.message) }
              realtimeTaskIdMicRef.current = null
            }
            if (realtimeTaskIdSystemRef.current) {
              try { await realtimeStop(realtimeTaskIdSystemRef.current) } catch (err: any) { console.error('Realtime stop (system) failed:', err?.message) }
              realtimeTaskIdSystemRef.current = null
            }
            if (realtimeTaskIdRef.current) {
              try { await realtimeStop(realtimeTaskIdRef.current) } catch (err: any) { console.error('Realtime stop failed:', err?.message) }
              realtimeTaskIdRef.current = null
            }
            realtimeActiveRef.current = false
          }

          setRealtimeTextBySource({})
          setRealtimeSegmentsBySource({})
          setRecordDuration(0)
          subtitleHide()
        }

        recorder.start(1000)
      }

      recordStartTimeRef.current = Date.now()
      pausedDurationRef.current = 0
      pauseStartTimeRef.current = 0
      setIsRecording(true)
      setIsPaused(false)
      setMicPaused(false)
      setSystemPaused(false)
      micPausedRef.current = false
      systemPausedRef.current = false
      setRecordDuration(0)
      setRealtimeTextBySource({})
      setRealtimeSegmentsBySource({})
      setRealtimeError('')

      // Timer
      timerRef.current = setInterval(() => {
        setRecordDuration((Date.now() - recordStartTimeRef.current - pausedDurationRef.current) / 1000)
      }, 200)

      // 启动实时识别（仅本地模式）
      if (isLocalMode) {
        if (isDual) {
          // Dual source mode: create two realtime sessions with suffixed taskIds
          const micTaskId = taskId + '__mic'
          const systemTaskId = taskId + '__system'
          const micStartResult = await realtimeStart(micTaskId)
          const systemStartResult = await realtimeStart(systemTaskId)
          if (micStartResult.ok || systemStartResult.ok) {
            realtimeActiveRef.current = true
            if (micStartResult.ok) {
              realtimeTaskIdMicRef.current = micTaskId
              realtimeFeedTimerMicRef.current = createFeedTimer(micTaskId, realtimeBufferMicRef, 'mic')
            }
            if (systemStartResult.ok) {
              realtimeTaskIdSystemRef.current = systemTaskId
              realtimeFeedTimerSystemRef.current = createFeedTimer(systemTaskId, realtimeBufferSystemRef, 'system')
            }
            if (subtitleVisible && settings?.subtitleConfig) {
              subtitleShow(settings.subtitleConfig)
            }
          } else {
            setRealtimeError(micStartResult.error || systemStartResult.error || '')
          }
        } else {
          // Single source mode
          const startResult = await realtimeStart(taskId)
          if (startResult.ok) {
            realtimeActiveRef.current = true
            realtimeTaskIdRef.current = taskId
            const source = recordSource === 'system' ? 'system' : 'mic'
            const bufferRef = source === 'system' ? realtimeBufferSystemRef : realtimeBufferMicRef
            const timerRefForSource = source === 'system' ? realtimeFeedTimerSystemRef : realtimeFeedTimerMicRef
            timerRefForSource.current = createFeedTimer(taskId, bufferRef, source)

            if (subtitleVisible && settings?.subtitleConfig) {
              subtitleShow(settings.subtitleConfig)
            }
          } else {
            setRealtimeError(startResult.error || '')
          }
        }
        // 模型加载完成，关闭准备状态
        setIsPreparing(false)
      }

      // Update task status
      await updateTask(taskId, { status: 'recording' })
    } catch (err: any) {
      message.error(t('voice.recordingStartFailed') + ': ' + (err?.message || ''))
      setIsRecording(false)
      setIsPreparing(false)
    }
  }, [recordSource, message, t, saveAudio, updateTask, settings, realtimeStart, realtimeStop, subtitleVisible, subtitleShow, subtitleHide, createSourceProcessor, createFeedTimer, handleDualSourceStop])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
      micStreamRef.current?.getTracks().forEach(t => t.stop())
      systemStreamRef.current?.getTracks().forEach(t => t.stop())
      if (audioContextRef.current) audioContextRef.current.close().catch(() => {})
    }
  }, [])

  // ==================== Task Actions ====================

  const handleCreateTask = useCallback(async () => {
    const title = dayjs().format('YYYY-MM-DD HH:mm') + ' ' + t('voice.defaultTaskTitle')
    try {
      const task = await createTask(title, '')
      setSelectedTaskId(task.id)
    } catch (err: any) {
      message.error(t('voice.createTaskFailed') + ': ' + (err?.message || ''))
    }
  }, [createTask, t, message])

  const handleDeleteTask = useCallback(async (task: VoiceTask) => {
    modal.confirm({
      title: t('voice.deleteTaskConfirm'),
      content: task.title,
      okText: t('common.delete'),
      okType: 'danger',
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await deleteTask(task.id)
          if (selectedTaskId === task.id) {
            setSelectedTaskId(null)
          }
          message.success(t('common.deleteSuccess'))
        } catch (err: any) {
          message.error(t('common.deleteFailed') + ': ' + (err?.message || ''))
        }
      },
    })
  }, [deleteTask, selectedTaskId, modal, t, message])

  const handleTranscribe = useCallback(async (task: VoiceTask) => {
    if (!settings) {
      message.warning(t('voice.noSettings'))
      onOpenSettings?.()
      return
    }
    try {
      await transcribe(task.id, taskSttMode === 'api' ? settings.apiConfig.language : settings.localConfig.language)
    } catch (err: any) {
      message.error(t('voice.transcribeFailed') + ': ' + (err?.message || ''))
    }
  }, [settings, transcribe, t, message, onOpenSettings, taskSttMode])

  const handleGenerateMinutes = useCallback(async (task: VoiceTask, minutesType: string, customPrompt?: string) => {
    if (!settings?.minutesModel?.provider_id) {
      message.warning(t('voice.noMinutesModel'))
      onOpenSettings?.()
      return
    }
    try {
      await generateMinutes(task.id, minutesType, customPrompt)
      message.success(t('voice.minutesGenerated'))
    } catch (err: any) {
      message.error(t('voice.minutesGenerateFailed') + ': ' + (err?.message || ''))
    }
  }, [settings, generateMinutes, t, message, onOpenSettings])

  const handleCopyText = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      message.success(t('common.copied'))
    }).catch(() => {
      message.error(t('common.copyFailed'))
    })
  }, [t, message])

  const handleRenameTask = useCallback(async (task: VoiceTask) => {
    let newTitle = task.title
    modal.confirm({
      title: t('voice.renameTask'),
      content: (
        <Input
          defaultValue={task.title}
          onChange={(e) => { newTitle = e.target.value }}
          autoFocus
        />
      ),
      okText: t('common.save'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        if (newTitle && newTitle !== task.title) {
          await updateTask(task.id, { title: newTitle })
        }
      },
    })
  }, [modal, t, updateTask])

  // ==================== Transcript Segments ====================

  const transcriptSegments = useMemo<TranscriptSegment[]>(() => {
    if (!activeTask?.transcript_segments_json) return []
    try {
      return JSON.parse(activeTask.transcript_segments_json)
    } catch {
      return []
    }
  }, [activeTask])

  // Derive flat realtime text/segments from per-source state
  const realtimeText = Object.values(realtimeTextBySource).join('')
  const realtimeSegments = Object.values(realtimeSegmentsBySource).flat().sort((a, b) => a.start - b.start)

  const isDualSource = recordSource === 'both'

  // ==================== Render ====================

  const renderTaskStatus = (status: string) => {
    const config = STATUS_CONFIG[status] || STATUS_CONFIG.created
    const labelKey = `voice.status_${status}`
    return <Tag color={config.color} icon={config.icon}>{t(labelKey)}</Tag>
  }

  const renderTaskCard = (task: VoiceTask) => {
    const isSelected = task.id === selectedTaskId
    return (
      <Card
        key={task.id}
        size="small"
        hoverable
        onClick={() => setSelectedTaskId(task.id)}
        style={{
          marginBottom: 8,
          border: isSelected ? `2px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}`,
          cursor: 'pointer',
        }}
        styles={{ body: { padding: '10px 12px' } }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text strong ellipsis style={{ fontSize: 13, display: 'block' }}>{task.title || t('voice.untitled')}</Text>
            <Space size={8} style={{ marginTop: 4, fontSize: 12, color: token.colorTextSecondary }}>
              {task.duration > 0 && <span><ClockCircleOutlined /> {formatDuration(task.duration)}</span>}
              <span>{dayjs.unix(task.created_at).format('MM-DD HH:mm')}</span>
            </Space>
            <div style={{ marginTop: 4 }}>
              {renderTaskStatus(task.status)}
            </div>
          </div>
          <Dropdown
            menu={{
              items: [
                { key: 'rename', label: t('common.rename'), icon: <EditOutlined /> },
                { key: 'delete', label: t('common.delete'), icon: <DeleteOutlined />, danger: true },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation()
                if (key === 'rename') handleRenameTask(task)
                if (key === 'delete') handleDeleteTask(task)
              },
            }}
            trigger={['click']}
          >
            <Button type="text" size="small" onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
              <DownOutlined />
            </Button>
          </Dropdown>
        </div>
      </Card>
    )
  }

  const renderRecordingPanel = (task: VoiceTask) => {
    if (isRecording) {
      // 音频电平条可视化
      const audioBars = Array.from({ length: 5 }, (_, i) => {
        const phase = (audioLevel / 100) * (1 - i * 0.15)
        const height = isPaused ? 3 : Math.max(3, Math.min(20, phase * 24 + Math.random() * 4))
        return height
      })

      // 渲染单来源的实时识别内容
      const renderSourceTranscript = (source: string, sourcePaused: boolean) => {
        const text = realtimeTextBySource[source] || ''
        const segments = realtimeSegmentsBySource[source] || []
        const completedText = segments.map(s => s.text).join('')
        const partialText = text.slice(completedText.length)

        if (!text && segments.length === 0) {
          return taskSttMode === 'local' && !sourcePaused ? (
            <Text type="secondary" style={{ fontSize: 13 }}>
              <ThunderboltOutlined /> {t('voice.realtimeRecognizing')}
            </Text>
          ) : null
        }

        return (
          <>
            {segments.map((seg, idx) => (
              <div key={idx} style={{
                marginBottom: 8,
                padding: '4px 0',
                borderBottom: idx < segments.length - 1 || partialText
                  ? `1px solid ${token.colorBorderSecondary}`
                  : 'none',
              }}>
                <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', marginRight: 6 }}>
                  {formatTimestampRange(seg.start, seg.end)}
                </Text>
                <Text style={{ fontSize: 14, lineHeight: 1.7 }}>
                  {seg.text}
                </Text>
              </div>
            ))}
            {partialText && (
              <div style={{ marginBottom: 8, padding: '4px 0' }}>
                <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace', marginRight: 6 }}>
                  {formatTimestamp(recordDuration)}
                </Text>
                <Text style={{ fontSize: 14, lineHeight: 1.7, color: token.colorPrimary }}>
                  {partialText}
                  {!sourcePaused && <span style={{ opacity: 0.5, animation: 'blink 1s infinite' }}>▎</span>}
                </Text>
              </div>
            )}
            {!partialText && !sourcePaused && segments.length > 0 && (
              <Text type="secondary" style={{ fontSize: 11, opacity: 0.5 }}>
                <ThunderboltOutlined /> {t('voice.realtimeListening')}
              </Text>
            )}
          </>
        )
      }

      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 紧凑状态栏 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px',
            background: `linear-gradient(135deg, ${token.colorFillQuaternary}, ${token.colorFillTertiary})`,
            borderRadius: 10,
            marginBottom: 12,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* 录音图标 + 音频电平条 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: '50%',
                  background: isPaused
                    ? token.colorWarning
                    : token.colorError,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: isPaused ? 'none' : `0 0 ${10 + audioLevel * 0.15}px ${token.colorError}55`,
                  transition: 'box-shadow 0.1s',
                }}>
                  {isPaused
                    ? <PauseOutlined style={{ fontSize: 18, color: '#fff' }} />
                    : <AudioOutlined style={{ fontSize: 18, color: '#fff' }} />}
                </div>
                {/* 音频电平条 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 24 }}>
                  {audioBars.map((h, i) => (
                    <div
                      key={i}
                      style={{
                        width: 3, height: h, borderRadius: 2,
                        background: isPaused
                          ? token.colorTextDisabled
                          : `rgba(${parseInt(token.colorError.slice(1, 3), 16)}, ${parseInt(token.colorError.slice(3, 5), 16)}, ${parseInt(token.colorError.slice(5, 7), 16)}, ${0.4 + i * 0.15})`,
                        transition: 'height 0.08s ease-out',
                      }}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>
                  {formatDuration(recordDuration)}
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {isPaused
                    ? t('voice.recordingPaused')
                    : <>
                        {recordSource === 'mic' && t('voice.recordingMic')}
                        {recordSource === 'system' && t('voice.recordingSystem')}
                        {recordSource === 'both' && t('voice.recordingBoth')}
                      </>}
                </Text>
              </div>
            </div>
            {/* 控制按钮区 */}
            <Space size="small">
              {isDualSource ? (
                /* 双源模式：分别暂停/恢复 + 共用停止 */
                <>
                  <Tooltip title={micPaused ? t('voice.resumeMic') : t('voice.pauseMic')}>
                    <Button
                      size="small"
                      type={micPaused ? 'primary' : 'default'}
                      icon={micPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
                      onClick={() => togglePauseSource('mic')}
                    >
                      🎤
                    </Button>
                  </Tooltip>
                  <Tooltip title={systemPaused ? t('voice.resumeSystem') : t('voice.pauseSystem')}>
                    <Button
                      size="small"
                      type={systemPaused ? 'primary' : 'default'}
                      icon={systemPaused ? <PlayCircleOutlined /> : <PauseOutlined />}
                      onClick={() => togglePauseSource('system')}
                    >
                      🔊
                    </Button>
                  </Tooltip>
                  <Button size="small" type="primary" danger icon={<StopOutlined />} onClick={stopRecording}>
                    {t('voice.stopRecording')}
                  </Button>
                </>
              ) : (
                /* 单源模式：暂停/恢复 + 停止 */
                <>
                  {!isPaused ? (
                    <Button size="small" icon={<PauseOutlined />} onClick={pauseRecording}>
                      {t('voice.pauseRecording')}
                    </Button>
                  ) : (
                    <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={resumeRecording}>
                      {t('voice.resumeRecording')}
                    </Button>
                  )}
                  <Button size="small" type="primary" danger icon={<StopOutlined />} onClick={stopRecording}>
                    {t('voice.stopRecording')}
                  </Button>
                </>
              )}
            </Space>
          </div>

          {/* 主体区：字幕 + 手动纪要，左右分栏 */}
          <div style={{ display: 'flex', gap: 12, height: 380 }}>
            {/* 字幕区 */}
            <div
              ref={transcriptScrollRef}
              style={{
                flex: 1, minWidth: 0, overflowY: 'auto', padding: '16px 20px',
                background: token.colorBgContainer, borderRadius: 10,
                border: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              {isPreparing ? (
                /* 识别模型加载中 */
                <div style={{ textAlign: 'center', paddingTop: 60 }}>
                  <LoadingOutlined style={{ fontSize: 24, marginBottom: 12, color: token.colorPrimary }} />
                  <Text type="secondary" style={{ display: 'block', fontSize: 13 }}>
                    {t('voice.preparingModel')}
                  </Text>
                </div>
              ) : realtimeError ? (
                <Text type="warning" style={{ fontSize: 13 }}>
                  <ExclamationCircleOutlined /> {realtimeError}
                </Text>
              ) : isDualSource ? (
                /* 双源模式：分栏显示 */
                <div style={{ display: 'flex', gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600, marginBottom: 8, paddingBottom: 4,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      color: micPaused ? token.colorTextDisabled : token.colorPrimary,
                    }}>
                      🎤 {t('voice.micSource')} {micPaused && `(${t('voice.recordingPaused')})`}
                    </div>
                    {renderSourceTranscript('mic', micPaused)}
                  </div>
                  <div style={{ width: 1, background: token.colorBorderSecondary, alignSelf: 'stretch' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12, fontWeight: 600, marginBottom: 8, paddingBottom: 4,
                      borderBottom: `1px solid ${token.colorBorderSecondary}`,
                      color: systemPaused ? token.colorTextDisabled : '#52c41a',
                    }}>
                      🔊 {t('voice.systemSource')} {systemPaused && `(${t('voice.recordingPaused')})`}
                    </div>
                    {renderSourceTranscript('system', systemPaused)}
                  </div>
                </div>
              ) : (
                /* 单源模式 */
                <>
                  {!realtimeText && realtimeSegments.length === 0 ? (
                    <div style={{ textAlign: 'center', paddingTop: 60 }}>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        {taskSttMode === 'local'
                          ? <><ThunderboltOutlined /> {t('voice.realtimeRecognizing')}</>
                          : t('voice.recordingNoRealtime')}
                      </Text>
                    </div>
                  ) : (
                    <>
                      {realtimeSegments.map((seg, idx) => (
                        <div key={idx} style={{
                          marginBottom: 12,
                          padding: '6px 0',
                          borderBottom: idx < realtimeSegments.length - 1 || realtimeText.slice(realtimeSegments.map(s => s.text).join('').length)
                            ? `1px solid ${token.colorBorderSecondary}`
                            : 'none',
                        }}>
                          <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', marginRight: 8 }}>
                            {formatTimestampRange(seg.start, seg.end)}
                          </Text>
                          <Text style={{ fontSize: 15, lineHeight: 1.8 }}>
                            {seg.text}
                          </Text>
                        </div>
                      ))}
                      {(() => {
                        const completedText = realtimeSegments.map(s => s.text).join('')
                        const partialText = realtimeText.slice(completedText.length)
                        return partialText ? (
                          <div style={{ marginBottom: 12, padding: '6px 0' }}>
                            <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', marginRight: 8 }}>
                              {formatTimestamp(recordDuration)}
                            </Text>
                            <Text style={{ fontSize: 15, lineHeight: 1.8, color: token.colorPrimary }}>
                              {partialText}
                              {!isPaused && <span style={{ opacity: 0.5, animation: 'blink 1s infinite' }}>▎</span>}
                            </Text>
                          </div>
                        ) : null
                      })()}
                    </>
                  )}
                </>
              )}
            </div>
            {/* 手动纪要区 */}
            <div style={{
              width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column',
              background: token.colorBgContainer, borderRadius: 10,
              border: `1px solid ${token.colorBorderSecondary}`,
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}`,
                fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
                color: token.colorTextSecondary,
              }}>
                <EditOutlined /> {t('voice.manualNotes')}
              </div>
              <Input.TextArea
                value={notesText}
                onChange={(e) => handleNotesChange(e.target.value)}
                placeholder={t('voice.notesPlaceholder')}
                variant="borderless"
                style={{
                  flex: 1, resize: 'none', padding: '12px 16px',
                  borderRadius: '0 0 10px 10px', fontSize: 14, lineHeight: 1.6,
                }}
              />
            </div>
          </div>
        </div>
      )
    }

    // 录音中断恢复（如页面刷新后 task 状态仍为 recording）
    if (task.status === 'recording' && !isRecording) {
      return (
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <ExclamationCircleOutlined style={{ fontSize: 48, color: token.colorWarning, marginBottom: 16 }} />
          <Title level={5}>{t('voice.recordingInterrupted')}</Title>
          <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
            {t('voice.recordingInterruptedHint')}
          </Text>
          <Button
            type="primary"
            onClick={() => updateTask(task.id, { status: 'created' })}
          >
            {t('voice.resetRecording')}
          </Button>
        </div>
      )
    }

    // Pre-recording panel - compact recording settings
    return (
      <div style={{ padding: '16px 0' }}>
        <div style={{
          padding: 16,
          background: token.colorFillQuaternary,
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {/* STT 引擎选择 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong>{t('voice.sttEngine')}</Text>
            <Select
              size="small"
              style={{ width: 140 }}
              value={taskSttMode}
              onChange={(val) => setTaskSttMode(val as 'local' | 'api')}
              options={[
                { label: <span><DesktopOutlined /> {t('voice.sttModeLocal')}</span>, value: 'local' },
                { label: <span><CloudServerOutlined /> {t('voice.sttModeApi')}</span>, value: 'api' },
              ]}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Text strong>{t('voice.audioSource')}</Text>
            <Tooltip title={recordSource === 'system' || recordSource === 'both' ? t('voice.systemAudioHint') : t('voice.micHint')}>
              <ExclamationCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 12, cursor: 'help' }} />
            </Tooltip>
          </div>
          <Radio.Group
            value={recordSource}
            onChange={(e) => setRecordSource(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            style={{ width: '100%' }}
          >
            <Radio.Button value="mic" style={{ flex: 1 }}><AudioOutlined /> {t('voice.microphone')}</Radio.Button>
            <Radio.Button value="system" style={{ flex: 1 }}><DesktopOutlined /> {t('voice.systemAudio')}</Radio.Button>
            <Radio.Button value="both" style={{ flex: 1 }}><SoundOutlined /> {t('voice.both')}</Radio.Button>
          </Radio.Group>
          <Button
            type="primary"
            size="large"
            icon={<AudioOutlined />}
            onClick={() => startRecording(task.id)}
            block
          >
            {t('voice.startRecording')}
          </Button>
        </div>
      </div>
    )
  }

  const renderAudioPlayer = (task: VoiceTask) => {
    if (!task.audio_path) return null
    const audioUrl = pathToAppFileUrl(task.audio_path)
    const secondaryUrl = task.secondary_audio_path ? pathToAppFileUrl(task.secondary_audio_path) : null
    const audioStyle: React.CSSProperties = {
      width: '100%',
      filter: isDarkMode ? 'invert(0.88) hue-rotate(180deg)' : 'none',
    }
    const audioProps = {
      controls: true,
      controlsList: 'nodownload nofullscreen noremoteplayback' as const,
      style: audioStyle,
    }
    return (
      <div style={{ marginBottom: 16 }}>
        {secondaryUrl && (
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>🎤 {t('voice.micSource')}</Text>
            <audio src={audioUrl} {...audioProps} />
          </div>
        )}
        {secondaryUrl ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>🔊 {t('voice.systemSource')}</Text>
            <audio src={secondaryUrl} {...audioProps} />
          </div>
        ) : (
          <audio src={audioUrl} {...audioProps} />
        )}
      </div>
    )
  }

  const renderTranscript = (task: VoiceTask) => {
    if (!task.transcript) {
      return (
        <AntEmpty
          description={task.status === 'transcribing' ? t('voice.transcribing') : t('voice.noTranscript')}
          image={AntEmpty.PRESENTED_IMAGE_SIMPLE}
        />
      )
    }

    if (transcriptSegments.length > 0) {
      return (
        <div style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 8 }}>
          {transcriptSegments.map((seg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 12,
                padding: '8px 0',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', flexShrink: 0, minWidth: 110 }}>
                {formatTimestampRange(seg.start, seg.end)}
              </Text>
              <Text style={{ flex: 1 }}>{seg.text}</Text>
            </div>
          ))}
        </div>
      )
    }

    return (
      <Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto' }}>
        {task.transcript}
      </Paragraph>
    )
  }

  const renderMinutes = (task: VoiceTask) => {
    if (!task.minutes) {
      return (
        <AntEmpty
          description={t('voice.noMinutes')}
          image={AntEmpty.PRESENTED_IMAGE_SIMPLE}
        />
      )
    }

    return (
      <div style={{ maxHeight: 500, overflowY: 'auto', paddingRight: 8 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.minutes}</ReactMarkdown>
      </div>
    )
  }

  const renderTaskDetail = (task: VoiceTask) => {
    const isBusy = task.status === 'transcribing' || task.status === 'generating_minutes'
    const taskProgress = progress?.taskId === task.id ? progress : null

    return (
      <div>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <Title level={5} style={{ margin: 0 }}>{task.title || t('voice.untitled')}</Title>
            <Space size={12} style={{ marginTop: 4 }}>
              {renderTaskStatus(task.status)}
              {task.duration > 0 && <Text type="secondary"><ClockCircleOutlined /> {formatDuration(task.duration)}</Text>}
              {task.audio_size > 0 && <Text type="secondary">{formatFileSize(task.audio_size)}</Text>}
              {task.transcript_language && <Text type="secondary">{task.transcript_language}</Text>}
            </Space>
          </div>
          {task.error_message && (
            <Tooltip title={task.error_message}>
              <Tag icon={<ExclamationCircleOutlined />} color="error">{t('voice.error')}</Tag>
            </Tooltip>
          )}
        </div>

        {/* Progress bar */}
        {isBusy && taskProgress && (
          <div style={{ marginBottom: 16 }}>
            <Progress
              percent={taskProgress.progress || 0}
              status="active"
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>{taskProgress.message}</Text>
          </div>
        )}

        {/* Recording panel (for created and recording tasks) */}
        {(task.status === 'created' || task.status === 'recording') && renderRecordingPanel(task)}

        {/* Audio player + actions (for recorded/transcribing/transcribed/generating/completed/failed) */}
        {task.status !== 'created' && task.status !== 'recording' && (
          <>
            {renderAudioPlayer(task)}

            {/* Action buttons */}
            <Space wrap style={{ marginBottom: 16 }}>
              {(task.status === 'recorded' || task.status === 'failed') && (
                <Button
                  type="primary"
                  icon={<FileTextOutlined />}
                  onClick={() => handleTranscribe(task)}
                >
                  {t('voice.startTranscribe')}
                </Button>
              )}
              {task.status === 'transcribing' && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => cancelTranscribe(task.id)}
                >
                  {t('voice.cancelTranscribe')}
                </Button>
              )}
              {(task.status === 'transcribed' || task.status === 'completed') && (
                <Dropdown
                  menu={{
                    items: [
                      { key: 'meeting_minutes', label: t('voice.minutesTypeMeeting'), icon: <ProfileOutlined /> },
                      { key: 'summary', label: t('voice.minutesTypeSummary'), icon: <FileTextOutlined /> },
                      { key: 'action_items', label: t('voice.minutesTypeAction'), icon: <CheckCircleOutlined /> },
                      { type: 'divider' as const },
                      { key: 'custom', label: t('voice.minutesTypeCustom'), icon: <EditOutlined /> },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'custom') {
                        let customPrompt = ''
                        modal.confirm({
                          title: t('voice.customPromptTitle'),
                          content: (
                            <Input.TextArea
                              rows={4}
                              placeholder={t('voice.customPromptPlaceholder')}
                              onChange={(e) => { customPrompt = e.target.value }}
                            />
                          ),
                          okText: t('common.confirm'),
                          cancelText: t('common.cancel'),
                          onOk: async () => {
                            if (customPrompt) {
                              await handleGenerateMinutes(task, 'custom', customPrompt)
                            }
                          },
                        })
                      } else {
                        handleGenerateMinutes(task, key)
                      }
                    },
                  }}
                >
                  <Button
                    type="primary"
                    icon={<ThunderboltOutlined />}
                  >
                    {t('voice.generateMinutes')} <DownOutlined />
                  </Button>
                </Dropdown>
              )}
              {task.status === 'generating_minutes' && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => cancelMinutes(task.id)}
                >
                  {t('voice.cancelMinutes')}
                </Button>
              )}
              {task.transcript && (
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => handleCopyText(task.transcript || '')}
                >
                  {t('voice.copyTranscript')}
                </Button>
              )}
              {task.minutes && (
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => handleCopyText(task.minutes || '')}
                >
                  {t('voice.copyMinutes')}
                </Button>
              )}
            </Space>

            {/* Transcript and Minutes */}
            {(task.transcript || task.status === 'transcribing') && (
              <Card
                size="small"
                title={
                  <Space>
                    <FileTextOutlined />
                    <span>{t('voice.transcript')}</span>
                    {task.transcript_language && <Tag>{task.transcript_language}</Tag>}
                  </Space>
                }
                style={{ marginBottom: 12 }}
              >
                {renderTranscript(task)}
              </Card>
            )}

            {(task.minutes || task.status === 'generating_minutes') && (
              <Card
                size="small"
                title={
                  <Space>
                    <ProfileOutlined />
                    <span>{t('voice.minutes')}</span>
                    {task.minutes_type && <Tag>{t(`voice.minutesType_${task.minutes_type}`)}</Tag>}
                  </Space>
                }
              >
                {renderMinutes(task)}
              </Card>
            )}

            {/* 手动纪要 */}
            <Card
              size="small"
              title={
                <Space>
                  <EditOutlined />
                  <span>{t('voice.manualNotes')}</span>
                </Space>
              }
            >
              <Input.TextArea
                value={notesText}
                onChange={(e) => handleNotesChange(e.target.value)}
                placeholder={t('voice.notesPlaceholder')}
                autoSize={{ minRows: 4, maxRows: 12 }}
                style={{ fontSize: 14, lineHeight: 1.6 }}
              />
            </Card>
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', gap: 12 }}>
      {/* Left: Task List (collapsible) */}
      {taskListCollapsed ? (
        <div style={{ width: 40, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 8 }}>
          <Tooltip title={t('voice.expandTaskList')}>
            <Button size="small" icon={<MenuUnfoldOutlined />} onClick={() => setTaskListCollapsed(false)} />
          </Tooltip>
          <Tooltip title={t('voice.newRecording')}>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={handleCreateTask} />
          </Tooltip>
        </div>
      ) : (
        <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Title level={5} style={{ margin: 0 }}>
              <AudioOutlined /> {t('voice.title')}
            </Title>
            <Space>
              <Tooltip title={t('voice.collapseTaskList')}>
                <Button size="small" icon={<MenuFoldOutlined />} onClick={() => setTaskListCollapsed(true)} />
              </Tooltip>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => { loadTasks(); loadAudioSources() }} />
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={handleCreateTask}>
                {t('voice.newRecording')}
              </Button>
            </Space>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {tasks.length === 0 ? (
              <AntEmpty
                description={t('voice.noTasks')}
                image={AntEmpty.PRESENTED_IMAGE_SIMPLE}
                style={{ marginTop: 60 }}
              />
            ) : (
              tasks.map(task => renderTaskCard(task))
            )}
          </div>
        </div>
      )}

      {/* Right: Task Detail */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Toolbar with subtitle toggle + settings */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <Tooltip title={subtitleVisible ? t('voice.subtitleHide') : t('voice.subtitleShow')}>
            <Button
              size="small"
              type={subtitleVisible ? 'primary' : 'default'}
              icon={<FontSizeOutlined />}
              onClick={async () => {
                if (subtitleVisible) {
                  await subtitleHide()
                  setSubtitleVisible(false)
                } else {
                  await subtitleShow(settings?.subtitleConfig)
                  setSubtitleVisible(true)
                }
              }}
            />
          </Tooltip>
          <Tooltip title={t('voice.settings')}>
            <Button
              size="small"
              icon={<SettingOutlined />}
              onClick={() => onOpenSettings?.()}
            />
          </Tooltip>
        </div>
        <Card style={{ flex: 1, overflowY: 'auto' }} styles={{ body: { padding: 20 } }}>
          {activeTask ? renderTaskDetail(activeTask) : (
            <AntEmpty
              description={t('voice.selectTask')}
              image={AntEmpty.PRESENTED_IMAGE_SIMPLE}
              style={{ marginTop: 100 }}
            >
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateTask}>
                {t('voice.newRecording')}
              </Button>
            </AntEmpty>
          )}
        </Card>
      </div>
    </div>
  )
}

export default KMSVoiceView
