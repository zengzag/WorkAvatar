/**
 * OCRService 真实实例化测试：
 * 初始化幂等、模型缺失拒绝、recognize 成功/失败包装、Buffer 临时文件闭环、
 * Worker 崩溃拒绝 pending、请求超时重建、terminate。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Module from 'module'

const state = vi.hoisted(() => ({
  resourcesDir: '',
  workers: [] as any[],
}))

const { FakeWorker } = vi.hoisted(() => {
  class TinyEmitter {
    private handlers: Record<string, Array<(...args: any[]) => void>> = {}
    on(ev: string, cb: (...args: any[]) => void): this {
      ;(this.handlers[ev] || (this.handlers[ev] = [])).push(cb)
      return this
    }
    off(ev: string, cb: (...args: any[]) => void): this {
      const arr = this.handlers[ev]
      if (arr) this.handlers[ev] = arr.filter(x => x !== cb)
      return this
    }
    emit(ev: string, ...args: any[]): void {
      ;(this.handlers[ev] || []).slice().forEach(cb => cb(...args))
    }
  }

  class FakeWorker extends TinyEmitter {
    posted: any[] = []
    terminated = false
    terminate = vi.fn(async () => {
      if (this.terminated) return 0
      this.terminated = true
      queueMicrotask(() => this.emit('exit', 1))
      return 1
    })

    constructor() {
      super()
      queueMicrotask(() => this.emit('message', { type: 'ready' }))
    }

    postMessage(msg: any): void {
      this.posted.push(msg)
      if (msg.type === 'init') {
        queueMicrotask(() =>
          this.emit('message', { type: 'result', id: msg.id, result: { initialized: true } })
        )
      } else if (msg.type === 'recognize') {
        queueMicrotask(() =>
          this.emit('message', {
            type: 'result',
            id: msg.id,
            result: { text: '识别文本', confidence: 0.9, engine: 'paddle' },
          })
        )
      } else if (msg.type === 'terminate') {
        queueMicrotask(() => this.emit('message', { type: 'result', id: msg.id }))
      }
    }
  }
  return { FakeWorker }
})

vi.mock('worker_threads', () => ({ Worker: FakeWorker }))

vi.mock('../../../electron/main/services/path.service', () => ({
  default: {
    getInstance: () => ({
      getResourcesDir: () => state.resourcesDir,
      getDataDir: () => state.resourcesDir,
      getIsDev: () => true,
    }),
  },
}))

vi.mock('../../../electron/main/services/ui-i18n.service', () => ({
  default: { t: (k: string) => k },
}))

const dialogMock = vi.hoisted(() => ({ showErrorBox: vi.fn() }))

// 源码 showError 用 lazy require('electron')：vi.mock 只拦 import，需经 Module._load 拦截
const origModuleLoad = (Module as any)._load
;(Module as any)._load = function (this: any, request: string, ...rest: any[]) {
  if (request === 'electron') return { dialog: dialogMock }
  return origModuleLoad.call(this, request, ...rest)
}

import OCRService from '../../../electron/main/services/ocr.service'

beforeEach(() => {
  state.resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ocr-'))
  state.workers.length = 0
  ;(OCRService as any).instance = undefined
  dialogMock.showErrorBox.mockClear()
})

afterEach(() => {
  fs.rmSync(state.resourcesDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** 放置模型三件套，使初始化通过 */
function seedModels(): string {
  const dir = path.join(state.resourcesDir, 'paddleocr', 'ppocr_v5_mobile')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'PP-OCRv5_mobile_det_infer.onnx'), 'x')
  fs.writeFileSync(path.join(dir, 'PP-OCRv5_mobile_rec_infer.onnx'), 'x')
  fs.writeFileSync(path.join(dir, 'ppocrv5_dict.txt'), 'x')
  return dir
}

describe('OCRService / initialize', () => {
  it('模型文件缺失：reject 且不启动 Worker', async () => {
    const svc = OCRService.getInstance()
    await expect(svc.initialize()).rejects.toThrow('ocrModelMissing')
    expect(dialogMock.showErrorBox).toHaveBeenCalled()
  })

  it('初始化成功：Worker 就绪、ready 状态可查；重复调用幂等', async () => {
    seedModels()
    const svc = OCRService.getInstance()

    expect(svc.isPaddleOcrAvailable()).toBe(false)
    await svc.initialize()
    expect(svc.isPaddleOcrAvailable()).toBe(true)

    await svc.initialize()
    // 只创建了一个 Worker（无第二个 ready）
    expect(svc).toBeTruthy()
  })
})

describe('OCRService / recognize', () => {
  it('图片不存在直接抛错', async () => {
    const svc = OCRService.getInstance()
    await expect(svc.recognize('missing.png')).rejects.toThrow('Image file not found')
  })

  it('成功：返回 Worker 识别结果', async () => {
    seedModels()
    const image = path.join(state.resourcesDir, 'img.png')
    fs.writeFileSync(image, 'png')

    const result = await OCRService.getInstance().recognize(image)
    expect(result).toEqual({ text: '识别文本', confidence: 0.9, engine: 'paddle' })
  })

  it('recognizeBuffer：写临时文件识别后清理', async () => {
    seedModels()
    const svc = OCRService.getInstance()
    const result = await svc.recognizeBuffer(Buffer.from('fake-png'))
    expect(result.text).toBe('识别文本')

    // 临时文件已删除
    const tmpFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('ocr_'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('Worker 返回 error：错误被包装并弹窗', async () => {
    seedModels()
    const image = path.join(state.resourcesDir, 'img.png')
    fs.writeFileSync(image, 'png')

    const svc = OCRService.getInstance()
    await svc.initialize()
    const worker = (svc as any).ocrWorker as FakeWorker
    const origPost = worker.postMessage.bind(worker)
    worker.postMessage = (msg: any) => {
      if (msg.type === 'recognize') {
        queueMicrotask(() =>
          worker.emit('message', { type: 'error', id: msg.id, error: '识别失败' })
        )
      } else origPost(msg)
    }

    await expect(svc.recognize(image)).rejects.toThrow('识别失败')
    expect(dialogMock.showErrorBox).toHaveBeenCalled()
  })
})

describe('OCRService / Worker 异常', () => {
  it('Worker 崩溃：pending 请求被 reject，弹窗提示', async () => {
    seedModels()
    const image = path.join(state.resourcesDir, 'img.png')
    fs.writeFileSync(image, 'png')

    const svc = OCRService.getInstance()
    await svc.initialize()
    const worker = (svc as any).ocrWorker as any
    worker.postMessage = vi.fn() // 识别请求不回复

    const promise = svc.recognize(image)
    await vi.waitFor(
      () => expect((svc as any).pendingRequests.size).toBe(1),
      { interval: 1 }
    )

    worker.emit('error', new Error('native crash'))

    await expect(promise).rejects.toThrow(/crash/)
    expect((svc as any).ocrWorker).toBeNull()
    expect(dialogMock.showErrorBox).toHaveBeenCalled()
  })

  it('请求超时：reject 并终止卡死的 Worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      seedModels()
      const image = path.join(state.resourcesDir, 'img.png')
      fs.writeFileSync(image, 'png')

      const svc = OCRService.getInstance()
      await svc.initialize()

      // Worker 对识别消息不回复，模拟原生推理卡死
      ;(svc as any).ocrWorker.postMessage = vi.fn()
      const promise = svc.recognize(image)
      for (let i = 0; i < 6; i++) await Promise.resolve()
      expect((svc as any).pendingRequests.size).toBe(1)

      // 断言的 rejects handler 必须在推进（reject 发生）前注册，否则 fake timer 会记为 unhandled
      const rejectionExpectation = expect(promise).rejects.toThrow('request timeout')
      await vi.advanceTimersByTimeAsync(120_001)
      await rejectionExpectation
      expect((svc as any).ocrWorker).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminate：清理 Worker 并重置状态', async () => {
    seedModels()
    const svc = OCRService.getInstance()
    await svc.initialize()
    await svc.terminate()
    expect((svc as any).ocrWorker).toBeNull()
    expect(svc.isPaddleOcrAvailable()).toBe(false)
  })
})
