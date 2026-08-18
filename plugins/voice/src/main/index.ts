/**
 * voice 内置插件主进程入口。
 * 由宿主 VoiceService / LocalSTTService / SubtitleWindowService 迁移而来（保持全部功能）：
 * - 迁移：把内核 KMS 向量库的 kms_voice_tasks 数据与 voice_settings 设置迁入插件分库
 * - IPC 经 ctx.ipc.handle 注册（插件桥路由 plugin:voice:<channel>），广播经 ctx.ipc.broadcast 推送
 * - 语音任务/录音文件数据完全自包含于插件分库与宿主 dataDir/voice
 */
import { desktopCapturer, dialog } from 'electron'
import type { PluginContext, PluginMigrationContext } from '../../../plugin-sdk/src'
import VoiceService from './voice-service'
import LocalSTTService from './local-stt'
import SubtitleWindowService from './subtitle-window'
import type { VoiceSubtitleConfig } from './subtitle-window'
import type {
  VoiceCreateTaskParams,
  VoiceUpdateTaskParams,
  VoiceSettings,
} from './voice-service'

// ====== 迁移：把内核主库的语音数据迁入插件分库 ======

const VOICE_TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS kms_voice_tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'created',
    audio_path TEXT,
    audio_format TEXT DEFAULT 'webm',
    duration INTEGER DEFAULT 0,
    audio_size INTEGER DEFAULT 0,
    audio_channels INTEGER DEFAULT 0,
    sample_rate INTEGER DEFAULT 0,
    transcript TEXT DEFAULT '',
    transcript_segments_json TEXT DEFAULT '[]',
    transcript_language TEXT DEFAULT '',
    minutes TEXT DEFAULT '',
    minutes_type TEXT DEFAULT '',
    error_message TEXT,
    stt_mode TEXT DEFAULT '',
    stt_model TEXT DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    recorded_at INTEGER,
    secondary_audio_path TEXT,
    notes TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_kms_voice_tasks_status ON kms_voice_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_kms_voice_tasks_created ON kms_voice_tasks(created_at DESC);
`

const VOICE_TASK_COLUMNS = [
  'id', 'title', 'description', 'status', 'audio_path', 'audio_format', 'duration',
  'audio_size', 'audio_channels', 'sample_rate', 'transcript', 'transcript_segments_json',
  'transcript_language', 'minutes', 'minutes_type', 'error_message', 'stt_mode', 'stt_model',
  'created_at', 'updated_at', 'recorded_at', 'secondary_audio_path', 'notes',
] as const

/** 迁移时若源表缺失某列（未走宿主 ALTER 迁移的旧库），回退到建表默认值 */
const VOICE_TASK_COLUMN_DEFAULTS: Record<string, unknown> = {
  title: '', description: '', status: 'created', audio_format: 'webm',
  duration: 0, audio_size: 0, audio_channels: 0, sample_rate: 0,
  transcript: '', transcript_segments_json: '[]', transcript_language: '',
  minutes: '', minutes_type: '', stt_mode: '', stt_model: '',
  notes: '',
}

const _migrations = [
  {
    version: '1-migrate-voice-data',
    description: '迁移语音任务与设置从内核主库到插件分库',
    run(mig: PluginMigrationContext) {
      const db = mig.storage.openSqlite('index')
      db.exec('CREATE TABLE IF NOT EXISTS plugin_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.exec(VOICE_TASKS_DDL)
      if (!mig.legacy) return

      const migrate = db.transaction(() => {
        // 拷贝 kms_voice_tasks 全部行（表位于内核 KMS 向量库，经 legacy.kms 只读访问；库不存在则跳过）
        try {
          const kms = mig.legacy.kms
          if (!kms) {
            mig.logger.info('KMS 向量库不可读，跳过语音任务迁移')
          } else {
            const tables = kms.listTables()
            if (tables.includes('kms_voice_tasks')) {
              const rows = kms.all('SELECT * FROM kms_voice_tasks') as Record<string, unknown>[]
              if (rows.length > 0) {
                const cols = VOICE_TASK_COLUMNS
                const placeholders = cols.map(() => '?').join(', ')
                const insert = db.prepare(
                  `INSERT OR IGNORE INTO kms_voice_tasks (${cols.join(', ')}) VALUES (${placeholders})`
                )
                for (const r of rows) {
                  const values = cols.map(c => {
                    const v = r[c]
                    if (v !== undefined && v !== null) return v
                    return c in VOICE_TASK_COLUMN_DEFAULTS ? VOICE_TASK_COLUMN_DEFAULTS[c] : null
                  })
                  insert.run(...values)
                }
              }
              mig.logger.info(`语音任务已迁移到插件分库: ${rows.length} 条`)
            } else {
              mig.logger.info('KMS 向量库无 kms_voice_tasks 表，跳过任务迁移')
            }
          }
        } catch (err: any) {
          mig.logger.warn('语音任务迁移失败（忽略，使用空数据）:', err?.message || err)
        }

        // 拷贝 voice_settings 设置到 plugin_kv
        try {
          const raw = mig.legacy.getSetting('voice_settings') as string | undefined
          if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
            db.prepare(
              'INSERT INTO plugin_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
            ).run('voice_settings', JSON.stringify(parsed))
            mig.logger.info('voice_settings 已从内核主库迁移到插件分库')
          }
        } catch (err: any) {
          mig.logger.warn('voice_settings 迁移失败（忽略，使用默认设置）:', err?.message || err)
        }
      })
      migrate()

      // 行数校验
      try {
        const count = (db.prepare('SELECT COUNT(*) AS n FROM kms_voice_tasks').get() as { n: number }).n
        mig.logger.info(`插件分库 kms_voice_tasks 校验: ${count} 行`)
      } catch { /* ignore */ }
    },
  },
]

// ====== 激活 ======

let voiceService: VoiceService | null = null
let localSTT: LocalSTTService | null = null
let subtitleWindow: SubtitleWindowService | null = null

export const migrations = _migrations

export function activate(ctx: PluginContext): void {
  localSTT = LocalSTTService.getInstance(ctx)
  subtitleWindow = SubtitleWindowService.getInstance(ctx)
  voiceService = VoiceService.getInstance(ctx)
  registerIpc(ctx)
  ctx.services.logger.info('voice 插件激活完成')
}

export function deactivate(): void {
  if (subtitleWindow) {
    subtitleWindow.destroy()
    subtitleWindow = null
  }
  if (localSTT) {
    localSTT.dispose()
    localSTT = null
  }
  voiceService = null
}

function registerIpc(ctx: PluginContext): void {
  if (!voiceService) return
  const s = voiceService
  const sub = () => subtitleWindow

  // ==================== 任务管理 ====================
  ctx.ipc.handle('list-tasks', () => s.listTasks())

  ctx.ipc.handle('get-task', (id: string) => s.getTask(id))

  ctx.ipc.handle('create-task', (params: VoiceCreateTaskParams) => {
    return s.createTask(params || {})
  })

  ctx.ipc.handle('update-task', (params: VoiceUpdateTaskParams) => {
    return s.updateTask(params || {})
  })

  ctx.ipc.handle('delete-task', (id: string) => {
    s.deleteTask(id)
    return { success: true }
  })

  // ==================== 音频保存 ====================
  ctx.ipc.handle('save-audio', (params: {
    taskId: string
    audioData: string
    format: string
    duration: number
    sampleRate: number
    channels: number
  }) => {
    return s.saveAudio(
      params.taskId,
      params.audioData,
      params.format,
      params.duration,
      params.sampleRate,
      params.channels,
    )
  })

  // 双源录音：保存第二路音频（系统音频）
  ctx.ipc.handle('save-secondary-audio', (params: { taskId: string; audioData: string; format: string }) => {
    return s.saveSecondaryAudio(params)
  })

  // 双源录音：合并 mic + system 转录文本到主任务
  ctx.ipc.handle('merge-dual-transcript', (params: { mainTaskId: string; micTaskId: string; systemTaskId: string }) => {
    return s.mergeDualSourceTranscript(params)
  })

  // ==================== 语音识别 ====================
  // 长任务：voiceService 内部已用 AbortController + 异步并发，进度经 broadcast 推送，
  // ctx.ipc.handle 等待其 resolve 即保持原语义（与宿主 fire-and-forget 模式一致）。
  ctx.ipc.handle('transcribe', async (params: { taskId: string; language?: string }) => {
    try {
      const result = await s.transcribe(params.taskId, params.language)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      ctx.services.logger.error(`IPC handler error [voice:transcribe]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('cancel-transcribe', (taskId: string) => {
    s.cancelTranscribe(taskId)
    return { success: true }
  })

  // ==================== 会议纪要生成 ====================
  ctx.ipc.handle('generate-minutes', async (params: { taskId: string; minutesType: string; customPrompt?: string }) => {
    try {
      const result = await s.generateMinutes(params.taskId, params.minutesType, params.customPrompt)
      try { return structuredClone(result) } catch { return JSON.parse(JSON.stringify(result)) }
    } catch (err: any) {
      ctx.services.logger.error(`IPC handler error [voice:generate-minutes]:`, err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('cancel-minutes', (taskId: string) => {
    s.cancelMinutes(taskId)
    return { success: true }
  })

  // ==================== 设置 ====================
  ctx.ipc.handle('get-settings', () => s.getSettings())

  ctx.ipc.handle('set-settings', (settings: VoiceSettings) => {
    s.setSettings(settings)
    return { success: true }
  })

  // ==================== 系统音频源 ====================
  ctx.ipc.handle('get-audio-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: false,
    })
    return sources.map(so => ({
      id: so.id,
      name: so.name,
      display_id: so.display_id,
    }))
  })

  // ==================== 本地模型状态检查 ====================
  ctx.ipc.handle('check-local-model', () => s.checkLocalModel())

  // ==================== 选择目录对话框 ====================
  ctx.ipc.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // ==================== 实时识别（边录音边识别） ====================
  ctx.ipc.handle('realtime-start', (params: { taskId: string; language?: string }) => {
    return s.startRealtime(params.taskId, params.language)
  })

  // feed 高频调用，快速返回（Float32Array 转换后入队异步处理）
  ctx.ipc.handle('realtime-feed', (params: { taskId: string; samples: ArrayBuffer; sampleRate: number; source?: string }) => {
    try {
      const samples = new Float32Array(params.samples)
      s.feedRealtimeAudio(params.taskId, samples, params.sampleRate, params.source)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('realtime-stop', (taskId: string) => {
    try {
      return s.stopRealtime(taskId)
    } catch (err: any) {
      ctx.services.logger.error('Realtime stop error:', err?.message || err)
      return { error: String(err?.message || err) }
    }
  })

  ctx.ipc.handle('realtime-cancel', (taskId: string) => {
    s.cancelRealtime(taskId)
    return { success: true }
  })

  // ==================== 悬浮字幕窗口 ====================
  ctx.ipc.handle('subtitle-show', (config?: VoiceSubtitleConfig) => {
    sub()?.show(config)
    return { success: true }
  })

  ctx.ipc.handle('subtitle-hide', () => {
    sub()?.hide()
    return { success: true }
  })

  ctx.ipc.handle('subtitle-toggle', () => {
    const visible = sub()?.toggle() ?? false
    return { visible }
  })

  ctx.ipc.handle('subtitle-get-visible', () => {
    return { visible: sub()?.isVisible() ?? false }
  })
}