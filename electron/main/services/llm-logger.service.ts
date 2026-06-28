import fs from 'fs'
import path from 'path'
import PathService from './path.service'
import { generateId } from './common-utils'
import { AsyncLocalStorage } from 'async_hooks'

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
  // 流空闲超过该阈值则关闭（毫秒）
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
    } catch {
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

  /**
   * 关闭空闲超过 IDLE_THRESHOLD_MS 的写入流。
   * 原实现仅移除已 ended/destroyed 的流，从未真正关闭空闲流，导致文件句柄泄漏。
   */
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
}

export default LLMLoggerService
