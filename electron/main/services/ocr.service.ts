import fs from 'fs'
import os from 'os'
import path from 'path'
import { fork, type ChildProcess } from 'child_process'
import { createLogger, LoggerBackend } from './logger'
import PathService from './path.service'
import mainUiI18n from './ui-i18n.service'

const logger = createLogger('OCR')

/**
 * OCR 服务：基于 PaddleOCR v6 tiny + onnxruntime-node 本地推理，运行在独立子进程中。
 *
 * 必须独立进程（而非 Worker 线程）运行，两点原因：
 *   1. 隔离 onnxruntime-native 原生崩溃，避免拖垮主进程
 *   2. 隔离 onnxruntime.dll：语音插件借用的 sherpa-onnx 自带同名 onnxruntime.dll，
 *      同一进程内 Windows 只会加载其中一份，后加载方会以
 *      "The operating system cannot run %1" 失败（仅当语音识别先于 OCR 使用时出现）
 *
 * 任何失败（子进程启动失败、初始化失败、识别失败、子进程崩溃）都会：
 *   1. 写入错误日志
 *   2. 弹窗提示用户
 *   3. 抛出错误由调用方处理
 */
interface OCROptions {
  language?: string
}

/** 传给 OCR 子进程的启动参数（经 argv JSON 传递） */
interface OcrWorkerConfig {
  dataDir: string
  isDev: boolean
  resourcesDir: string
  logFilePath: string | null
}

interface OCRBlock {
  text: string
  confidence: number
  bbox: {
    x0: number
    y0: number
    x1: number
    y1: number
  }
}

interface OCRResult {
  text: string
  confidence: number
  engine: string
  blocks?: OCRBlock[]
}

// ── Worker 消息类型 ────────────────────────────────────────────

interface WorkerInitMessage {
  type: 'init'
  id: string
}

interface WorkerRecognizeMessage {
  type: 'recognize'
  id: string
  imagePath: string
}

interface WorkerTerminateMessage {
  type: 'terminate'
  id: string
}

interface WorkerPingMessage {
  type: 'ping'
  id: string
}

type WorkerOutMessage = WorkerInitMessage | WorkerRecognizeMessage | WorkerTerminateMessage | WorkerPingMessage

interface WorkerResultMessage {
  type: 'result'
  id: string
  result?: any
}

interface WorkerErrorMessage {
  type: 'error'
  id: string
  error: string
}

interface WorkerReadyMessage {
  type: 'ready'
}

interface WorkerFatalMessage {
  type: 'fatal'
  error: string
}

interface WorkerPongMessage {
  type: 'pong'
  id: string
}

type WorkerInMessage = WorkerResultMessage | WorkerErrorMessage | WorkerReadyMessage | WorkerFatalMessage | WorkerPongMessage

// ── OCR Service ────────────────────────────────────────────────

/** OCR 引擎（ONNX 模型）常驻约数百 MB，空闲后回收，下次识别再按需拉起 */
const OCR_IDLE_TERMINATE_MS = 10 * 60 * 1000
const OCR_IDLE_CHECK_INTERVAL_MS = 60 * 1000

class OCRService {
  private static instance: OCRService
  private initPromise: Promise<void> | null = null

  private ocrWorker: ChildProcess | null = null
  private workerReady = false
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }>()
  private msgIdCounter = 0
  /** 排队中的识别任务数（含等待 Worker 初始化的任务） */
  private activeTasks = 0
  private lastUsedAt = 0
  private idleTimer: NodeJS.Timeout | null = null
  /** 回收中的 Worker：新请求需等回收完成后再重新初始化，避免与终止流程竞争 */
  private terminatePromise: Promise<void> | null = null

  /** 识别任务串行队列：同一时刻只跑一张图，避免并发推理争抢 CPU 拖慢彼此 */
  private taskQueue: Promise<unknown> = Promise.resolve()

  private constructor() {}

  static getInstance(): OCRService {
    if (!OCRService.instance) {
      OCRService.instance = new OCRService()
    }
    return OCRService.instance
  }

  /**
   * 初始化 PaddleOCR 引擎（在 Worker 线程中）。多次调用只初始化一次。
   * 失败时记录日志、弹窗报错并抛出。
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    const modelDir = this.getPaddleOcrModelDir()
    const detPath = path.join(modelDir, 'PP-OCRv6_tiny_det_infer.onnx')
    const recPath = path.join(modelDir, 'PP-OCRv6_tiny_rec_infer.onnx')
    const dictPath = path.join(modelDir, 'ppocrv6_tiny_dict.txt')

    if (!fs.existsSync(detPath) || !fs.existsSync(recPath) || !fs.existsSync(dictPath)) {
      const msg = mainUiI18n.t('ocrModelMissing')
      logger.error(msg, { detPath, recPath, dictPath })
      this.showError(mainUiI18n.t('ocrInitFailedTitle'), `${msg}\n${mainUiI18n.t('ocrPathLabel')}: ${modelDir}`)
      throw new Error(msg)
    }

    try {
      await this.spawnAndInitWorker()
      this.lastUsedAt = Date.now()
      this.startIdleTimer()
      logger.info('PaddleOCR v6 tiny engine initialized (Worker)')
    } catch (err) {
      const msg = mainUiI18n.t('ocrWorkerInitFailed')
      logger.error(msg, err)
      this.showError(mainUiI18n.t('ocrInitFailedTitle'), `${msg}\n${err instanceof Error ? err.message : String(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private getPaddleOcrModelDir(): string {
    const resourcesDir = PathService.getInstance().getResourcesDir()
    return path.join(resourcesDir, 'paddleocr', 'ppocr_v6_tiny')
  }

  // ── Worker 生命周期 ──────────────────────────────────────────

  private async spawnAndInitWorker(): Promise<void> {
    const workerPath = path.join(__dirname, 'ocr-worker.js')
    const pathService = PathService.getInstance()

    const workerConfig: OcrWorkerConfig = {
      dataDir: pathService.getDataDir(),
      isDev: pathService.getIsDev(),
      resourcesDir: pathService.getResourcesDir(),
      // 子进程复用主进程日志文件，避免多进程日志碎片
      logFilePath: LoggerBackend.getInstance().getLogFilePath(),
    }

    // 以 Electron 二进制充当 Node 运行时启动独立进程（生产环境无独立 node，
    // 且 app.asar 内的脚本依赖 Electron 的 asar 支持）
    const child = fork(workerPath, [JSON.stringify(workerConfig)], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // 不继承 --inspect 等参数，避免子进程抢占父进程的调试端口
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.ocrWorker = child

    // 子进程日志文件由其自身写入，这里只把输出转到父进程控制台（dev 可见）
    child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))

    this.ocrWorker.on('message', (msg: WorkerInMessage) => {
      this.handleWorkerMessage(msg)
    })

    this.ocrWorker.on('error', (err: Error) => {
      logger.error('OCR Worker error:', err)
      this.onWorkerExit(err)
    })

    this.ocrWorker.on('exit', (code) => {
      if (code !== 0) {
        logger.warn(`OCR Worker exited with code ${code}`)
      }
      this.onWorkerExit()
    })

    // 等待 Worker 就绪
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ocrWorker!.off('message', readyHandler)
        reject(new Error('OCR Worker startup timeout'))
        // 启动超时的子进程必须回收，否则会常驻占用内存
        this.resetStuckWorker()
      }, 30_000)

      const readyHandler = (msg: WorkerInMessage) => {
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          this.ocrWorker!.off('message', readyHandler)
          this.workerReady = true
          resolve()
        } else if (msg.type === 'fatal') {
          clearTimeout(timeout)
          this.ocrWorker!.off('message', readyHandler)
          reject(new Error(`OCR Worker fatal: ${(msg as WorkerFatalMessage).error}`))
        }
      }

      this.ocrWorker!.on('message', readyHandler)
    })

    // 发送初始化指令到 Worker
    const initResult = await this.sendToWorker<WorkerResultMessage>({ type: 'init', id: this.nextId() })
    if (!initResult.result?.initialized) {
      throw new Error('PaddleOCR Worker init failed')
    }
  }

  private handleWorkerMessage(msg: WorkerInMessage): void {
    if (msg.type === 'result' || msg.type === 'error') {
      const id = msg.id
      const pending = this.pendingRequests.get(id)
      if (pending) {
        this.pendingRequests.delete(id)
        if (msg.type === 'result') {
          pending.resolve(msg)
        } else {
          pending.reject(new Error((msg as WorkerErrorMessage).error))
        }
      }
    }
    // 'ready' 和 'fatal' 由 spawnAndInitWorker 的临时监听器处理
    // 'pong' 忽略
  }

  private onWorkerExit(err?: Error): void {
    if (!this.ocrWorker) return // 防止重复触发
    this.workerReady = false

    // 拒绝所有等待中的请求
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error(`OCR Worker crashed: ${err?.message || 'unknown error'}`))
    }
    this.pendingRequests.clear()

    // 清理 Worker 引用
    if (this.ocrWorker) {
      try { this.ocrWorker.kill() } catch { /* ignore */ }
      this.ocrWorker = null
    }

    // 重置 initPromise 允许下次调用重新初始化
    this.initPromise = null

    const msg = mainUiI18n.t('ocrWorkerCrashed')
    logger.error(msg, err)
    this.showError(mainUiI18n.t('ocrRuntimeErrorTitle'), `${msg}\n${err?.message || ''}`)
  }

  private nextId(): string {
    return `ocr_${++this.msgIdCounter}`
  }

  /**
   * 请求超时说明 Worker 内的原生推理已卡死（onnxruntime 不保证一定返回）。
   * 直接终止并重建 Worker，避免后续请求继续排在一个已卡死的线程上导致连续超时。
   */
  private resetStuckWorker(): void {
    const worker = this.ocrWorker
    if (!worker) return

    // 先置空引用：Worker 的 exit/error 回调据此判断为主动重建，不再重复弹窗
    this.ocrWorker = null
    this.workerReady = false
    this.initPromise = null
    this.stopIdleTimer()

    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('OCR Worker terminated after request timeout'))
    }
    this.pendingRequests.clear()

    worker.kill()
    logger.warn('OCR Worker 已因请求超时被重建')
  }

  /** 启动空闲回收定时器：模型内存占用大，长时间不用不应持续常驻 */
  private startIdleTimer(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      void this.terminateIfIdle()
    }, OCR_IDLE_CHECK_INTERVAL_MS)
    this.idleTimer.unref?.()
  }

  private stopIdleTimer(): void {
    if (!this.idleTimer) return
    clearInterval(this.idleTimer)
    this.idleTimer = null
  }

  private async terminateIfIdle(): Promise<void> {
    if (!this.ocrWorker || !this.workerReady) {
      this.stopIdleTimer()
      return
    }
    if (this.activeTasks > 0 || this.pendingRequests.size > 0) return
    if (Date.now() - this.lastUsedAt < OCR_IDLE_TERMINATE_MS) return
    logger.info('OCR Worker 空闲超时，回收子进程以释放内存')
    await this.terminate()
  }

  /** 串行执行识别任务：排队等待不计入超时，超时只衡量本次请求真正执行的时间 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.activeTasks++
    const run = this.taskQueue.then(task, task)
    this.taskQueue = run.catch(() => { /* 单次失败不阻断队列 */ })
    return run.finally(() => {
      this.activeTasks--
      this.lastUsedAt = Date.now()
    })
  }

  private sendToWorker<T = WorkerInMessage>(msg: WorkerOutMessage, timeoutMs = 60_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ocrWorker || !this.workerReady) {
        reject(new Error('OCR Worker not available'))
        return
      }

      const id = msg.id
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`OCR Worker request timeout (${timeoutMs}ms)`))
        this.resetStuckWorker()
      }, timeoutMs)

      this.pendingRequests.set(id, {
        resolve: (value: any) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (reason: any) => {
          clearTimeout(timeout)
          reject(reason)
        },
      })

      try {
        this.ocrWorker!.send(msg)
      } catch (err) {
        this.pendingRequests.delete(id)
        clearTimeout(timeout)
        reject(err)
      }
    })
  }

  // ── OCR 操作 ────────────────────────────────────────────────

  private async runPaddleOcrViaWorker(imagePath: string): Promise<OCRResult> {
    const msg: WorkerRecognizeMessage = {
      type: 'recognize',
      id: this.nextId(),
      imagePath,
    }
    const response = await this.sendToWorker<WorkerResultMessage>(msg, 120_000)
    return response.result as OCRResult
  }

  async recognize(imagePath: string, _options?: OCROptions): Promise<OCRResult> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`)
    }

    // 空闲回收进行中：等回收结束再重新初始化，避免拿到已销毁的 Worker
    if (this.terminatePromise) await this.terminatePromise

    return this.enqueue(async () => {
      // 确保 PaddleOCR 已尝试初始化（Worker 超时被重建后，这里会重新拉起）
      await this.initialize()

      try {
        return await this.runPaddleOcrViaWorker(imagePath)
      } catch (err) {
        const msg = mainUiI18n.t('ocrRecognizeFailed')
        logger.error(msg, { imagePath, error: err })
        this.showError(mainUiI18n.t('ocrRecognizeFailedTitle'), `${msg}\n${mainUiI18n.t('ocrImageLabel')}: ${path.basename(imagePath)}\n${err instanceof Error ? err.message : String(err)}`)
        throw err instanceof Error ? err : new Error(String(err))
      }
    })
  }

  async recognizeBuffer(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const tempPath = path.join(os.tmpdir(), `ocr_${Date.now()}.png`)
    try {
      await fs.promises.writeFile(tempPath, imageBuffer)
      return await this.recognize(tempPath, options)
    } finally {
      try {
        await fs.promises.unlink(tempPath)
      } catch (error) {
        logger.debug('Failed to delete OCR temp file', tempPath, error)
      }
    }
  }

  async terminate(): Promise<void> {
    if (this.terminatePromise) return this.terminatePromise
    this.terminatePromise = this.doTerminate().finally(() => {
      this.terminatePromise = null
    })
    return this.terminatePromise
  }

  private async doTerminate(): Promise<void> {
    this.stopIdleTimer()
    if (!this.ocrWorker) {
      this.initPromise = null
      this.workerReady = false
      return
    }
    try {
      const msg: WorkerTerminateMessage = { type: 'terminate', id: this.nextId() }
      await this.sendToWorker(msg, 5_000).catch(() => { /* Worker may already be dead */ })
      this.ocrWorker.kill()
    } catch (err) {
      logger.debug('OCR Worker terminate error:', err)
    }
    this.ocrWorker = null
    this.workerReady = false
    this.initPromise = null
  }

  isPaddleOcrAvailable(): boolean {
    return this.workerReady
  }

  // ── 错误提示 ────────────────────────────────────────────────

  private showError(title: string, content: string): void {
    // 同步非阻塞弹窗，不会卡住主进程
    try {
      // Lazy require：避免打包器把 require('electron') 提升到模块加载时机。
      // KMS 索引 Worker 会间接引用 OCRService，而 worker_threads 中无法解析
      // electron 模块，提升后会导致 Worker 启动即崩溃。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dialog } = require('electron')
      dialog.showErrorBox(title, content)
    } catch (err) {
      logger.error('Failed to show OCR error dialog:', err)
    }
  }
}

export default OCRService
