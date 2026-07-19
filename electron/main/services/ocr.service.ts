import fs from 'fs'
import os from 'os'
import path from 'path'
import { Worker } from 'worker_threads'
import { dialog } from 'electron'
import { createLogger } from './logger'
import PathService from './path.service'

const logger = createLogger('OCR')

/**
 * OCR 服务：基于 PaddleOCR v5 mobile + onnxruntime-node 本地推理，运行在独立 Worker 线程中。
 *
 * Worker 线程用于隔离 onnxruntime-native 原生崩溃，避免拖垮主进程。
 * 任何失败（Worker 启动失败、初始化失败、识别失败、Worker 崩溃）都会：
 *   1. 写入错误日志
 *   2. 弹窗提示用户
 *   3. 抛出错误由调用方处理
 */
interface OCROptions {
  language?: string
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

class OCRService {
  private static instance: OCRService
  private initPromise: Promise<void> | null = null

  private ocrWorker: Worker | null = null
  private workerReady = false
  private pendingRequests = new Map<string, {
    resolve: (value: any) => void
    reject: (reason: any) => void
  }>()
  private msgIdCounter = 0

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
    const detPath = path.join(modelDir, 'PP-OCRv5_mobile_det_infer.onnx')
    const recPath = path.join(modelDir, 'PP-OCRv5_mobile_rec_infer.onnx')
    const dictPath = path.join(modelDir, 'ppocrv5_dict.txt')

    if (!fs.existsSync(detPath) || !fs.existsSync(recPath) || !fs.existsSync(dictPath)) {
      const msg = 'PaddleOCR 模型文件缺失，OCR 功能不可用'
      logger.error(msg, { detPath, recPath, dictPath })
      this.showError('OCR 初始化失败', `${msg}\n路径: ${modelDir}`)
      throw new Error(msg)
    }

    try {
      await this.spawnAndInitWorker()
      logger.info('PaddleOCR v5 mobile engine initialized (Worker)')
    } catch (err) {
      const msg = 'PaddleOCR Worker 初始化失败'
      logger.error(msg, err)
      this.showError('OCR 初始化失败', `${msg}\n${err instanceof Error ? err.message : String(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  private getPaddleOcrModelDir(): string {
    const resourcesDir = PathService.getInstance().getResourcesDir()
    return path.join(resourcesDir, 'paddleocr', 'ppocr_v5_mobile')
  }

  // ── Worker 生命周期 ──────────────────────────────────────────

  private async spawnAndInitWorker(): Promise<void> {
    const workerPath = path.join(__dirname, 'ocr-worker.js')
    const pathService = PathService.getInstance()

    this.ocrWorker = new Worker(workerPath, {
      workerData: {
        dataDir: pathService.getDataDir(),
        isDev: pathService.getIsDev(),
        resourcesDir: pathService.getResourcesDir(),
      },
    })

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
      try { this.ocrWorker.terminate() } catch { /* ignore */ }
      this.ocrWorker = null
    }

    // 重置 initPromise 允许下次调用重新初始化
    this.initPromise = null

    const msg = 'OCR Worker 崩溃退出，图片识别不可用'
    logger.error(msg, err)
    this.showError('OCR 运行异常', `${msg}\n${err?.message || ''}`)
  }

  private nextId(): string {
    return `ocr_${++this.msgIdCounter}`
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
        this.ocrWorker!.postMessage(msg)
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

    // 确保 PaddleOCR 已尝试初始化（首次调用是异步加载的）
    await this.initialize()

    try {
      return await this.runPaddleOcrViaWorker(imagePath)
    } catch (err) {
      const msg = 'PaddleOCR 识别失败'
      logger.error(msg, { imagePath, error: err })
      this.showError('OCR 识别失败', `${msg}\n图片: ${path.basename(imagePath)}\n${err instanceof Error ? err.message : String(err)}`)
      throw err instanceof Error ? err : new Error(String(err))
    }
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
    if (this.ocrWorker) {
      try {
        const msg: WorkerTerminateMessage = { type: 'terminate', id: this.nextId() }
        await this.sendToWorker(msg, 5_000).catch(() => { /* Worker may already be dead */ })
        await this.ocrWorker.terminate()
      } catch (err) {
        logger.debug('OCR Worker terminate error:', err)
      }
      this.ocrWorker = null
      this.workerReady = false
      this.initPromise = null
    }
  }

  isPaddleOcrAvailable(): boolean {
    return this.workerReady
  }

  // ── 错误提示 ────────────────────────────────────────────────

  private showError(title: string, content: string): void {
    // 同步非阻塞弹窗，不会卡住主进程
    try {
      dialog.showErrorBox(title, content)
    } catch (err) {
      logger.error('Failed to show OCR error dialog:', err)
    }
  }
}

export default OCRService
