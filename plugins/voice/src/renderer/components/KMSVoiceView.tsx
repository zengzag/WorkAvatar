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
  CaretRightOutlined, CaretDownOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import dayjs from 'dayjs'
import { useVoice, type VoiceTask, type TranscriptSegment } from '../useVoice'
import { recordingSession, clearRecordingSession, isRecordingActive } from '../voice-recording-session'
import { useVoiceRecordingStore } from '../voice-recording.store'

const { Text, Title } = Typography

/** 将本地文件绝对路径转换为 app-file:// 协议 URL */
function pathToAppFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return `app-file:///${encodeURI(normalized)}`
}

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
  const { t } = useTranslation('voice')
  const { token } = theme.useToken()
  // 页面可见性状态（替代宿主 useLocation 的 KeepAlive 检测）
  const [isVoiceActive, setIsVoiceActive] = useState(() => document.visibilityState === 'visible')

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
    tasks, settings, progress, streamingMinutes,
    loadTasks, loadSettings,
    createTask, updateTask, deleteTask,
    saveAudio, saveSecondaryAudio, mergeDualSourceTranscript,
    transcribe, cancelTranscribe,
    generateMinutes, cancelMinutes, loadAudioSources,
    realtimeStart, realtimeFeed, realtimeStop, onRealtimeResult,
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
  const [transcriptCollapsed, setTranscriptCollapsed] = useState(false)
  const [minutesCollapsed, setMinutesCollapsed] = useState(false)
  const [notesCollapsed, setNotesCollapsed] = useState(false)
  const notesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件级 refs（录音状态由 recordingSession 单例持有，跨卸载/挂载持久）
  const realtimeUnsubscribeRef = useRef<(() => void) | null>(null)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  // 是否自动滚动到底部：用户向上滚动时暂停自动滚动，重新滚到底部时恢复
  const autoScrollRef = useRef(true)
  // scroll 监听器清理函数（配合回调 ref 使用，确保 DOM 绑定时立即注册监听器）
  const scrollCleanupRef = useRef<(() => void) | null>(null)
  // 流式纪要区域 ref + 自动滚动控制
  const minutesScrollRef = useRef<HTMLDivElement | null>(null)
  const minutesAutoScrollRef = useRef(true)

  // 监听页面可见性（替代宿主 KeepAlive 的 useLocation 检测）
  useEffect(() => {
    const handleVisibility = () => setIsVoiceActive(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  // 回调 ref：DOM 元素绑定时立即注册 scroll 监听器，避免 effect 依赖时序问题
  const setTranscriptScrollRef = useCallback((el: HTMLDivElement | null) => {
    if (scrollCleanupRef.current) {
      scrollCleanupRef.current()
      scrollCleanupRef.current = null
    }
    transcriptScrollRef.current = el
    if (el) {
      const handleScroll = () => {
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        autoScrollRef.current = distanceFromBottom < 40
      }
      el.addEventListener('scroll', handleScroll, { passive: true })
      scrollCleanupRef.current = () => el.removeEventListener('scroll', handleScroll)
    }
  }, [])

  // 全局录音 store（导航栏指示器）
  const setRecordingStore = useVoiceRecordingStore(s => s.setRecording)
  const setPausedStore = useVoiceRecordingStore(s => s.setPaused)
  const setRecordingTaskIdStore = useVoiceRecordingStore(s => s.setRecordingTaskId)
  const setRecordSourceStore = useVoiceRecordingStore(s => s.setRecordSource)

  useEffect(() => {
    loadTasks()
    loadSettings()
    loadAudioSources()
  }, [loadTasks, loadSettings, loadAudioSources])

  // 挂载时从单例恢复录音状态（后台录音恢复到前台）
  useEffect(() => {
    if (isRecordingActive()) {
      setIsRecording(true)
      setIsPaused(recordingSession.isPaused)
      setMicPaused(recordingSession.micPaused)
      setSystemPaused(recordingSession.systemPaused)
      setRecordSource(recordingSession.recordSource || 'mic')
      setRecordDuration((Date.now() - recordingSession.recordStartTime - recordingSession.pausedDuration) / 1000)
      // 恢复卸载前已识别的实时字幕（避免切换界面后字幕丢失）
      setRealtimeTextBySource(recordingSession.realtimeTextBySource)
      setRealtimeSegmentsBySource(recordingSession.realtimeSegmentsBySource)
      // 重启前台计时器（单例里的 durationTimer 在卸载时已被清除，见下方卸载逻辑）
      recordingSession.durationTimer = setInterval(() => {
        setRecordDuration((Date.now() - recordingSession.recordStartTime - recordingSession.pausedDuration) / 1000)
      }, 200)
      // 重启前台音量可视化
      const analyser = recordingSession.analyser
      if (analyser) {
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          if (recordingSession.analyser) {
            recordingSession.analyser.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
            const level = Math.min(100, (avg / 128) * 100)
            setAudioLevel(level)
            recordingSession.animationFrame = requestAnimationFrame(updateLevel)
          }
        }
        updateLevel()
      }
    }
    // 同步到全局 store（导航栏指示器）
    setRecordingStore(isRecordingActive())
    setPausedStore(recordingSession.isPaused)
    setRecordingTaskIdStore(recordingSession.recordingTaskId)
    setRecordSourceStore(recordingSession.recordSource)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 页面隐藏时暂停前台可视化（音量动画 + 时长计时器），避免后台录音时 60fps 持续重渲染
  // 导致渲染进程主线程被占满、切换其他 Tab 卡顿。录音/实时识别本身不受影响（由单例持有）。
  useEffect(() => {
    if (!isVoiceActive) {
      if (recordingSession.durationTimer) {
        clearInterval(recordingSession.durationTimer)
        recordingSession.durationTimer = null
      }
      if (recordingSession.animationFrame) {
        cancelAnimationFrame(recordingSession.animationFrame)
        recordingSession.animationFrame = null
      }
      return
    }
    // 回到页面：恢复隐藏期间单例累积的实时字幕（隐藏时仅更新单例未触发重渲染）
    setRealtimeTextBySource(recordingSession.realtimeTextBySource)
    setRealtimeSegmentsBySource(recordingSession.realtimeSegmentsBySource)
    // 若正在录音且前台可视化未在运行，则恢复
    if (isRecording && recordingSession.analyser && !recordingSession.animationFrame) {
      recordingSession.durationTimer = setInterval(() => {
        setRecordDuration((Date.now() - recordingSession.recordStartTime - recordingSession.pausedDuration) / 1000)
      }, 200)
      const dataArray = new Uint8Array(recordingSession.analyser.frequencyBinCount)
      const updateLevel = () => {
        if (recordingSession.analyser) {
          recordingSession.analyser.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
          setAudioLevel(Math.min(100, (avg / 128) * 100))
          recordingSession.animationFrame = requestAnimationFrame(updateLevel)
        }
      }
      updateLevel()
    }
  }, [isVoiceActive, isRecording])

  // 本地状态变化同步到全局 store（导航栏指示器）
  useEffect(() => {
    setRecordingStore(isRecording)
  }, [isRecording, setRecordingStore])
  useEffect(() => {
    setPausedStore(isPaused)
  }, [isPaused, setPausedStore])
  useEffect(() => {
    setRecordSourceStore(recordSource)
  }, [recordSource, setRecordSourceStore])
  useEffect(() => {
    setRecordingTaskIdStore(recordingSession.recordingTaskId)
  }, [isRecording, setRecordingTaskIdStore])

  // 监听实时识别结果（按来源分组）。组件卸载后单例仍持数据，重新挂载时从单例恢复。
  useEffect(() => {
    realtimeUnsubscribeRef.current = onRealtimeResult((data) => {
      const source = data.source || 'mic'
      const activeIds = [recordingSession.realtimeTaskIdMic, recordingSession.realtimeTaskIdSystem, recordingSession.realtimeTaskId]
      if (!activeIds.includes(data.taskId)) return

      // 页面隐藏时仅更新单例、不触发 React 重渲染，避免后台长时间录音时累积大量段落导致渲染卡顿。
      // 单例始终写入最新值，回到页面时再从单例恢复 UI 状态。
      const updateText = (text: string) => {
        const next = { ...recordingSession.realtimeTextBySource, [source]: text }
        recordingSession.realtimeTextBySource = next
        if (isVoiceActive) setRealtimeTextBySource(next)
      }
      const updateSegment = (segment: { start: number; end: number; text: string }) => {
        const next = {
          ...recordingSession.realtimeSegmentsBySource,
          [source]: [...(recordingSession.realtimeSegmentsBySource[source] || []), segment],
        }
        recordingSession.realtimeSegmentsBySource = next
        if (isVoiceActive) setRealtimeSegmentsBySource(next)
      }

      if (data.isFinal) {
        updateText(data.text)
      } else {
        updateText(data.text)
        if (data.segment) updateSegment(data.segment)
      }
    })
    return () => {
      realtimeUnsubscribeRef.current?.()
      realtimeUnsubscribeRef.current = null
    }
  }, [onRealtimeResult, isVoiceActive])

  // 字幕区自适应滚动：用户向上滚动时暂停自动滚动，重新滚到底部时恢复。
  // scroll 监听器通过回调 ref (setTranscriptScrollRef) 在 DOM 绑定时立即注册，
  // 避免组件重新挂载后 effect 依赖时序导致监听器未注册的问题。
  // 仅在自动滚动开启时跟随最新字幕
  useEffect(() => {
    if (!autoScrollRef.current) return
    const el = transcriptScrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [realtimeTextBySource, realtimeSegmentsBySource])

  // 流式纪要区域自动滚动到底部（生成期间）
  const streamingMinutesText = selectedTaskId ? streamingMinutes[selectedTaskId] : undefined
  useEffect(() => {
    if (!streamingMinutesText) return
    if (!minutesAutoScrollRef.current) return
    const el = minutesScrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [streamingMinutesText])

  // 组件卸载时仅清理前台计时器/动画帧；录音与实时识别在后台继续运行（由 recordingSession 单例持有）
  useEffect(() => {
    return () => {
      if (recordingSession.durationTimer) {
        clearInterval(recordingSession.durationTimer)
        recordingSession.durationTimer = null
      }
      if (recordingSession.animationFrame) {
        cancelAnimationFrame(recordingSession.animationFrame)
        recordingSession.animationFrame = null
      }
    }
  }, [])

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

  const createFeedTimer = useCallback((taskId: string, source: string) => {
    return setInterval(() => {
      const buffers = source === 'system' ? recordingSession.realtimeBufferSystem : recordingSession.realtimeBufferMic
      if (buffers.length === 0) return
      if (source === 'system') recordingSession.realtimeBufferSystem = []
      else recordingSession.realtimeBufferMic = []
      const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
      const merged = new Float32Array(totalLength)
      let offset = 0
      for (const b of buffers) {
        merged.set(b, offset)
        offset += b.length
      }
      realtimeFeed(taskId, merged, 16000, source)
    }, 100)
  }, [realtimeFeed])

  const createSourceProcessor = useCallback((audioCtx: AudioContext, stream: MediaStream, source: string) => {
    const inputSampleRate = audioCtx.sampleRate
    const src = audioCtx.createMediaStreamSource(stream)
    const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1)
    scriptProcessor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0)
      const downsampled = downsample(new Float32Array(inputData), inputSampleRate, 16000)
      if (source === 'system') recordingSession.realtimeBufferSystem.push(downsampled)
      else recordingSession.realtimeBufferMic.push(downsampled)
    }
    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0
    src.connect(scriptProcessor)
    scriptProcessor.connect(silentGain)
    silentGain.connect(audioCtx.destination)
    return { source: src, scriptProcessor }
  }, [])

  const handleDualSourceStop = useCallback(async (taskId: string, mimeType: string) => {
    const duration = (Date.now() - recordingSession.recordStartTime) / 1000
    const micWebmBlob = new Blob(recordingSession.audioChunksMic, { type: mimeType })
    const systemWebmBlob = new Blob(recordingSession.audioChunksSystem, { type: mimeType })

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
    if (recordingSession.realtimeActive) {
      const micTaskId = recordingSession.realtimeTaskIdMic
      const systemTaskId = recordingSession.realtimeTaskIdSystem

      if (micTaskId) {
        try { await realtimeStop(micTaskId) } catch (err: any) { console.error('Realtime stop (mic) failed:', err?.message) }
        recordingSession.realtimeTaskIdMic = null
      }
      if (systemTaskId) {
        try { await realtimeStop(systemTaskId) } catch (err: any) { console.error('Realtime stop (system) failed:', err?.message) }
        recordingSession.realtimeTaskIdSystem = null
      }
      recordingSession.realtimeActive = false

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
    recordingSession.mediaRecorderMic = null
    recordingSession.mediaRecorderSystem = null

    setRealtimeTextBySource({})
    setRealtimeSegmentsBySource({})
    setRecordDuration(0)
    subtitleHide()
    clearRecordingSession()
  }, [saveAudio, saveSecondaryAudio, mergeDualSourceTranscript, realtimeStop, subtitleHide, t, message])

  const stopRecording = useCallback(async () => {
    // 停止所有 recorder（单源或双源）
    const stopRecorder = (rec: MediaRecorder | null) => {
      if (rec && rec.state !== 'inactive') {
        rec.stop()
      }
    }
    stopRecorder(recordingSession.mediaRecorder)
    stopRecorder(recordingSession.mediaRecorderMic)
    stopRecorder(recordingSession.mediaRecorderSystem)
    // 停止实时识别音频采集 - mic source
    if (recordingSession.scriptProcessorMic) {
      recordingSession.scriptProcessorMic.disconnect()
      recordingSession.scriptProcessorMic = null
    }
    if (recordingSession.realtimeSourceMic) {
      recordingSession.realtimeSourceMic.disconnect()
      recordingSession.realtimeSourceMic = null
    }
    // 停止实时识别音频采集 - system source
    if (recordingSession.scriptProcessorSystem) {
      recordingSession.scriptProcessorSystem.disconnect()
      recordingSession.scriptProcessorSystem = null
    }
    if (recordingSession.realtimeSourceSystem) {
      recordingSession.realtimeSourceSystem.disconnect()
      recordingSession.realtimeSourceSystem = null
    }
    // 清除 feed timers
    if (recordingSession.feedTimerMic) {
      clearInterval(recordingSession.feedTimerMic)
      recordingSession.feedTimerMic = null
    }
    if (recordingSession.feedTimerSystem) {
      clearInterval(recordingSession.feedTimerSystem)
      recordingSession.feedTimerSystem = null
    }
    // Cleanup streams
    recordingSession.micStream?.getTracks().forEach(t => t.stop())
    recordingSession.systemStream?.getTracks().forEach(t => t.stop())
    recordingSession.micStream = null
    recordingSession.systemStream = null
    recordingSession.combinedStream = null

    if (recordingSession.durationTimer) {
      clearInterval(recordingSession.durationTimer)
      recordingSession.durationTimer = null
    }
    if (recordingSession.animationFrame) {
      cancelAnimationFrame(recordingSession.animationFrame)
      recordingSession.animationFrame = null
    }
    if (recordingSession.audioContext) {
      recordingSession.audioContext.close().catch(() => {})
      recordingSession.audioContext = null
    }
    recordingSession.analyser = null
    setAudioLevel(0)
    setIsRecording(false)
    setIsPaused(false)
    setMicPaused(false)
    setSystemPaused(false)
    recordingSession.micPaused = false
    recordingSession.systemPaused = false
    recordingSession.isPaused = false
    recordingSession.pausedDuration = 0
    recordingSession.pauseStartTime = 0
    // 不在此处清空实时文本和隐藏字幕，由 onstop 回调处理（确保转录结果保存后再清理）
  }, [])

  const pauseRecording = useCallback(() => {
    const pauseRec = (rec: MediaRecorder | null) => {
      if (rec && rec.state === 'recording') {
        rec.pause()
      }
    }
    pauseRec(recordingSession.mediaRecorder)
    pauseRec(recordingSession.mediaRecorderMic)
    pauseRec(recordingSession.mediaRecorderSystem)
    recordingSession.pauseStartTime = Date.now()
    if (recordingSession.durationTimer) {
      clearInterval(recordingSession.durationTimer)
      recordingSession.durationTimer = null
    }
    if (recordingSession.animationFrame) {
      cancelAnimationFrame(recordingSession.animationFrame)
      recordingSession.animationFrame = null
    }
    // 暂停实时识别音频采集 - both sources
    if (recordingSession.feedTimerMic) {
      clearInterval(recordingSession.feedTimerMic)
      recordingSession.feedTimerMic = null
    }
    if (recordingSession.feedTimerSystem) {
      clearInterval(recordingSession.feedTimerSystem)
      recordingSession.feedTimerSystem = null
    }
    setIsPaused(true)
    setMicPaused(true)
    setSystemPaused(true)
    recordingSession.micPaused = true
    recordingSession.systemPaused = true
    recordingSession.isPaused = true
  }, [])

  const resumeRecording = useCallback(() => {
    const resumeRec = (rec: MediaRecorder | null) => {
      if (rec && rec.state === 'paused') {
        rec.resume()
      }
    }
    resumeRec(recordingSession.mediaRecorder)
    resumeRec(recordingSession.mediaRecorderMic)
    resumeRec(recordingSession.mediaRecorderSystem)
    if (recordingSession.pauseStartTime) {
      recordingSession.pausedDuration += Date.now() - recordingSession.pauseStartTime
      recordingSession.pauseStartTime = 0
    }
    // 重启计时器
    recordingSession.durationTimer = setInterval(() => {
      setRecordDuration((Date.now() - recordingSession.recordStartTime - recordingSession.pausedDuration) / 1000)
    }, 200)
    // 重启音量可视化
    const analyser = recordingSession.analyser
    if (analyser) {
      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const updateLevel = () => {
        if (recordingSession.analyser) {
          recordingSession.analyser.getByteFrequencyData(dataArray)
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
          setAudioLevel(Math.min(100, (avg / 128) * 100))
          recordingSession.animationFrame = requestAnimationFrame(updateLevel)
        }
      }
      updateLevel()
    }
    setIsPaused(false)
    setMicPaused(false)
    setSystemPaused(false)
    recordingSession.micPaused = false
    recordingSession.systemPaused = false
    recordingSession.isPaused = false
    // 恢复实时识别音频采集 - mic feed timer
    if (recordingSession.realtimeActive && recordingSession.realtimeTaskIdMic && !recordingSession.feedTimerMic) {
      recordingSession.feedTimerMic = createFeedTimer(recordingSession.realtimeTaskIdMic, 'mic')
    }
    // 恢复实时识别音频采集 - system feed timer
    if (recordingSession.realtimeActive && recordingSession.realtimeTaskIdSystem && !recordingSession.feedTimerSystem) {
      recordingSession.feedTimerSystem = createFeedTimer(recordingSession.realtimeTaskIdSystem, 'system')
    }
    // 恢复实时识别音频采集 - single source (non-both mode)
    if (recordingSession.realtimeActive && recordingSession.realtimeTaskId && !recordingSession.feedTimerMic && !recordingSession.feedTimerSystem) {
      const source = recordSource === 'system' ? 'system' : 'mic'
      if (source === 'system') {
        recordingSession.feedTimerSystem = createFeedTimer(recordingSession.realtimeTaskId, 'system')
      } else {
        recordingSession.feedTimerMic = createFeedTimer(recordingSession.realtimeTaskId, 'mic')
      }
    }
  }, [createFeedTimer, recordSource])

  const togglePauseSource = useCallback((source: 'mic' | 'system') => {
    if (source === 'mic') {
      const newPaused = !recordingSession.micPaused
      setMicPaused(newPaused)
      recordingSession.micPaused = newPaused
      if (newPaused) {
        // Pausing mic - clear feed timer and buffer
        if (recordingSession.feedTimerMic) {
          clearInterval(recordingSession.feedTimerMic)
          recordingSession.feedTimerMic = null
        }
        recordingSession.realtimeBufferMic = []
      } else {
        // Resuming mic - restart feed timer
        const taskId = recordingSession.realtimeTaskIdMic || recordingSession.realtimeTaskId
        if (recordingSession.realtimeActive && taskId && !recordingSession.feedTimerMic) {
          recordingSession.feedTimerMic = createFeedTimer(taskId, 'mic')
        }
      }
    } else {
      const newPaused = !recordingSession.systemPaused
      setSystemPaused(newPaused)
      recordingSession.systemPaused = newPaused
      if (newPaused) {
        // Pausing system - clear feed timer and buffer
        if (recordingSession.feedTimerSystem) {
          clearInterval(recordingSession.feedTimerSystem)
          recordingSession.feedTimerSystem = null
        }
        recordingSession.realtimeBufferSystem = []
      } else {
        // Resuming system - restart feed timer
        const taskId = recordingSession.realtimeTaskIdSystem || recordingSession.realtimeTaskId
        if (recordingSession.realtimeActive && taskId && !recordingSession.feedTimerSystem) {
          recordingSession.feedTimerSystem = createFeedTimer(taskId, 'system')
        }
      }
    }
  }, [createFeedTimer])

  const startRecording = useCallback(async (taskId: string) => {
    try {
      recordingSession.audioChunks = []
      recordingSession.audioChunksMic = []
      recordingSession.audioChunksSystem = []
      recordingSession.dualRecorderStopCount = 0
      recordingSession.recordingTaskId = taskId
      recordingSession.recordSource = recordSource
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
          recordingSession.micStream = micStream
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
            recordingSession.systemStream = systemStream
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
      recordingSession.audioContext = audioCtx

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const isDual = recordSource === 'both' && recordingSession.micStream && recordingSession.systemStream

      if (isDual) {
        // ========== 双源模式：为 mic 和 system 分别创建 MediaRecorder ==========
        const destination = audioCtx.createMediaStreamDestination()
        audioCtx.createMediaStreamSource(recordingSession.micStream!).connect(destination)
        audioCtx.createMediaStreamSource(recordingSession.systemStream!).connect(destination)
        recordingSession.combinedStream = destination.stream

        // 音量可视化基于合并流
        const vizSource = audioCtx.createMediaStreamSource(destination.stream)
        const analyser = audioCtx.createAnalyser()
        analyser.fftSize = 256
        vizSource.connect(analyser)
        recordingSession.analyser = analyser
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          if (recordingSession.analyser) {
            recordingSession.analyser.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
            setAudioLevel(Math.min(100, (avg / 128) * 100))
            recordingSession.animationFrame = requestAnimationFrame(updateLevel)
          }
        }
        updateLevel()

        // ScriptProcessorNodes for realtime PCM capture
        const { source: micSource, scriptProcessor: micProcessor } = createSourceProcessor(audioCtx, recordingSession.micStream!, 'mic')
        recordingSession.scriptProcessorMic = micProcessor
        recordingSession.realtimeSourceMic = micSource
        const { source: systemSource, scriptProcessor: systemProcessor } = createSourceProcessor(audioCtx, recordingSession.systemStream!, 'system')
        recordingSession.scriptProcessorSystem = systemProcessor
        recordingSession.realtimeSourceSystem = systemSource

        // Mic recorder
        const micRecorder = new MediaRecorder(recordingSession.micStream!, { mimeType })
        recordingSession.mediaRecorderMic = micRecorder
        micRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) recordingSession.audioChunksMic.push(e.data)
        }
        micRecorder.onstop = async () => {
          recordingSession.dualRecorderStopCount++
          if (recordingSession.dualRecorderStopCount >= 2) {
            await handleDualSourceStop(taskId, mimeType)
          }
        }

        // System recorder
        const systemRecorder = new MediaRecorder(recordingSession.systemStream!, { mimeType })
        recordingSession.mediaRecorderSystem = systemRecorder
        systemRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) recordingSession.audioChunksSystem.push(e.data)
        }
        systemRecorder.onstop = async () => {
          recordingSession.dualRecorderStopCount++
          if (recordingSession.dualRecorderStopCount >= 2) {
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
        recordingSession.analyser = analyser
        const dataArray = new Uint8Array(analyser.frequencyBinCount)
        const updateLevel = () => {
          if (recordingSession.analyser) {
            recordingSession.analyser.getByteFrequencyData(dataArray)
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length
            setAudioLevel(Math.min(100, (avg / 128) * 100))
            recordingSession.animationFrame = requestAnimationFrame(updateLevel)
          }
        }
        updateLevel()

        // ScriptProcessorNodes for realtime PCM capture
        if (recordingSession.micStream) {
          const { source: micSource, scriptProcessor: micProcessor } = createSourceProcessor(audioCtx, recordingSession.micStream, 'mic')
          recordingSession.scriptProcessorMic = micProcessor
          recordingSession.realtimeSourceMic = micSource
        }
        if (recordingSession.systemStream) {
          const { source: systemSource, scriptProcessor: systemProcessor } = createSourceProcessor(audioCtx, recordingSession.systemStream, 'system')
          recordingSession.scriptProcessorSystem = systemProcessor
          recordingSession.realtimeSourceSystem = systemSource
        }

        const recorder = new MediaRecorder(recordStream, { mimeType })
        recordingSession.mediaRecorder = recorder

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            recordingSession.audioChunks.push(e.data)
          }
        }

        recorder.onstop = async () => {
          const duration = (Date.now() - recordingSession.recordStartTime) / 1000
          const webmBlob = new Blob(recordingSession.audioChunks, { type: mimeType })

          try {
            const { blob: wavBlob, sampleRate } = await webmToWavBlob(webmBlob, 16000)
            await saveAudio(taskId, wavBlob, 'wav', duration, sampleRate, 1)
            message.success(t('voice.recordingSaved'))
          } catch (err: any) {
            message.error(t('voice.recordingSaveFailed') + ': ' + (err?.message || ''))
          }

          // 停止实时识别
          if (recordingSession.realtimeActive) {
            if (recordingSession.realtimeTaskIdMic) {
              try { await realtimeStop(recordingSession.realtimeTaskIdMic) } catch (err: any) { console.error('Realtime stop (mic) failed:', err?.message) }
              recordingSession.realtimeTaskIdMic = null
            }
            if (recordingSession.realtimeTaskIdSystem) {
              try { await realtimeStop(recordingSession.realtimeTaskIdSystem) } catch (err: any) { console.error('Realtime stop (system) failed:', err?.message) }
              recordingSession.realtimeTaskIdSystem = null
            }
            if (recordingSession.realtimeTaskId) {
              try { await realtimeStop(recordingSession.realtimeTaskId) } catch (err: any) { console.error('Realtime stop failed:', err?.message) }
              recordingSession.realtimeTaskId = null
            }
            recordingSession.realtimeActive = false
          }

          setRealtimeTextBySource({})
          setRealtimeSegmentsBySource({})
          setRecordDuration(0)
          subtitleHide()
          clearRecordingSession()
        }

        recorder.start(1000)
      }

      recordingSession.recordStartTime = Date.now()
      recordingSession.pausedDuration = 0
      recordingSession.pauseStartTime = 0
      recordingSession.isPaused = false
      setIsRecording(true)
      setIsPaused(false)
      setMicPaused(false)
      setSystemPaused(false)
      recordingSession.micPaused = false
      recordingSession.systemPaused = false
      setRecordDuration(0)
      setRealtimeTextBySource({})
      setRealtimeSegmentsBySource({})
      recordingSession.realtimeTextBySource = {}
      recordingSession.realtimeSegmentsBySource = {}
      autoScrollRef.current = true
      setRealtimeError('')

      // Timer
      recordingSession.durationTimer = setInterval(() => {
        setRecordDuration((Date.now() - recordingSession.recordStartTime - recordingSession.pausedDuration) / 1000)
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
            recordingSession.realtimeActive = true
            if (micStartResult.ok) {
              recordingSession.realtimeTaskIdMic = micTaskId
              recordingSession.feedTimerMic = createFeedTimer(micTaskId, 'mic')
            }
            if (systemStartResult.ok) {
              recordingSession.realtimeTaskIdSystem = systemTaskId
              recordingSession.feedTimerSystem = createFeedTimer(systemTaskId, 'system')
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
            recordingSession.realtimeActive = true
            recordingSession.realtimeTaskId = taskId
            const source = recordSource === 'system' ? 'system' : 'mic'
            if (source === 'system') {
              recordingSession.feedTimerSystem = createFeedTimer(taskId, 'system')
            } else {
              recordingSession.feedTimerMic = createFeedTimer(taskId, 'mic')
            }

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
              ref={setTranscriptScrollRef}
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
      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflowY: 'auto' }}>
        {task.transcript}
      </Typography.Paragraph>
    )
  }

  const renderMinutes = (task: VoiceTask) => {
    const currentStreaming = streamingMinutes[task.id]
    const isGenerating = task.status === 'generating_minutes'

    // 生成中且已有流式内容：显示流式文本 + 闪烁光标
    if (isGenerating && currentStreaming) {
      return (
        <div
          ref={minutesScrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            minutesAutoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          }}
          style={{ maxHeight: 500, overflowY: 'auto', paddingRight: 8 }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentStreaming}</ReactMarkdown>
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 16,
              background: token.colorPrimary,
              marginLeft: 2,
              verticalAlign: 'text-bottom',
              animation: 'blink 1s infinite',
              borderRadius: 1,
            }}
          />
        </div>
      )
    }

    // 生成中但还没收到流式内容：显示加载占位（重新生成时旧纪要会被此占位替换）
    if (isGenerating) {
      return (
        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
          <LoadingOutlined style={{ fontSize: 24, marginBottom: 12, color: token.colorPrimary }} />
          <Text type="secondary" style={{ display: 'block', fontSize: 13 }}>
            {t('voice.minutesStreamingHint')}
          </Text>
        </div>
      )
    }

    // 非生成中：显示已保存的纪要
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
                  <div
                    onClick={() => setTranscriptCollapsed(v => !v)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Space>
                      <FileTextOutlined />
                      <span>{t('voice.transcript')}</span>
                      {task.transcript_language && <Tag>{task.transcript_language}</Tag>}
                    </Space>
                    {transcriptCollapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
                  </div>
                }
                style={{ marginBottom: 12 }}
              >
                {!transcriptCollapsed && renderTranscript(task)}
              </Card>
            )}

            {(task.minutes || task.status === 'generating_minutes') && (
              <Card
                size="small"
                title={
                  <div
                    onClick={() => setMinutesCollapsed(v => !v)}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Space>
                      <ProfileOutlined />
                      <span>{t('voice.minutes')}</span>
                      {task.minutes_type && <Tag>{t(`voice.minutesType_${task.minutes_type}`)}</Tag>}
                    </Space>
                    {minutesCollapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
                  </div>
                }
                style={{ marginBottom: 12 }}
              >
                {!minutesCollapsed && renderMinutes(task)}
              </Card>
            )}

            {/* 手动纪要 */}
            <Card
              size="small"
              title={
                <div
                  onClick={() => setNotesCollapsed(v => !v)}
                  style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <Space>
                    <EditOutlined />
                    <span>{t('voice.manualNotes')}</span>
                  </Space>
                  {notesCollapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}
                </div>
              }
            >
              {!notesCollapsed && (
                <Input.TextArea
                  value={notesText}
                  onChange={(e) => handleNotesChange(e.target.value)}
                  placeholder={t('voice.notesPlaceholder')}
                  autoSize={{ minRows: 4, maxRows: 12 }}
                  style={{ fontSize: 14, lineHeight: 1.6 }}
                />
              )}
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
        <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
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