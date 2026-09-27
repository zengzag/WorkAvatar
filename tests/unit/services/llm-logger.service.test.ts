/**
 * LLMLoggerService 真实实例化测试：
 * jsonl 落盘结构、员工/系统路径分流、文件名清洗、AsyncLocalStorage 上下文、stream 复用、destroy。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import LLMLoggerService from '../../../electron/main/services/llm-logger.service'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-llmlog-'))
  ;(LLMLoggerService as any).instance = undefined
})

afterEach(() => {
  try { LLMLoggerService.getInstance().destroy() } catch { /* noop */ }
  ;(LLMLoggerService as any).instance = undefined
  fs.rmSync(root, { recursive: true, force: true })
})

vi.mock('../../../electron/main/services/path.service', () => ({
  default: { getInstance: () => ({ getDataDir: () => root }) }
}))

const baseEntry = {
  type: 'chat' as const,
  source: 'workbench',
  model: 'gpt-4o',
  request: { messages: [{ role: 'user', content: '你好' }], stream: true },
}

/** 轮询等待条件成立（WriteStream 的文件创建/写入在后续 tick 执行） */
async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    try { if (predicate()) return } catch { /* retry */ }
    await new Promise<void>(r => setImmediate(r))
  }
  throw new Error('waitFor timeout')
}

function jsonlFiles(dir: string): string[] {
  const out: string[] = []
  function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(dir)
  return out
}

describe('LLMLoggerService', () => {
  it('无上下文：写入 _system.jsonl，行内含自动生成的 id/timestamp', async () => {
    const svc = LLMLoggerService.getInstance()
    svc.logCall(baseEntry)
    await waitFor(() => {
      const files = jsonlFiles(root)
      return files.length === 1 && files[0].endsWith('_system.jsonl') &&
        fs.readFileSync(files[0], 'utf-8').includes('"model"')
    })

    const files = jsonlFiles(root)
    expect(files).toHaveLength(1)
    expect(files[0].split(path.sep).slice(-2)).toEqual([expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), '_system.jsonl'])

    const row = JSON.parse(fs.readFileSync(files[0], 'utf-8').trim())
    expect(row.id).toBeTruthy()
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.type).toBe('chat')
    expect(row.model).toBe('gpt-4o')
    expect(row.context).toBeUndefined()
  })

  it('带员工+会话上下文：路径按日期/员工名/会话ID分流', async () => {
    const svc = LLMLoggerService.getInstance()
    svc.logCall(baseEntry, {
      employeeId: 'e1',
      employeeName: '小明',
      conversationId: 'conv-1',
    })
    await waitFor(() => jsonlFiles(root).length === 1)

    const files = jsonlFiles(root)
    expect(files).toHaveLength(1)
    const rel = path.relative(root, files[0]).split(path.sep)
    expect(rel[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(rel[3]).toBe('小明')
    expect(rel[4]).toBe('conv-1.jsonl')
  })

  it('员工名/会话ID 含文件系统非法字符时被替换为 _', async () => {
    const svc = LLMLoggerService.getInstance()
    svc.logCall(baseEntry, {
      employeeName: 'a:b/c',
      conversationId: 'x|y?z',
    })
    await waitFor(() => jsonlFiles(root).length === 1)
    const files = jsonlFiles(root)
    const rel = path.relative(root, files[0]).split(path.sep)
    expect(rel[3]).toBe('a_b_c')
    expect(rel[4]).toBe('x_y_z.jsonl')
  })

  it('runWithContext：回调内能取到上下文，外部取不到', () => {
    const svc = LLMLoggerService.getInstance()
    expect(svc.getCurrentContext()).toBeUndefined()
    svc.runWithContext({ employeeId: 'e9' }, () => {
      expect(svc.getCurrentContext()?.employeeId).toBe('e9')
    })
    expect(svc.getCurrentContext()).toBeUndefined()
  })

  it('同一目标文件多次记录复用同一 stream（一个文件两行）', async () => {
    const svc = LLMLoggerService.getInstance()
    svc.logCall(baseEntry)
    svc.logCall(baseEntry)

    await waitFor(() => {
      const files = jsonlFiles(root)
      return files.length === 1 && fs.readFileSync(files[0], 'utf-8').trim().split('\n').length >= 2
    })
    const files = jsonlFiles(root)
    const lines = fs.readFileSync(files[0], 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('logCall 内部异常被吞掉不外抛', () => {
    const svc = LLMLoggerService.getInstance()
    expect(() => svc.logCall(null as any)).not.toThrow()
  })
})
