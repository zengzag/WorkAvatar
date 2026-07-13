import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Space, Typography, Tag, Input, App, theme, Tooltip,
  Dropdown, Progress, Empty as AntEmpty, Radio,
} from 'antd'
import {
  AudioOutlined, PlusOutlined, DeleteOutlined,
  SoundOutlined, DesktopOutlined, ReloadOutlined,
  FileTextOutlined, ProfileOutlined, CheckCircleOutlined, CloseCircleOutlined,
  LoadingOutlined, ClockCircleOutlined, EditOutlined, CopyOutlined, DownOutlined,
  StopOutlined, ExclamationCircleOutlined, ThunderboltOutlined,
  PauseOutlined, PlayCircleOutlined,
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
  const { message, modal } = App.useApp()
  const {
    tasks, settings, progress, audioSources,
    loadTasks, loadSettings,
    createTask, updateTask, deleteTask,
    saveAudio, transcribe, cancelTranscribe,
    generateMinutes, cancelMinutes, loadAudioSources,
    realtimeStart, realtimeFeed, realtimeStop, realtimeCancel, onRealtimeResult,
  } = useVoice()

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [recordSource, setRecordSource] = useState<RecordSource>('mic')
  const [recordDuration, setRecordDuration] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [realtimeText, setRealtimeText] = useState('')
  const [realtimeSegments, setRealtimeSegments] = useState<{ start: number; end: number; text: string }[]>([])
  const [realtimeError, setRealtimeError] = useState('')

  // Recording refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
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
  // 实时识别 refs
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const realtimeSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const realtimeTaskIdRef = useRef<string | null>(null)
  const realtimeUnsubscribeRef = useRef<(() => void) | null>(null)
  const realtimeFeedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const realtimeBufferRef = useRef<Float32Array[]>([])
  const realtimeActiveRef = useRef<boolean>(false)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    loadTasks()
    loadSettings()
    loadAudioSources()
  }, [loadTasks, loadSettings, loadAudioSources])

  // 监听实时识别结果
  useEffect(() => {
    realtimeUnsubscribeRef.current = onRealtimeResult((data) => {
      if (data.taskId === realtimeTaskIdRef.current) {
        if (data.isFinal) {
          setRealtimeText(data.text)
        } else {
          setRealtimeText(data.text)
          if (data.segment) {
            setRealtimeSegments(prev => [...prev, data.segment!])
          }
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
  }, [realtimeText, realtimeSegments])

  // 组件卸载时清理实时识别
  useEffect(() => {
    return () => {
      if (realtimeFeedTimerRef.current) clearInterval(realtimeFeedTimerRef.current)
      if (realtimeTaskIdRef.current && realtimeActiveRef.current) {
        realtimeCancel(realtimeTaskIdRef.current)
      }
    }
  }, [realtimeCancel])

  const selectedTask = useMemo(
    () => tasks.find(t => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  )

  // ==================== Recording Logic ====================

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    // 停止实时识别音频采集
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect()
      scriptProcessorRef.current = null
    }
    if (realtimeSourceRef.current) {
      realtimeSourceRef.current.disconnect()
      realtimeSourceRef.current = null
    }
    if (realtimeFeedTimerRef.current) {
      clearInterval(realtimeFeedTimerRef.current)
      realtimeFeedTimerRef.current = null
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
    pausedDurationRef.current = 0
    pauseStartTimeRef.current = 0
  }, [])

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.pause()
      pauseStartTimeRef.current = Date.now()
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = null
      }
      // 暂停实时识别音频采集
      if (realtimeFeedTimerRef.current) {
        clearInterval(realtimeFeedTimerRef.current)
        realtimeFeedTimerRef.current = null
      }
      setIsPaused(true)
    }
  }, [])

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state === 'paused') {
      recorder.resume()
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
      // 恢复实时识别音频采集
      if (realtimeActiveRef.current && realtimeTaskIdRef.current && !realtimeFeedTimerRef.current) {
        realtimeFeedTimerRef.current = setInterval(() => {
          const buffers = realtimeBufferRef.current
          if (buffers.length === 0) return
          realtimeBufferRef.current = []
          const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
          const merged = new Float32Array(totalLength)
          let offset = 0
          for (const b of buffers) {
            merged.set(b, offset)
            offset += b.length
          }
          realtimeFeed(realtimeTaskIdRef.current!, merged, 16000)
        }, 300)
      }
      setIsPaused(false)
    }
  }, [realtimeFeed])

  const startRecording = useCallback(async (taskId: string) => {
    try {
      audioChunksRef.current = []
      const streams: MediaStream[] = []

      // Microphone
      if (recordSource === 'mic' || recordSource === 'both') {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              channelCount: 1,
            } as MediaTrackConstraints,
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

      // System audio (Windows only, via desktopCapturer)
      if (recordSource === 'system' || recordSource === 'both') {
        if (audioSources.length === 0) {
          await loadAudioSources()
        }
        if (audioSources.length === 0) {
          message.warning(t('voice.noSystemAudioSource'))
          if (recordSource === 'system') return
        } else {
          try {
            const sourceId = audioSources[0].id
            const systemStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                mandatory: {
                  chromeMediaSource: 'desktop',
                  chromeMediaSourceId: sourceId,
                } as any,
              } as MediaTrackConstraints,
            })
            systemStreamRef.current = systemStream
            streams.push(systemStream)
          } catch (err: any) {
            console.warn('System audio capture failed:', err?.message)
            if (recordSource === 'system') {
              message.error(t('voice.systemAudioFailed'))
              return
            }
            // For 'both', continue with mic only
            message.warning(t('voice.systemAudioFallback'))
          }
        }
      }

      if (streams.length === 0) {
        message.error(t('voice.noAudioStream'))
        return
      }

      // Combine streams if needed
      let recordStream: MediaStream
      if (streams.length === 1) {
        recordStream = streams[0]
      } else {
        // Use Web Audio API to merge
        const audioContext = new AudioContext()
        audioContextRef.current = audioContext
        const destination = audioContext.createMediaStreamDestination()
        for (const stream of streams) {
          const source = audioContext.createMediaStreamSource(stream)
          source.connect(destination)
        }
        recordStream = destination.stream
        combinedStreamRef.current = recordStream
      }

      // Setup audio level visualization
      const audioCtx = audioContextRef.current || new AudioContext()
      if (!audioContextRef.current) audioContextRef.current = audioCtx
      const source = audioCtx.createMediaStreamSource(recordStream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
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

      // Setup ScriptProcessorNode for realtime PCM capture (边录音边识别)
      const inputSampleRate = audioCtx.sampleRate
      const scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1)
      scriptProcessor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0)
        // 降采样到 16kHz
        const downsampled = downsample(new Float32Array(inputData), inputSampleRate, 16000)
        realtimeBufferRef.current.push(downsampled)
      }
      // 连接到静音 GainNode → destination（ScriptProcessor 需要连接 destination 才能触发回调）
      const silentGain = audioCtx.createGain()
      silentGain.gain.value = 0
      source.connect(scriptProcessor)
      scriptProcessor.connect(silentGain)
      silentGain.connect(audioCtx.destination)
      scriptProcessorRef.current = scriptProcessor
      realtimeSourceRef.current = source

      // Setup MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
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
          // 转换为 16kHz 单声道 WAV，兼容本地 sherpa-onnx 识别
          const { blob: wavBlob, sampleRate } = await webmToWavBlob(webmBlob, 16000)
          await saveAudio(taskId, wavBlob, 'wav', duration, sampleRate, 1)
          message.success(t('voice.recordingSaved'))
        } catch (err: any) {
          message.error(t('voice.recordingSaveFailed') + ': ' + (err?.message || ''))
        }

        // 停止实时识别，获取最终结果
        if (realtimeActiveRef.current && realtimeTaskIdRef.current === taskId) {
          try {
            await realtimeStop(taskId)
          } catch (err: any) {
            console.error('Realtime stop failed:', err?.message)
          }
          realtimeActiveRef.current = false
          realtimeTaskIdRef.current = null
          setRealtimeText('')
          setRealtimeSegments([])
        }

        setRecordDuration(0)
      }

      recorder.start(1000) // Collect data every second
      recordStartTimeRef.current = Date.now()
      pausedDurationRef.current = 0
      pauseStartTimeRef.current = 0
      setIsRecording(true)
      setIsPaused(false)
      setRecordDuration(0)
      setRealtimeText('')
      setRealtimeSegments([])
      setRealtimeError('')

      // Timer
      timerRef.current = setInterval(() => {
        setRecordDuration((Date.now() - recordStartTimeRef.current - pausedDurationRef.current) / 1000)
      }, 200)

      // 启动实时识别（仅本地模式）
      const isLocalMode = settings?.sttMode === 'local'
      if (isLocalMode) {
        const startResult = await realtimeStart(taskId)
        if (startResult.ok) {
          realtimeActiveRef.current = true
          realtimeTaskIdRef.current = taskId
          // 定期发送累积的音频块到后端
          realtimeFeedTimerRef.current = setInterval(() => {
            const buffers = realtimeBufferRef.current
            if (buffers.length === 0) return
            realtimeBufferRef.current = []
            const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
            const merged = new Float32Array(totalLength)
            let offset = 0
            for (const b of buffers) {
              merged.set(b, offset)
              offset += b.length
            }
            realtimeFeed(taskId, merged, 16000)
          }, 300)
        } else {
          setRealtimeError(startResult.error || '')
        }
      }

      // Update task status
      await updateTask(taskId, { status: 'recording' })
    } catch (err: any) {
      message.error(t('voice.recordingStartFailed') + ': ' + (err?.message || ''))
      setIsRecording(false)
    }
  }, [recordSource, audioSources, loadAudioSources, message, t, saveAudio, updateTask, settings, realtimeStart, realtimeFeed, realtimeStop])

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
      await transcribe(task.id, settings.sttMode === 'api' ? settings.apiConfig.language : settings.localConfig.language)
    } catch (err: any) {
      message.error(t('voice.transcribeFailed') + ': ' + (err?.message || ''))
    }
  }, [settings, transcribe, t, message, onOpenSettings])

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
    if (!selectedTask?.transcript_segments_json) return []
    try {
      return JSON.parse(selectedTask.transcript_segments_json)
    } catch {
      return []
    }
  }, [selectedTask])

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
      // 计算当前正在识别的文本（排除已完成段落）
      const completedText = realtimeSegments.map(s => s.text).join('')
      const partialText = realtimeText.slice(completedText.length)

      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* 紧凑状态栏 */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px',
            background: token.colorFillQuaternary, borderRadius: 8,
            marginBottom: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* 小录音图标 */}
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: isPaused
                  ? token.colorWarning
                  : token.colorError,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: isPaused ? 'none' : `0 0 ${8 + audioLevel * 0.1}px ${token.colorError}66`,
                transition: 'box-shadow 0.1s',
                flexShrink: 0,
              }}>
                {isPaused
                  ? <PauseOutlined style={{ fontSize: 16, color: '#fff' }} />
                  : <AudioOutlined style={{ fontSize: 16, color: '#fff' }} />}
              </div>
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>
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
            <Space size="small">
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
            </Space>
          </div>

          {/* 字幕主体区 */}
          <div
            ref={transcriptScrollRef}
            style={{
              height: 380, overflowY: 'auto', padding: '16px 20px',
              background: token.colorBgContainer, borderRadius: 8,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            {realtimeError ? (
              <Text type="warning" style={{ fontSize: 13 }}>
                <ExclamationCircleOutlined /> {realtimeError}
              </Text>
            ) : realtimeSegments.length === 0 && !partialText ? (
              <div style={{ textAlign: 'center', paddingTop: 60 }}>
                <Text type="secondary" style={{ fontSize: 13 }}>
                  {settings?.sttMode === 'local'
                    ? <><ThunderboltOutlined /> {t('voice.realtimeRecognizing')}</>
                    : t('voice.recordingNoRealtime')}
                </Text>
              </div>
            ) : (
              <>
                {/* 已完成段落（带时间戳） */}
                {realtimeSegments.map((seg, idx) => (
                  <div key={idx} style={{ marginBottom: 12 }}>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', marginRight: 8 }}>
                      {formatTimestamp(seg.start)}
                    </Text>
                    <Text style={{ fontSize: 15, lineHeight: 1.8 }}>
                      {seg.text}
                    </Text>
                  </div>
                ))}
                {/* 当前正在识别的文本 */}
                {partialText && (
                  <div style={{ marginBottom: 12 }}>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', marginRight: 8 }}>
                      {formatTimestamp(recordDuration)}
                    </Text>
                    <Text style={{ fontSize: 15, lineHeight: 1.8, color: token.colorPrimary }}>
                      {partialText}
                      {!isPaused && <span style={{ opacity: 0.5 }}>▎</span>}
                    </Text>
                  </div>
                )}
                {/* 无当前文本时显示识别中提示 */}
                {!partialText && !isPaused && realtimeSegments.length > 0 && (
                  <Text type="secondary" style={{ fontSize: 12, opacity: 0.5 }}>
                    <ThunderboltOutlined /> {t('voice.realtimeListening')}
                  </Text>
                )}
              </>
            )}
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

    // Pre-recording panel
    return (
      <div style={{ padding: '20px 0' }}>
        <Title level={5}>{t('voice.recordSettings')}</Title>
        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('voice.audioSource')}</Text>
          <Radio.Group
            value={recordSource}
            onChange={(e) => setRecordSource(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="mic"><AudioOutlined /> {t('voice.microphone')}</Radio.Button>
            <Radio.Button value="system"><DesktopOutlined /> {t('voice.systemAudio')}</Radio.Button>
            <Radio.Button value="both"><SoundOutlined /> {t('voice.both')}</Radio.Button>
          </Radio.Group>
        </div>
        <div style={{ marginBottom: 16, padding: 12, background: token.colorFillQuaternary, borderRadius: 8 }}>
          <Space>
            <ExclamationCircleOutlined style={{ color: token.colorWarning }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {recordSource === 'system' || recordSource === 'both'
                ? t('voice.systemAudioHint')
                : t('voice.micHint')}
            </Text>
          </Space>
        </div>
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
    )
  }

  const renderAudioPlayer = (task: VoiceTask) => {
    if (!task.audio_path) return null
    // Use app-file:// protocol for local file access
    const audioUrl = pathToAppFileUrl(task.audio_path)
    return (
      <div style={{ marginBottom: 16 }}>
        <audio controls src={audioUrl} style={{ width: '100%' }} />
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
              <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', flexShrink: 0, minWidth: 50 }}>
                {formatTimestamp(seg.start)}
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
                  onClick={() => handleCopyText(task.transcript)}
                >
                  {t('voice.copyTranscript')}
                </Button>
              )}
              {task.minutes && (
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => handleCopyText(task.minutes)}
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
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', gap: 12 }}>
      {/* Left: Task List */}
      <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Title level={5} style={{ margin: 0 }}>
            <AudioOutlined /> {t('voice.title')}
          </Title>
          <Space>
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

      {/* Right: Task Detail */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Card style={{ height: '100%', overflowY: 'auto' }} styles={{ body: { padding: 20 } }}>
          {selectedTask ? renderTaskDetail(selectedTask) : (
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
