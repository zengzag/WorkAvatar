/**
 * LoggerBackend 真实实例化测试：文件初始化、写入格式、幂等、旧日志清理、降级。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LoggerBackend } from '../../../electron/main/services/logger'

let root: string

/** 等待底层文件打开（createWriteStream 的 open 在后续 tick 执行） */
async function waitStreamReady(backend: LoggerBackend): Promise<void> {
  const stream = (backend as unknown as { stream?: fs.WriteStream }).stream
  if (!stream || (stream as unknown as { pending?: boolean }).pending === false) return
  await new Promise<void>(resolve => stream.once('open', () => resolve()))
}

/** 等待 WriteStream 落盘关闭后读取文件（destroy 的 end() 是异步的） */
async function readAfterFlush(backend: LoggerBackend, file: string): Promise<string> {
  const stream = (backend as unknown as { stream?: fs.WriteStream }).stream
  if (stream) {
    await new Promise<void>(resolve => stream.end(resolve))
  }
  return fs.readFileSync(file, 'utf-8')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-logger-'))
  ;(LoggerBackend as any).instance = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('LoggerBackend', () => {
  it('init 后创建日志文件，write 写入带前缀/级别/时间的行', async () => {
    const backend = LoggerBackend.getInstance()
    backend.init(root)
    await waitStreamReady(backend)

    const logFile = backend.getLogFilePath()
    expect(logFile).toBeTruthy()
    expect(fs.existsSync(logFile!)).toBe(true)
    expect(path.basename(logFile!)).toMatch(/^app-\d{4}-\d{2}-\d{2}-\d{6}\.log$/)

    backend.write('info', 'DB', '启动完成', [])
    const content = await readAfterFlush(backend, logFile!)
    backend.destroy()

    expect(content).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[DB\] \[INFO\] 启动完成\n$/)
  })

  it('未知模块使用 [module] 兜底前缀；参数被序列化追加', async () => {
    const backend = LoggerBackend.getInstance()
    backend.init(root)
    const logFile = backend.getLogFilePath()!

    backend.write('warn', 'MyModule', '带参数', [{ a: 1 }])
    const content = await readAfterFlush(backend, logFile)
    backend.destroy()

    expect(content).toContain('[MyModule] [WARN] 带参数 {"a":1}')
  })

  it('init 幂等：重复调用沿用同一文件', () => {
    const backend = LoggerBackend.getInstance()
    backend.init(root)
    const first = backend.getLogFilePath()
    backend.init(root + path.sep + 'other')
    expect(backend.getLogFilePath()).toBe(first)
  })

  it('init 不传 dataDir 不抛错，降级为仅控制台', () => {
    const backend = LoggerBackend.getInstance()
    expect(() => backend.init()).not.toThrow()
    expect(backend.getLogFilePath()).toBeNull()
    backend.write('info', 'DB', '仅控制台', [])
  })

  it('writeToFile 不依赖控制台，直接写文件', async () => {
    const backend = LoggerBackend.getInstance()
    backend.init(root)
    const logFile = backend.getLogFilePath()!
    backend.writeToFile('error', 'Agent', '渲染端转发')
    const content = await readAfterFlush(backend, logFile)
    backend.destroy()
    expect(content).toContain('[Agent] [ERROR] 渲染端转发')
  })

  it('清理 14 天前旧日志，保留新日志', () => {
    const logDir = path.join(root, '.log', 'app')
    fs.mkdirSync(logDir, { recursive: true })
    const oldFile = path.join(logDir, 'old.log')
    const newFile = path.join(logDir, 'new.log')
    fs.writeFileSync(oldFile, 'old')
    fs.writeFileSync(newFile, 'new')
    const oldTime = new Date(Date.now() - 15 * 86400 * 1000)
    fs.utimesSync(oldFile, oldTime, oldTime)

    const backend = LoggerBackend.getInstance()
    backend.init(root)
    backend.destroy()

    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(newFile)).toBe(true)
  })

  it('destroy 后重复 write 不抛错', () => {
    const backend = LoggerBackend.getInstance()
    backend.init(root)
    backend.destroy()
    expect(() => backend.write('info', 'DB', '销毁后', [])).not.toThrow()
  })
})
