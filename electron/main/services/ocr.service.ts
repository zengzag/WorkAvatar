import fs from 'fs'
import path from 'path'
import { nativeImage } from 'electron'
import { createWorker } from 'tesseract.js'
import { createLogger } from './logger'
import PathService from './path.service'

const logger = createLogger('OCR')

/**
 * OCR 引擎选择。
 *
 * 优先级：paddleocr > tesseract
 *
 * - paddleocr：基于 PaddleOCR v5 mobile + onnxruntime-node 本地推理，中文识别精度显著优于 Tesseract
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

interface PaddleOcrLike {
  recognize: (input: { width: number; height: number; data: Uint8Array }) => Promise<Array<{
    text: string
    box: { x: number; y: number; width: number; height: number }
    confidence: number
  }>>
  processRecognition: (
    results: Array<{ text: string; box: { x: number; y: number; width: number; height: number }; confidence: number }>,
    options?: { lineMergeThresholdRatio?: number }
  ) => { text: string }
  destroy: () => Promise<void>
}

interface PaddleOcrCtor {
  createInstance: (options: Record<string, unknown>) => Promise<PaddleOcrLike>
}

class OCRService {
  private static instance: OCRService
  private tesseractWorker: Tesseract.Worker | null = null
  private paddleocr: PaddleOcrLike | null = null
  private paddleocrAvailable = false
  private initPromise: Promise<void> | null = null

  private constructor() {}

  static getInstance(): OCRService {
    if (!OCRService.instance) {
      OCRService.instance = new OCRService()
    }
    return OCRService.instance
  }

  /**
   * 初始化 PaddleOCR 引擎。多次调用只会初始化一次。
   *
   * PaddleOCR 模型文件位于 `<resourcesDir>/paddleocr/ppocr_v5_mobile/`，由 electron-builder
   * 的 `extraResources` 打包到生产包内；开发态从项目根的 `resources/` 读取。
   */
  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.doInitialize()
    return this.initPromise
  }

  private async doInitialize(): Promise<void> {
    try {
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

      // paddleocr / onnxruntime-node 是 ESM/CJS 混合包，使用动态 import 延迟加载
      const [{ PaddleOcrService }, ort] = await Promise.all([
        import('paddleocr') as unknown as Promise<{ PaddleOcrService: PaddleOcrCtor['createInstance'] extends (...args: any[]) => any ? PaddleOcrCtor : never }>,
        import('onnxruntime-node') as unknown as Promise<{ default: unknown }>,
      ])

      const detBuffer = this.toArrayBuffer(await fs.promises.readFile(detPath))
      const recBuffer = this.toArrayBuffer(await fs.promises.readFile(recPath))
      const dictText = await fs.promises.readFile(dictPath, 'utf-8')
      let charactersDictionary = dictText.split(/\r?\n/).filter(line => line.length > 0)
      // PP-OCRv5 模型输出 18385 类，官方字典文件 18383 行。
      // 末尾需要补齐 2 个空字符串占位（CTC blank/space），否则解码越界。
      // 见 https://github.com/PaddlePaddle/PaddleOCR 官方说明
      if (charactersDictionary.length < 18385) {
        const padding = 18385 - charactersDictionary.length
        charactersDictionary = charactersDictionary.concat(new Array(padding).fill(''))
        logger.info(`Padded PaddleOCR dictionary with ${padding} empty entries (total ${charactersDictionary.length})`)
      }

      this.paddleocr = await (PaddleOcrService as unknown as PaddleOcrCtor).createInstance({
        ort: ort.default ?? ort,
        modelPreset: 'PP-OCRv5_mobile',
        detection: { modelBuffer: detBuffer },
        recognition: {
          modelBuffer: recBuffer,
          charactersDictionary,
        },
      })

      this.paddleocrAvailable = true
      logger.info('PaddleOCR v5 mobile engine initialized')
    } catch (err) {
      logger.warn('PaddleOCR initialization failed, falling back to Tesseract.js:', err)
      this.paddleocrAvailable = false
    }
  }

  private getPaddleOcrModelDir(): string {
    const resourcesDir = PathService.getInstance().getResourcesDir()
    return path.join(resourcesDir, 'paddleocr', 'ppocr_v5_mobile')
  }

  private toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer
  }

  private async runPaddleOcr(imagePath: string): Promise<OCRResult> {
    if (!this.paddleocr) {
      throw new Error('PaddleOCR not initialized')
    }
    // 使用 Electron nativeImage 解码图片为 BGRA，再转 RGB（PaddleOcrService 期望的输入格式）
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) {
      throw new Error(`Failed to decode image: ${imagePath}`)
    }
    const { width, height } = image.getSize()
    const bgra = image.toBitmap()
    // BGRA → RGB：每 4 字节取 BGR 前三字节并交换为 RGB
    const rgb = new Uint8Array(width * height * 3)
    for (let i = 0, j = 0; i < bgra.length; i += 4, j += 3) {
      rgb[j] = bgra[i + 2]     // R
      rgb[j + 1] = bgra[i + 1] // G
      rgb[j + 2] = bgra[i]     // B
    }

    const input = {
      width,
      height,
      data: rgb,
    }

    const raw = await this.paddleocr.recognize(input)
    const { text } = this.paddleocr.processRecognition(raw, { lineMergeThresholdRatio: 0.5 })

    const blocks: OCRBlock[] = raw.map(r => ({
      text: r.text,
      confidence: r.confidence,
      bbox: {
        x0: r.box.x,
        y0: r.box.y,
        x1: r.box.x + r.box.width,
        y1: r.box.y + r.box.height,
      },
    }))

    const confidence = blocks.length > 0
      ? blocks.reduce((sum, b) => sum + b.confidence, 0) / blocks.length
      : 0

    return {
      text,
      confidence,
      engine: 'paddleocr',
      blocks,
    }
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

    if (usePaddle && this.paddleocr) {
      try {
        return await this.runPaddleOcr(imagePath)
      } catch (err) {
        if (requested === 'paddleocr') {
          throw err
        }
        logger.warn('PaddleOCR runtime failed, falling back to Tesseract.js:', err)
      }
    }

    const language = options?.language || 'chi_sim+eng'
    return await this.runTesseract(imagePath, language)
  }

  async recognizeBuffer(imageBuffer: Buffer, options?: OCROptions): Promise<OCRResult> {
    const tempPath = path.join(require('os').tmpdir(), `ocr_${Date.now()}.png`)
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
    if (this.paddleocr) {
      try {
        await this.paddleocr.destroy()
      } catch (err) {
        logger.debug('PaddleOCR destroy error:', err)
      }
      this.paddleocr = null
      this.paddleocrAvailable = false
    }
  }

  isPaddleOcrAvailable(): boolean {
    return this.paddleocrAvailable
  }
}

export default OCRService
