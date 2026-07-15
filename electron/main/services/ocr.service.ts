import fs from 'fs'
import os from 'os'
import path from 'path'
import { Worker } from 'worker_threads'
import { createWorker } from 'tesseract.js'
import { createLogger } from './logger'
import PathService from './path.service'

const logger = createLogger('OCR')

/**
 * OCR 引擎选择。
 *
 * 优先级：paddleocr (Worker) > tesseract (主线程)
 *
 * - paddleocr：基于 PaddleOCR v5 mobile + onnxruntime-node 本地推理，中文识别精度显著优于 Tesseract
 *   运行在独立 Worker 线程中，onnxruntime-native 崩溃不会杀死主进程
 * - tesseract：纯 JS (WebAssembly) 兜底，通用性强但中文/复杂排版识别能力弱
 */
type OCREngineName = 'paddleocr' | 'tesseract' | 'auto'

interface OCROptions {
  language?: string
  engine?: OCREngineName
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
  private tesseractWorker: Tesseract.Worker | null = null
  private paddleocrAvailable = false
  private initPromise: Promise<void> | null = null

  // Worker 相关状态
  private ocrWorker: Worker | null = null
  private workerReady = false
  private workerDead = false // Worker 崩溃后标记为死亡，不再重试
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
   * 初始化 PaddleOCR 引擎（在 Worker 线程中）。
   * 多次调用只会初始化一次。Worker 崩溃后不会重试。
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    // 检查模型文件是否存在
    const modelDir = this.getPaddleOcrModelDir()
    const detPath = path.join(modelDir, 'PP-OCRv5_mobile_det_infer.onnx')
    const recPath = path.join(modelDir, 'PP-OCRv5_mobile_rec_infer.onnx')
    const dictPath = path.join(modelDir, 'ppocrv5_dict.txt')

    if (!fs.existsSync(detPath) || !fs.existsSync(recPath) || !fs.existsSync(dictPath)) {
      logger.warn('PaddleOCR model files missing, falling back to Tesseract.js:', {
        detPath, recPath, dictPath,
      })
      return
    }

    try {
      await this.spawnAndInitWorker()
      this.paddleocrAvailable = true
      logger.info('PaddleOCR v5 mobile engine initialized (Worker)')
    } catch (err) {
      logger.warn('PaddleOCR Worker initialization failed, falling back to Tesseract.js:', err)
      this.paddleocrAvailable = false
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

    this.ocrWorker.on('error', (err) => {
      logger.error('OCR Worker error:', err)
      this.onWorkerExit()
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

  private onWorkerExit(): void {
    if (this.workerDead && !this.ocrWorker) return // 防止重复触发
    this.workerReady = false
    this.paddleocrAvailable = false
    this.workerDead = true

    // 拒绝所有等待中的请求
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('OCR Worker crashed'))
    }
    this.pendingRequests.clear()

    // 清理 Worker 引用
    if (this.ocrWorker) {
      try { this.ocrWorker.terminate() } catch { /* ignore */ }
      this.ocrWorker = null
    }

    logger.warn('OCR Worker crashed/exited — PaddleOCR disabled, will use Tesseract.js fallback')
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

  private async runTesseract(imagePath: string, language: string = 'chi_sim+eng'): Promise<OCRResult> {
    if (!this.tesseractWorker) {
      this.tesseractWorker = await createWorker(language)
    }

    const { data } = await this.tesseractWorker.recognize(imagePath)

    const blocks: OCRBlock[] = data.blocks?.map((block: any) => ({
      text: block.text || '',
      confidence: block.confidence || 0,
      bbox: block.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 },
    })) || []

    return {
      text: data.text || '',
      confidence: data.confidence ? data.confidence / 100 : 0.8,
      engine: 'tesseract.js',
      blocks,
    }
  }

  async recognize(imagePath: string, options?: OCROptions): Promise<OCRResult> {
    if (!fs.existsSync(imagePath)) {
      throw new Error(`Image file not found: ${imagePath}`)
    }

    // 确保 PaddleOCR 已尝试初始化（首次调用是异步加载的）
    await this.initialize()

    const requested = options?.engine || 'auto'
    const usePaddle = requested === 'paddleocr' || (requested === 'auto' && this.paddleocrAvailable)

    if (usePaddle && this.workerReady && !this.workerDead) {
      try {
        return await this.runPaddleOcrViaWorker(imagePath)
      } catch (err) {
        if (requested === 'paddleocr') {
          throw err
        }
        logger.warn('PaddleOCR Worker failed, falling back to Tesseract.js:', err)
      }
    }

    const language = options?.language || 'chi_sim+eng'
    return await this.runTesseract(imagePath, language)
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
    if (this.tesseractWorker) {
      try {
        await this.tesseractWorker.terminate()
      } catch (err) {
        logger.debug('Tesseract terminate error:', err)
      }
      this.tesseractWorker = null
    }

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
      this.paddleocrAvailable = false
    }
  }

  isPaddleOcrAvailable(): boolean {
    return this.paddleocrAvailable && this.workerReady && !this.workerDead
  }
}

export default OCRService
