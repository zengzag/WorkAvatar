import fs from 'fs'
import path from 'path'
import PathService from './path.service'
import { generateId } from './common-utils'
import { AsyncLocalStorage } from 'async_hooks'
import { createLogger } from './logger'

const logger = createLogger('LLMLogger')

export interface LLMLogContext {
  employeeId?: string
  employeeName?: string
  conversationId?: string
  source?: string
}

export interface LLMLogEntry {
  id: string
  timestamp: string
  type: 'chat' | 'chatStream' | 'embedding'
  source: string
  model: string
  providerType?: string
  request: {
    messages: any[]
    tools?: any[]
    temperature?: number
    max_tokens?: number
    stream: boolean
  }
  response?: {
    content?: string
    reasoningContent?: string
    toolCalls?: any[]
    finishReason?: string
    usage?: {
      promptTokens?: number
      completionTokens?: number
      totalTokens?: number
    }
    latencyMs?: number
  }
  error?: string
  context?: LLMLogContext
}

const contextStorage = new AsyncLocalStorage<LLMLogContext>()

class LLMLoggerService {
  private static instance: LLMLoggerService
  private openFiles: Map<string, { stream: fs.WriteStream; lastWriteAt: number }> = new Map()
  private flushTimer: NodeJS.Timeout | null = null
  private suspended = false
  private static readonly IDLE_THRESHOLD_MS = 60_000

  private constructor() {
    this.flushTimer = setInterval(() => this.closeIdleStreams(), 30_000)
  }

  static getInstance(): LLMLoggerService {
    if (!LLMLoggerService.instance) {
      LLMLoggerService.instance = new LLMLoggerService()
    }
    return LLMLoggerService.instance
  }

  runWithContext<T>(ctx: LLMLogContext, fn: () => T): T {
    return contextStorage.run(ctx, fn)
  }

  getCurrentContext(): LLMLogContext | undefined {
    return contextStorage.getStore()
  }

  logCall(partial: Omit<LLMLogEntry, 'id' | 'timestamp' | 'context'>, explicitContext?: LLMLogContext): void {
    if (this.suspended) return
    try {
      const ctx = explicitContext || this.getCurrentContext()
      const entry: LLMLogEntry = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        context: ctx,
        ...partial,
      }

      const filePath = this.resolveLogFilePath(entry)
      this.writeEntry(filePath, entry)
    } catch (error) {
      logger.warn('Failed to write LLM log entry', error)
    }
  }

  private resolveLogFilePath(entry: LLMLogEntry): string {
    const dataDir = PathService.getInstance().getDataDir()
    const logBase = path.join(dataDir, '.log', 'llm')

    const dateStr = entry.timestamp.substring(0, 10)

    if (entry.context?.employeeName && entry.context?.conversationId) {
      const safeName = this.sanitizeFileName(entry.context.employeeName)
      const safeConvId = this.sanitizeFileName(entry.context.conversationId)
      return path.join(logBase, dateStr, safeName, `${safeConvId}.jsonl`)
    }

    return path.join(logBase, dateStr, '_system.jsonl')
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 100)
  }

  private writeEntry(filePath: string, entry: LLMLogEntry): void {
    const existing = this.openFiles.get(filePath)
    let stream = existing?.stream

    if (!stream || stream.destroyed) {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
      stream.on('error', () => {
        this.openFiles.delete(filePath)
      })
    }

    const line = JSON.stringify(entry) + '\n'
    stream.write(line)
    this.openFiles.set(filePath, { stream, lastWriteAt: Date.now() })
  }

  private closeIdleStreams(): void {
    const now = Date.now()
    for (const [filePath, { stream, lastWriteAt }] of this.openFiles.entries()) {
      if (stream.destroyed) {
        this.openFiles.delete(filePath)
        continue
      }
      if (now - lastWriteAt > LLMLoggerService.IDLE_THRESHOLD_MS) {
        stream.end()
        this.openFiles.delete(filePath)
      }
    }
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    for (const [, { stream }] of this.openFiles.entries()) {
      stream.end()
    }
    this.openFiles.clear()
  }

  /** 暂停写入并关闭全部文件流，等待句柄释放（清空日志前调用），清理完成后调用 resume */
  async closeStreams(): Promise<void> {
    this.suspended = true
    const streams = Array.from(this.openFiles.values(), (v) => v.stream)
    this.openFiles.clear()
    await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
      if (stream.destroyed) return resolve()
      stream.once('close', () => resolve())
      stream.once('error', () => resolve())
      try {
        stream.end()
      } catch {
        resolve()
      }
    })))
  }

  /** 恢复写入（清空日志后调用），后续写入会自动重建文件流 */
  resume(): void {
    this.suspended = false
  }
}

export default LLMLoggerService
