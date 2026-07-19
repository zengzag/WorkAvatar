/**
 * OCR Worker — 将 PaddleOCR / onnxruntime-native 运行在独立 Worker 线程中。
 *
 * 目的：onnxruntime-native 在初始化或推理时可能触发原生崩溃（segfault），
 * 在主线程中这会直接杀死整个 Electron 进程。Worker 线程崩溃不会影响主进程，
 * 主线程检测到 Worker 退出后记录日志并弹窗提示用户。
 *
 * 消息协议：
 *   主线程 → Worker:
 *     { type: 'init', id }                   初始化 PaddleOCR 引擎
 *     { type: 'recognize', id, imagePath }   识别图片
 *     { type: 'terminate', id }              销毁引擎
 *     { type: 'ping', id }                   健康检查
 *
 *   Worker → 主线程:
 *     { type: 'ready' }                      Worker 初始化完成
 *     { type: 'fatal', error }               Worker 初始化失败
 *     { type: 'result', id, result? }        操作成功
 *     { type: 'error', id, error }           操作失败
 *     { type: 'pong', id }                   健康检查响应
 */

import { parentPort, workerData } from 'worker_threads'
import fs from 'fs'
import path from 'path'
import { createLogger } from '../services/logger'

const logger = createLogger('OCR-Worker')

// ── Worker 初始化 ──────────────────────────────────────────────

interface WorkerInitData {
  dataDir: string
  isDev: boolean
  resourcesDir: string
}

const initData = workerData as WorkerInitData

// ── PaddleOCR 类型 ─────────────────────────────────────────────

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

interface OCRResult {
  text: string
  confidence: number
  engine: string
  blocks?: Array<{
    text: string
    confidence: number
    bbox: { x0: number; y0: number; x1: number; y1: number }
  }>
}

let paddleocr: PaddleOcrLike | null = null

// ── PaddleOCR 初始化 ──────────────────────────────────────────

async function initialize(): Promise<void> {
  const modelDir = path.join(initData.resourcesDir, 'paddleocr', 'ppocr_v5_mobile')
  const detPath = path.join(modelDir, 'PP-OCRv5_mobile_det_infer.onnx')
  const recPath = path.join(modelDir, 'PP-OCRv5_mobile_rec_infer.onnx')
  const dictPath = path.join(modelDir, 'ppocrv5_dict.txt')

  if (!fs.existsSync(detPath) || !fs.existsSync(recPath) || !fs.existsSync(dictPath)) {
    throw new Error(`PaddleOCR model files missing: ${modelDir}`)
  }

  const [{ PaddleOcrService }, ort] = await Promise.all([
    import('paddleocr') as unknown as Promise<{ PaddleOcrService: PaddleOcrCtor }>,
    import('onnxruntime-node') as unknown as Promise<{ default: unknown }>,
  ])

  const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer

  const detBuffer = toArrayBuffer(await fs.promises.readFile(detPath))
  const recBuffer = toArrayBuffer(await fs.promises.readFile(recPath))
  const dictText = await fs.promises.readFile(dictPath, 'utf-8')
  let charactersDictionary = dictText.split(/\r?\n/).filter(line => line.length > 0)
  if (charactersDictionary.length < 18385) {
    const padding = 18385 - charactersDictionary.length
    charactersDictionary = charactersDictionary.concat(new Array(padding).fill(''))
    logger.info(`Padded PaddleOCR dictionary with ${padding} empty entries (total ${charactersDictionary.length})`)
  }

  paddleocr = await (PaddleOcrService as unknown as PaddleOcrCtor).createInstance({
    ort: ort.default ?? ort,
    modelPreset: 'PP-OCRv5_mobile',
    detection: { modelBuffer: detBuffer },
    recognition: {
      modelBuffer: recBuffer,
      charactersDictionary,
    },
  })

  logger.info('PaddleOCR v5 mobile engine initialized in Worker')
}

// ── OCR 识别 ────────────────────────────────────────────────────

async function recognize(imagePath: string): Promise<OCRResult> {
  if (!paddleocr) {
    throw new Error('PaddleOCR not initialized')
  }

  // 使用 sharp 解码图片为 RGB 像素
  const sharpMod = await import('sharp')
  const sharp = (sharpMod as unknown as { default: (input: string | Buffer) => any }).default
  const decoded = await sharp(imagePath)
    .removeAlpha()
    .raw({ resolveWithObject: true })
    .toBuffer({ resolveWithObject: true }) as { data: Buffer; info: { width: number; height: number; channels: number } }

  const input = {
    width: decoded.info.width,
    height: decoded.info.height,
    data: new Uint8Array(
      decoded.data.buffer,
      decoded.data.byteOffset,
      decoded.data.byteLength,
    ),
  }

  const raw = await paddleocr.recognize(input)
  const { text } = paddleocr.processRecognition(raw, { lineMergeThresholdRatio: 0.5 })

  const blocks: OCRResult['blocks'] = raw.map(r => ({
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

// ── 销毁引擎 ────────────────────────────────────────────────────

async function terminatePaddleOcr(): Promise<void> {
  if (paddleocr) {
    try {
      await paddleocr.destroy()
    } catch (err) {
      logger.debug('PaddleOCR destroy error:', err)
    }
    paddleocr = null
  }
}

// ── 消息处理 ────────────────────────────────────────────────────

interface BaseMessage {
  type: string
  id: string
}

interface InitMessage extends BaseMessage {
  type: 'init'
}

interface RecognizeMessage extends BaseMessage {
  type: 'recognize'
  imagePath: string
}

interface TerminateMessage extends BaseMessage {
  type: 'terminate'
}

interface PingMessage extends BaseMessage {
  type: 'ping'
}

type WorkerMessage = InitMessage | RecognizeMessage | TerminateMessage | PingMessage

async function handleMessage(msg: WorkerMessage): Promise<void> {
  switch (msg.type) {
    case 'init': {
      try {
        await initialize()
        parentPort?.postMessage({ type: 'result', id: msg.id, result: { initialized: true } })
      } catch (err: any) {
        parentPort?.postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) })
      }
      break
    }
    case 'recognize': {
      try {
        const result = await recognize(msg.imagePath)
        // 将 OCRResult 序列化（Uint8Array 等不可直接传输的字段已在 recognize 中转为普通对象）
        parentPort?.postMessage({ type: 'result', id: msg.id, result })
      } catch (err: any) {
        parentPort?.postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) })
      }
      break
    }
    case 'terminate': {
      try {
        await terminatePaddleOcr()
        parentPort?.postMessage({ type: 'result', id: msg.id, result: { terminated: true } })
      } catch (err: any) {
        parentPort?.postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) })
      }
      break
    }
    case 'ping': {
      parentPort?.postMessage({ type: 'pong', id: msg.id })
      break
    }
  }
}

parentPort?.on('message', (msg: WorkerMessage) => {
  handleMessage(msg).catch(err => {
    logger.error('Unhandled error in message handler:', err)
    try {
      parentPort?.postMessage({ type: 'error', id: msg.id, error: 'Internal worker error' })
    } catch { /* Worker may be exiting */ }
  })
})

// 通知主线程 Worker 已就绪
parentPort?.postMessage({ type: 'ready' })
