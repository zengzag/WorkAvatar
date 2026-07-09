import fs from 'fs'
import path from 'path'
import { isMainThread, workerData } from 'worker_threads'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LOG_PREFIXES: Record<string, string> = {
  DB: '[DB]',
  KB: '[KB]',
  'KB-DB': '[KB-DB]',
  Agent: '[Agent]',
  AgentEvent: '[AgentEvent]',
  TaskQueue: '[TaskQueue]',
  OCR: '[OCR]',
  LLM: '[LLM]',
  Export: '[Export]',
  Search: '[Search]',
  InternetSearch: '[InternetSearch]',
}

/**
 * 应用日志后端：把所有 debug/info/warn/error 日志同步写入文件，便于 release 包排查问题。
 *
 * - 每次主进程启动新建一个以时间命名的日志文件：{dataDir}/.log/app/app-YYYY-MM-DD-HHmmss.log
 * - Worker 线程复用主进程通过 workerData.logFilePath 传入的同一文件，避免多进程文件碎片
 * - 启动时清理 14 天前的旧日志，控制磁盘占用
 * - 同时输出到控制台（dev 终端可见），保证开发体验
 */
class LoggerBackend {
  private static instance: LoggerBackend
  private stream: fs.WriteStream | null = null
  private logFilePath: string | null = null
  private initialized = false
  private readonly MAX_LOG_AGE_DAYS = 14
  private readonly APP_LOG_SUBDIR = path.join('.log', 'app')

  private constructor() {}

  static getInstance(): LoggerBackend {
    if (!LoggerBackend.instance) {
      LoggerBackend.instance = new LoggerBackend()
    }
    return LoggerBackend.instance
  }

  /**
   * 初始化日志文件。主进程在启动早期调用一次。
   * Worker 线程通过 workerData.logFilePath 复用主进程的日志文件。
   */
  init(dataDir?: string): void {
    if (this.initialized) return

    try {
      // Worker 模式：优先使用主线程传入的 logFilePath
      if (!isMainThread && (workerData as any)?.logFilePath) {
        this.logFilePath = (workerData as any).logFilePath as string
      } else if (dataDir) {
        const logDir = path.join(dataDir, this.APP_LOG_SUBDIR)
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true })
        }
        const ts = formatTimestamp(new Date())
        this.logFilePath = path.join(logDir, `app-${ts}.log`)
        this.cleanOldLogs(logDir)
      }

      if (this.logFilePath) {
        const dir = path.dirname(this.logFilePath)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        this.stream = fs.createWriteStream(this.logFilePath, { flags: 'a', encoding: 'utf-8' })
        this.stream.on('error', () => {
          this.stream = null
        })
      }
    } catch {
      // 日志初始化失败不应阻断启动，降级为仅控制台输出
      this.stream = null
    }

    this.initialized = true
  }

  /** 返回当前日志文件路径，供 Worker 客户端透传给子线程 */
  getLogFilePath(): string | null {
    return this.logFilePath
  }

  /**
   * 仅写入文件（不输出控制台）。用于渲染进程转发的日志：
   * 渲染进程自身的 console 已在 devtools 显示，主进程无需再次打印。
   */
  writeToFile(level: LogLevel, module: string, message: string): void {
    if (!this.initialized) {
      this.initLazy()
    }
    if (!this.stream || this.stream.destroyed) return
    const prefix = LOG_PREFIXES[module] || `[${module}]`
    const time = formatTime(new Date())
    const line = `[${time}] ${prefix} [${level.toUpperCase()}] ${message}\n`
    try {
      this.stream.write(line)
    } catch {}
  }

  write(level: LogLevel, module: string, message: string, args: any[]): void {
    if (!this.initialized) {
      // 延迟初始化：未显式 init 时尝试用 PathService 的 dataDir
      this.initLazy()
    }

    const prefix = LOG_PREFIXES[module] || `[${module}]`
    const time = formatTime(new Date())
    const argStr = args.length > 0 ? ' ' + args.map(safeStringify).join(' ') : ''
    const line = `[${time}] ${prefix} [${level.toUpperCase()}] ${message}${argStr}\n`

    // 控制台输出（dev 可见，prod 无害）
    if (level === 'warn') {
      console.warn(`${prefix} [${level.toUpperCase()}] ${message}`, ...args)
    } else if (level === 'error') {
      console.error(`${prefix} [${level.toUpperCase()}] ${message}`, ...args)
    } else {
      console.log(`${prefix} [${level.toUpperCase()}] ${message}`, ...args)
    }

    // 文件写入
    if (this.stream && !this.stream.destroyed) {
      try {
        this.stream.write(line)
      } catch {
        // 忽略写入失败
      }
    }
  }

  /** 刷新并关闭日志流，应用退出时调用 */
  destroy(): void {
    if (this.stream) {
      try {
        this.stream.end()
      } catch {}
      this.stream = null
    }
  }

  private initLazy(): void {
    try {
      // 避免在 PathService 尚未可用时崩溃；worker 模式下直接用 workerData
      if (!isMainThread && (workerData as any)?.dataDir) {
        this.init((workerData as any).dataDir as string)
        return
      }
      // 主线程：用 PathService 获取 dataDir
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PathService = require('./path.service').default
      this.init(PathService.getInstance().getDataDir())
    } catch {
      this.initialized = true
    }
  }

  /** 清理超过 MAX_LOG_AGE_DAYS 天的旧日志文件 */
  private cleanOldLogs(logDir: string): void {
    try {
      if (!fs.existsSync(logDir)) return
      const files = fs.readdirSync(logDir)
      const now = Date.now()
      const maxAgeMs = this.MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000
      for (const file of files) {
        if (!file.endsWith('.log')) continue
        const fullPath = path.join(logDir, file)
        try {
          const stat = fs.statSync(fullPath)
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.unlinkSync(fullPath)
          }
        } catch {}
      }
    } catch {}
  }
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

function formatTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function formatTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

function safeStringify(value: any): string {
  if (value == null) return String(value)
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  debug(message: string, ...args: any[]) {
    LoggerBackend.getInstance().write('debug', this.module, message, args)
  }

  info(message: string, ...args: any[]) {
    LoggerBackend.getInstance().write('info', this.module, message, args)
  }

  warn(message: string, ...args: any[]) {
    LoggerBackend.getInstance().write('warn', this.module, message, args)
  }

  error(message: string, ...args: any[]) {
    LoggerBackend.getInstance().write('error', this.module, message, args)
  }
}

export function createLogger(module: string): Logger {
  return new Logger(module)
}

export { Logger, LoggerBackend }
