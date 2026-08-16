import fs from 'fs'
import path from 'path'
import DatabaseService from '../database.service'
import KMSDatabaseService from '../kms/kms-database.service'
import { createPiProvider } from '../agent/llm/pi-provider-factory'
import type { LLMMessage } from '../agent/llm/types'
import PathService from '../path.service'
import { generateId } from '../common-utils'
import { createLogger } from '../logger'
import type { VoiceSettings, VoiceCreateTaskParams, VoiceUpdateTaskParams, VoiceLocalModelStatus, VoiceSaveSecondaryAudioParams, VoiceMergeDualTranscriptParams } from '../../../shared/ipc-channels'
import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../../shared/ipc-channels'
import LocalSTTService from './local-stt.service'
import SubtitleWindowService from './subtitle-window.service'

const logger = createLogger('Voice')

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

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  sttMode: 'local',
  apiConfig: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: '',
    model: 'whisper-1',
    language: 'zh',
  },
  localConfig: {
    modelType: 'zipformer' as const,
    modelDir: '(内置流式 Zipformer 模型)',
    language: 'zh',
  },
  audioConfig: {
    sampleRate: 16000,
    channels: 1,
  },
  micDeviceId: '',
  minutesModel: null,
  subtitleConfig: {
    enabled: false,
    fontSize: 28,
    textColor: '#ffffff',
    backgroundColor: '#000000',
    backgroundOpacity: 60,
    windowWidth: 600,
    windowHeight: 120,
  },
}

class VoiceService {
  private static instance: VoiceService
  private transcribeAbortControllers: Map<string, AbortController> = new Map()
  private minutesAbortControllers: Map<string, AbortController> = new Map()

  private constructor() {}

  static getInstance(): VoiceService {
    if (!VoiceService.instance) {
      VoiceService.instance = new VoiceService()
    }
    return VoiceService.instance
  }

  private getDb() {
    return KMSDatabaseService.getInstance().getDb()
  }

  private getMainDb() {
    return DatabaseService.getInstance().getDb()
  }

  private getVoiceDir(): string {
    const dir = path.join(PathService.getInstance().getDataDir(), 'voice')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  // ==================== Settings ====================

  getSettings(): VoiceSettings {
    try {
      const row = this.getMainDb().prepare('SELECT value FROM settings WHERE key = ?').get('voice_settings') as any
      if (row?.value) {
        const saved = JSON.parse(row.value)
        return {
          ...DEFAULT_VOICE_SETTINGS,
          ...saved,
          apiConfig: { ...DEFAULT_VOICE_SETTINGS.apiConfig, ...(saved.apiConfig || {}) },
          localConfig: { ...DEFAULT_VOICE_SETTINGS.localConfig, ...(saved.localConfig || {}) },
          audioConfig: { ...DEFAULT_VOICE_SETTINGS.audioConfig, ...(saved.audioConfig || {}) },
          subtitleConfig: { ...DEFAULT_VOICE_SETTINGS.subtitleConfig, ...(saved.subtitleConfig || {}) },
        }
      }
    } catch (err: any) {
      logger.warn('Failed to read voice settings:', err?.message || err)
    }
    return DEFAULT_VOICE_SETTINGS
  }

  setSettings(settings: VoiceSettings): void {
    this.getMainDb().prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch()) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run('voice_settings', JSON.stringify(settings))
  }

  /** 检查本地模型是否可用（使用内置流式 Zipformer 模型） */
  checkLocalModel(): VoiceLocalModelStatus {
    const settings = this.getSettings()
    if (settings.sttMode !== 'local') {
      return { available: false, error: 'STT mode is not set to local' }
    }
    return LocalSTTService.getInstance().checkBuiltinModel()
  }

  // ==================== Task CRUD ====================

  /**
   * 列出所有语音任务（仅元数据，不含 transcript/minutes 等大文本字段）。
   * 大文本字段仅在 getTask(id) 时按需加载，避免列表页一次性加载全部大文本。
   */
  listTasks(): VoiceTask[] {
    return this.getDb().prepare(`
      SELECT id, title, description, status, audio_path, audio_format, duration,
             audio_size, audio_channels, sample_rate, transcript_language,
             minutes_type, error_message, stt_mode, stt_model,
             created_at, updated_at, recorded_at, secondary_audio_path, notes
      FROM kms_voice_tasks ORDER BY created_at DESC
    `).all() as VoiceTask[]
  }

  getTask(id: string): VoiceTask | null {
    return (this.getDb().prepare('SELECT * FROM kms_voice_tasks WHERE id = ?').get(id) as VoiceTask) || null
  }

  createTask(params: VoiceCreateTaskParams): VoiceTask {
    const id = generateId()
    const now = Math.floor(Date.now() / 1000)
    this.getDb().prepare(
      `INSERT INTO kms_voice_tasks (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, 'created', ?, ?)`
    ).run(id, params.title || '', params.description || '', now, now)
    return this.getTask(id)!
  }

  updateTask(params: VoiceUpdateTaskParams): VoiceTask | null {
    const task = this.getTask(params.id)
    if (!task) return null
    const fields: string[] = []
    const values: any[] = []
    const set = (col: string, val: any) => {
      if (val !== undefined) {
        fields.push(`${col} = ?`)
        values.push(val)
      }
    }
    set('title', params.title)
    set('description', params.description)
    set('status', params.status)
    set('transcript', params.transcript)
    set('transcript_segments_json', params.transcriptSegmentsJson)
    set('transcript_language', params.transcriptLanguage)
    set('minutes', params.minutes)
    set('minutes_type', params.minutesType)
    set('error_message', params.errorMessage)
    set('stt_mode', params.sttMode)
    set('stt_model', params.sttModel)
    set('notes', params.notes)
    if (fields.length === 0) return task
    fields.push('updated_at = ?')
    values.push(Math.floor(Date.now() / 1000))
    values.push(params.id)
    this.getDb().prepare(`UPDATE kms_voice_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.getTask(params.id)
  }

  deleteTask(id: string): void {
    const task = this.getTask(id)
    if (task?.audio_path && fs.existsSync(task.audio_path)) {
      try { fs.unlinkSync(task.audio_path) } catch { /* ignore */ }
    }
    if (task?.secondary_audio_path && fs.existsSync(task.secondary_audio_path)) {
      try { fs.unlinkSync(task.secondary_audio_path) } catch { /* ignore */ }
    }
    this.getDb().prepare('DELETE FROM kms_voice_tasks WHERE id = ?').run(id)
  }

  // ==================== Audio Save ====================

  saveAudio(taskId: string, audioData: string, format: string, duration: number, sampleRate: number, channels: number): VoiceTask | null {
    const task = this.getTask(taskId)
    if (!task) return null

    const ext = format === 'wav' ? 'wav' : 'webm'
    const fileName = `${taskId}.${ext}`
    const filePath = path.join(this.getVoiceDir(), fileName)

    const buffer = Buffer.from(audioData, 'base64')
    fs.writeFileSync(filePath, buffer)

    const now = Math.floor(Date.now() / 1000)
    this.getDb().prepare(
      `UPDATE kms_voice_tasks SET audio_path = ?, audio_format = ?, duration = ?, audio_size = ?, audio_channels = ?, sample_rate = ?, status = 'recorded', recorded_at = ?, updated_at = ? WHERE id = ?`
    ).run(filePath, format, Math.round(duration), buffer.length, channels, sampleRate, now, now, taskId)

    return this.getTask(taskId)
  }

  /** 双源录音：保存第二路音频（系统音频）到 secondary_audio_path */
  saveSecondaryAudio(params: VoiceSaveSecondaryAudioParams): VoiceTask | null {
    const task = this.getTask(params.taskId)
    if (!task) return null

    const ext = params.format === 'wav' ? 'wav' : 'webm'
    const fileName = `${params.taskId}_system.${ext}`
    const filePath = path.join(this.getVoiceDir(), fileName)

    const buffer = Buffer.from(params.audioData, 'base64')
    fs.writeFileSync(filePath, buffer)

    this.getDb().prepare(
      `UPDATE kms_voice_tasks SET secondary_audio_path = ?, updated_at = ? WHERE id = ?`
    ).run(filePath, Math.floor(Date.now() / 1000), params.taskId)

    return this.getTask(params.taskId)
  }

  // ==================== Transcribe ====================

  async transcribe(taskId: string, language?: string): Promise<VoiceTask | null> {
    const task = this.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!task.audio_path || !fs.existsSync(task.audio_path)) {
      throw new Error('Audio file not found')
    }

    const settings = this.getSettings()
    const isApi = settings.sttMode === 'api'
    const lang = language || (isApi ? settings.apiConfig.language : settings.localConfig.language) || 'zh'

    this.updateTask({ id: taskId, status: 'transcribing', errorMessage: undefined })

    const controller = new AbortController()
    this.transcribeAbortControllers.set(taskId, controller)

    try {
      let transcript = ''
      let segments: TranscriptSegment[] = []
      let detectedLang = lang

      if (isApi) {
        // API 模式：调用远程 Whisper 兼容 API
        this.notifyProgress(taskId, 'transcribing', '正在上传音频进行语音识别...', 10)

        const config = settings.apiConfig
        const formData = new FormData()
        const fileBuffer = fs.readFileSync(task.audio_path)
        const blob = new Blob([fileBuffer], { type: this.getMimeType(task.audio_format) })
        formData.append('file', blob, path.basename(task.audio_path))
        formData.append('model', config.model)
        if (lang) formData.append('language', lang)
        formData.append('response_format', 'verbose_json')

        const headers: Record<string, string> = {}
        if (config.apiKey) {
          headers['Authorization'] = `Bearer ${config.apiKey}`
        }

        const timeout = setTimeout(() => controller.abort(), 300000)
        const response = await fetch(config.endpoint, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          const errText = await response.text()
          throw new Error(`STT API error (${response.status}): ${errText}`)
        }

        const data = await response.json() as any
        this.notifyProgress(taskId, 'transcribing', '正在处理识别结果...', 90)

        if (data.text) transcript = data.text
        if (data.segments && Array.isArray(data.segments)) {
          segments = data.segments.map((s: any) => ({
            start: s.start || 0,
            end: s.end || 0,
            text: s.text || '',
          }))
          if (!transcript) transcript = segments.map(s => s.text).join('').trim()
        }
        if (data.language) detectedLang = data.language
      } else {
        // 本地模式：使用内置流式 Zipformer 模型
        const localConfig = settings.localConfig

        this.notifyProgress(taskId, 'transcribing', '正在加载本地语音识别模型...', 5)

        const localSTT = LocalSTTService.getInstance()
        const status = localSTT.checkBuiltinModel()
        if (!status.available) {
          throw new Error(status.error || '内置模型不可用')
        }

        const result = await localSTT.transcribe(
          task.audio_path,
          { ...localConfig, language: lang },
          (progress, message) => {
            this.notifyProgress(taskId, 'transcribing', message, progress)
          },
          controller.signal,
        )

        transcript = result.text
        segments = result.segments
      }

      const sttModel = isApi ? settings.apiConfig.model : `local-${settings.localConfig.modelType}`

      const updated = this.updateTask({
        id: taskId,
        status: 'transcribed',
        transcript,
        transcriptSegmentsJson: JSON.stringify(segments),
        transcriptLanguage: detectedLang,
        sttMode: settings.sttMode,
        sttModel,
      })

      this.notifyProgress(taskId, 'done', '语音识别完成', 100)
      return updated
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message === 'Aborted') {
        this.updateTask({ id: taskId, status: 'recorded', errorMessage: '已取消识别' })
        this.notifyProgress(taskId, 'cancelled', '已取消', 0)
      } else {
        const msg = String(err?.message || err)
        logger.error('Transcribe failed:', msg)
        this.updateTask({ id: taskId, status: 'failed', errorMessage: msg })
        this.notifyProgress(taskId, 'error', `识别失败: ${msg}`, 0)
      }
      return this.getTask(taskId)
    } finally {
      this.transcribeAbortControllers.delete(taskId)
    }
  }

  cancelTranscribe(taskId: string): void {
    const controller = this.transcribeAbortControllers.get(taskId)
    if (controller) {
      controller.abort()
    }
  }

  // ==================== Generate Minutes ====================

  async generateMinutes(taskId: string, minutesType: string, customPrompt?: string): Promise<VoiceTask | null> {
    const task = this.getTask(taskId)
    if (!task) throw new Error('Task not found')
    if (!task.transcript) throw new Error('No transcript available')

    const settings = this.getSettings()
    if (!settings.minutesModel?.provider_id) {
      throw new Error('未配置会议纪要生成模型，请在设置中配置 LLM 模型')
    }

    const llmConfig = settings.minutesModel
    const provider = await createPiProvider(llmConfig.provider_id, llmConfig.model_id)
    if (!provider) {
      throw new Error('LLM Provider not found')
    }

    this.updateTask({ id: taskId, status: 'generating_minutes', errorMessage: undefined })

    const controller = new AbortController()
    this.minutesAbortControllers.set(taskId, controller)

    this.notifyProgress(taskId, 'generating_minutes', '正在准备会议纪要生成...', 10)

    try {
      const prompt = this.buildMinutesPrompt(minutesType, customPrompt)
      const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: this.formatTranscriptForLLM(task) },
      ]

      this.notifyProgress(taskId, 'generating_minutes', 'AI 正在分析转录文本...', 25)

      // 流式生成：每收到一个 chunk 即推送进度，progress 在 30~90 之间渐进
      let accumulated = ''
      await provider.chatStream(
        messages as LLMMessage[],
        [],
        {
          onChunk: (chunk: string) => {
            accumulated += chunk
            // 进度估算：基于累积字符数渐进推进，上限 90（剩余 10% 留给整理与入库）
            const estimated = Math.min(90, 30 + accumulated.length / 50)
            this.notifyProgress(
              taskId,
              'generating_minutes',
              '正在生成纪要内容...',
              Math.round(estimated),
              chunk,
              accumulated,
            )
          },
          onThought: () => { /* 纪要生成不展示思考过程 */ },
          onToolCall: () => { /* 纪要生成不使用工具 */ },
        },
        controller.signal,
        { temperature: 0.3, maxTokens: 4096, logSource: 'voice-minutes' },
      )

      // 流式结束，标记进度 95 等待最终入库
      this.notifyProgress(taskId, 'generating_minutes', '正在整理纪要内容...', 95, undefined, accumulated)

      const finalText = accumulated.trim()
      if (!finalText) {
        throw new Error('AI 未返回任何内容')
      }

      const updated = this.updateTask({
        id: taskId,
        status: 'completed',
        minutes: finalText,
        minutesType,
      })

      this.notifyProgress(taskId, 'done', '会议纪要生成完成', 100, undefined, finalText)
      return updated
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.updateTask({ id: taskId, status: 'transcribed', errorMessage: '已取消生成' })
        this.notifyProgress(taskId, 'cancelled', '已取消', 0)
      } else {
        const msg = String(err?.message || err)
        logger.error('Generate minutes failed:', msg)
        this.updateTask({ id: taskId, status: 'transcribed', errorMessage: msg })
        this.notifyProgress(taskId, 'error', `纪要生成失败: ${msg}`, 0)
      }
      return this.getTask(taskId)
    } finally {
      this.minutesAbortControllers.delete(taskId)
    }
  }

  cancelMinutes(taskId: string): void {
    const controller = this.minutesAbortControllers.get(taskId)
    if (controller) {
      controller.abort()
    }
  }

  // ==================== Helpers ====================

  private getMimeType(format: string): string {
    switch (format) {
      case 'wav': return 'audio/wav'
      case 'mp3': return 'audio/mpeg'
      case 'm4a': return 'audio/mp4'
      case 'ogg': return 'audio/ogg'
      default: return 'audio/webm'
    }
  }

  private buildMinutesPrompt(minutesType: string, customPrompt?: string): string {
    const correctionNote = `重要：以下转录文本由语音识别引擎自动生成，可能存在同音字错误、标点缺失、专有名词识别偏差等问题。请在生成内容时先对转录文本进行理解和纠错，确保输出内容的准确性和可读性。`

    if (customPrompt) {
      return `你是一位专业的会议纪要助手。请根据以下会议录音转录文本，按照用户要求生成内容。\n\n${correctionNote}\n\n用户要求：${customPrompt}\n\n请使用 Markdown 格式输出。`
    }

    switch (minutesType) {
      case 'meeting_minutes':
        return `你是一位专业的会议纪要助手。请根据以下会议录音转录文本，生成结构化的会议纪要。

${correctionNote}

输出格式（Markdown）：
## 会议纪要

### 一、会议概要
（简要概述会议目的和主要内容，2-3句话）

### 二、讨论要点
（列出主要讨论话题及关键观点，使用要点列表）

### 三、决议事项
（列出会议达成的决定和共识）

### 四、待办事项
（列出需要跟进的任务，标注负责人如转录文本中提及）

### 五、其他备注
（如有补充信息）

注意：
- 如果转录文本中信息不明确，用"（未明确）"标注
- 保持客观，不要添加转录文本中未提及的内容
- 使用中文输出`
      case 'summary':
        return `你是一位专业的会议内容总结助手。请根据以下会议录音转录文本，生成一份简洁的内容摘要。

${correctionNote}

要求：
- 用 3-5 段话概括会议核心内容
- 突出重点议题和关键结论
- 使用 Markdown 格式
- 使用中文输出`
      case 'action_items':
        return `你是一位专业的会议任务提取助手。请从以下会议录音转录文本中，提取所有待办事项和行动项。

${correctionNote}

输出格式（Markdown）：
## 待办事项清单

| 序号 | 任务描述 | 负责人 | 截止时间 | 备注 |
|------|---------|--------|---------|------|
| 1    | ...     | ...    | ...     | ... |

注意：
- 只提取明确的行动项，不要推测
- 如果负责人或时间未提及，标注"未明确"
- 使用中文输出`
      default:
        return `请根据以下会议录音转录文本，按照用户要求生成内容。\n\n${correctionNote}\n\n使用 Markdown 格式输出，使用中文。`
    }
  }

  private formatTranscriptForLLM(task: VoiceTask): string {
    let segments: TranscriptSegment[] = []
    try {
      segments = JSON.parse(task.transcript_segments_json || '[]')
    } catch { /* ignore */ }

    if (segments.length > 0) {
      const lines = segments.map(s => {
        const start = this.formatTime(s.start)
        const end = this.formatTime(s.end)
        return `[${start} - ${end}] ${s.text}`
      })
      return `会议标题：${task.title}\n录音时长：${this.formatTime(task.duration)}\n\n转录文本（带时间戳）：\n${lines.join('\n')}`
    }

    return `会议标题：${task.title}\n录音时长：${this.formatTime(task.duration)}\n\n转录文本：\n${task.transcript}`
  }

  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }
    return `${m}:${String(s).padStart(2, '0')}`
  }

  private notifyProgress(taskId: string, phase: string, message: string, progress?: number, chunk?: string, accumulated?: string): void {
    const data: VoiceProgress = { taskId, phase, message, progress, chunk, accumulated }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.VOICE_PROGRESS, data)
        }
      } catch { /* ignore */ }
    }
  }

  // ==================== 实时识别（边录音边识别） ====================

  private realtimeTaskIds: Set<string> = new Set()
  /** 双源录音：临时存储各来源的转录结果（taskId → TranscriptResult） */
  private dualSourceTranscripts: Map<string, { text: string; segments: TranscriptSegment[] }> = new Map()
  /** 待处理的实时音频块队列（taskId → 音频块），避免同步推理阻塞主进程事件循环 */
  private realtimeQueues: Map<string, { samples: Float32Array; sampleRate: number; source?: string }[]> = new Map()
  /** 正在异步处理中的任务（避免重复启动处理循环） */
  private realtimeProcessing: Set<string> = new Set()

  /** 开始实时识别 */
  startRealtime(taskId: string, language?: string): { ok: boolean; error?: string } {
    const settings = this.getSettings()
    if (settings.sttMode !== 'local') {
      return { ok: false, error: '实时识别仅支持本地模式，请在设置中切换为本地识别' }
    }

    const localConfig = settings.localConfig
    const localSTT = LocalSTTService.getInstance()
    const status = localSTT.checkBuiltinModel()
    if (!status.available) {
      return { ok: false, error: status.error || '内置模型不可用' }
    }

    const lang = language || localConfig.language || 'zh'
    const result = localSTT.startRealtimeRecognize(taskId, { ...localConfig, language: lang })
    if (result.ok) {
      this.realtimeTaskIds.add(taskId)
      logger.info(`Realtime recognition started: taskId=${taskId}`)
    }
    return result
  }

  /** 喂入音频块：入队并异步处理，推送实时结果到前端 */
  feedRealtimeAudio(taskId: string, samples: Float32Array, sampleRate: number, source?: string): void {
    if (!this.realtimeTaskIds.has(taskId)) return

    let queue = this.realtimeQueues.get(taskId)
    if (!queue) {
      queue = []
      this.realtimeQueues.set(taskId, queue)
    }
    // 安全阀：CPU 处理跟不上时丢弃最旧的音频块，防止队列无限增长导致内存膨胀
    if (queue.length >= 200) {
      queue.shift()
    }
    queue.push({ samples, sampleRate, source })

    this.processRealtimeQueue(taskId)
  }

  /** 异步处理实时识别队列：每处理一块音频即让出事件循环，避免同步推理阻塞主进程导致 UI/IPC 卡顿 */
  private processRealtimeQueue(taskId: string): void {
    if (this.realtimeProcessing.has(taskId)) return
    this.realtimeProcessing.add(taskId)

    const localSTT = LocalSTTService.getInstance()
    const run = async () => {
      try {
        while (this.realtimeTaskIds.has(taskId)) {
          const queue = this.realtimeQueues.get(taskId)
          if (!queue || queue.length === 0) break
          const item = queue.shift()!
          const result = localSTT.feedAudioChunk(taskId, item.samples, item.sampleRate)
          this.pushRealtimeResult(taskId, result, item.source)
          // 让出事件循环，保证主进程能及时处理导航/IPC 等消息
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      } catch (err: any) {
        logger.error(`Realtime feed processing error: ${taskId}`, err?.message || err)
      } finally {
        this.realtimeProcessing.delete(taskId)
      }
    }
    run()
  }

  /** 推送实时识别结果到前端与悬浮字幕窗口 */
  private pushRealtimeResult(taskId: string, result: { text: string; partialText: string; segment?: { start: number; end: number; text: string }; isEndpoint: boolean }, source?: string): void {
    const realtimeResult = {
      taskId,
      text: result.text,
      source,
      segment: result.segment,
      isFinal: false,
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.VOICE_REALTIME_RESULT, realtimeResult)
        }
      } catch { /* ignore */ }
    }

    // 推送到悬浮字幕窗口（仅当前正在识别的语句）
    SubtitleWindowService.getInstance().updateText(result.partialText, source as 'mic' | 'system' | undefined)
  }

  /** 停止实时识别，保存结果到任务 */
  stopRealtime(taskId: string): VoiceTask | null {
    if (!this.realtimeTaskIds.has(taskId)) {
      return this.getTask(taskId)
    }

    this.realtimeTaskIds.delete(taskId)
    this.realtimeProcessing.delete(taskId)

    // 停止前先同步清空待处理队列，避免末尾音频块未被识别（按顺序喂入保持流连贯）
    const localSTT = LocalSTTService.getInstance()
    const pendingQueue = this.realtimeQueues.get(taskId)
    if (pendingQueue) {
      for (const item of pendingQueue) {
        localSTT.feedAudioChunk(taskId, item.samples, item.sampleRate)
      }
      this.realtimeQueues.delete(taskId)
    }

    const settings = this.getSettings()
    const transcript = localSTT.stopRealtimeRecognize(taskId)

    // 双源录音：suffixed taskId（__mic / __system）没有对应任务记录，
    // 将转录结果暂存到 dualSourceTranscripts，由 mergeDualSourceTranscript 合并写入主任务
    const isDualSourceSuffix = taskId.endsWith('__mic') || taskId.endsWith('__system')
    if (isDualSourceSuffix) {
      this.dualSourceTranscripts.set(taskId, transcript)

      // 推送最终结果
      const realtimeResult = {
        taskId,
        text: transcript.text,
        isFinal: true,
      }
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC_CHANNELS.VOICE_REALTIME_RESULT, realtimeResult)
          }
        } catch { /* ignore */ }
      }
      // 不清空悬浮字幕（由 mergeDualSourceTranscript 统一处理）
      return null
    }

    const sttModel = `local-${settings.localConfig.modelType}`
    const updated = this.updateTask({
      id: taskId,
      status: 'transcribed',
      transcript: transcript.text,
      transcriptSegmentsJson: JSON.stringify(transcript.segments),
      transcriptLanguage: settings.localConfig.language || 'zh',
      sttMode: 'local',
      sttModel,
    })

    // 推送最终结果
    const realtimeResult = {
      taskId,
      text: transcript.text,
      isFinal: true,
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.VOICE_REALTIME_RESULT, realtimeResult)
        }
      } catch { /* ignore */ }
    }

    this.notifyProgress(taskId, 'done', '实时识别完成', 100)

    // 清空悬浮字幕
    SubtitleWindowService.getInstance().updateText('', 'mic')
    SubtitleWindowService.getInstance().updateText('', 'system')

    return updated
  }

  /** 双源录音：合并 mic + system 转录文本，按时间排序写入主任务 */
  mergeDualSourceTranscript(params: VoiceMergeDualTranscriptParams): VoiceTask | null {
    const micResult = this.dualSourceTranscripts.get(params.micTaskId)
    const systemResult = this.dualSourceTranscripts.get(params.systemTaskId)

    const settings = this.getSettings()
    const sttModel = `local-${settings.localConfig.modelType}`

    // 合并 segments 并按 start 时间排序，标注来源
    const segments: TranscriptSegment[] = []
    if (micResult) {
      for (const seg of micResult.segments) {
        segments.push({ start: seg.start, end: seg.end, text: `🎤 ${seg.text}` })
      }
    }
    if (systemResult) {
      for (const seg of systemResult.segments) {
        segments.push({ start: seg.start, end: seg.end, text: `🔊 ${seg.text}` })
      }
    }
    segments.sort((a, b) => a.start - b.start)

    // 合并全文：按时间排序拼接
    const mergedText = segments.map(s => s.text).join('\n')

    const updated = this.updateTask({
      id: params.mainTaskId,
      status: 'transcribed',
      transcript: mergedText,
      transcriptSegmentsJson: JSON.stringify(segments),
      transcriptLanguage: settings.localConfig.language || 'zh',
      sttMode: 'local',
      sttModel,
    })

    // 推送最终合并结果
    const realtimeResult = {
      taskId: params.mainTaskId,
      text: mergedText,
      isFinal: true,
    }
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.VOICE_REALTIME_RESULT, realtimeResult)
        }
      } catch { /* ignore */ }
    }

    this.notifyProgress(params.mainTaskId, 'done', '实时识别完成', 100)

    // 清理临时存储
    this.dualSourceTranscripts.delete(params.micTaskId)
    this.dualSourceTranscripts.delete(params.systemTaskId)

    // 清空悬浮字幕
    SubtitleWindowService.getInstance().updateText('', 'mic')
    SubtitleWindowService.getInstance().updateText('', 'system')

    return updated
  }

  /** 取消实时识别 */
  cancelRealtime(taskId: string): void {
    if (!this.realtimeTaskIds.has(taskId)) return
    this.realtimeTaskIds.delete(taskId)
    this.realtimeProcessing.delete(taskId)
    this.realtimeQueues.delete(taskId)
    LocalSTTService.getInstance().cancelRealtimeRecognize(taskId)
    this.dualSourceTranscripts.delete(taskId)
    logger.info(`Realtime recognition cancelled: taskId=${taskId}`)

    // 清空悬浮字幕
    SubtitleWindowService.getInstance().updateText('', 'mic')
    SubtitleWindowService.getInstance().updateText('', 'system')
  }
}

export default VoiceService
