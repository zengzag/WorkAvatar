import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Code Review 回归用例（第一阶段发现的问题 → 修复后锁定行为）。
 * 覆盖：file_read 空文件、MemoryManager 摘要空值兜底、LRUBoundedCache update 淘汰。
 */

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-review-'))
}

describe('file_read 边界（空文件不再报越界）', () => {
  it('读取 0 字符文件应成功返回空内容提示，而非「偏移量超出」错误', async () => {
    const { fileReadTool } = await import('../../../electron/main/services/agent/tools/fs-tools')
    const dir = makeTempDir()
    try {
      const empty = path.join(dir, 'empty.txt')
      fs.writeFileSync(empty, '', 'utf-8')
      const res: any = await fileReadTool.handler({ path: empty })
      expect(res.success).toBe(true)
      expect(String(res.output)).toContain('文件为空')
      // 空文件不应再输出误导性的行号内容
      expect(String(res.output)).not.toContain('1| ')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('真实越界偏移仍应报错', async () => {
    const { fileReadTool } = await import('../../../electron/main/services/agent/tools/fs-tools')
    const dir = makeTempDir()
    try {
      const f = path.join(dir, 'a.txt')
      fs.writeFileSync(f, 'hello', 'utf-8')
      const res: any = await fileReadTool.handler({ path: f, offset: 100 })
      expect(res.success).toBe(false)
      expect(String(res.error)).toContain('超出文件总字符数')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('正常文件返回带行号内容', async () => {
    const { fileReadTool } = await import('../../../electron/main/services/agent/tools/fs-tools')
    const dir = makeTempDir()
    try {
      const f = path.join(dir, 'b.txt')
      fs.writeFileSync(f, 'l1\nl2\nl3', 'utf-8')
      const res: any = await fileReadTool.handler({ path: f })
      expect(res.success).toBe(true)
      expect(String(res.output)).toContain('1| l1')
      expect(String(res.output)).toContain('3| l3')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MemoryManager 摘要空值兜底', () => {
  it('history 中存在 content 为 undefined 的消息时不抛错', async () => {
    const { MemoryManager } = await import('../../../electron/main/services/agent/memory/memory-manager')
    const mgr = new MemoryManager({ strategy: 'summary', maxTokens: 100, reservedResponseTokens: 10 })
    const history: any[] = [
      { role: 'user', content: undefined },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]
    const { stats } = await mgr.manageContext('sys', history, 'current', { forceCompress: true })
    expect(stats.wasCompressed).toBe(true)
  })

  it('空 content 与缺失 content 混用时 estimateTokens 不抛错', async () => {
    const { MemoryManager } = await import('../../../electron/main/services/agent/memory/memory-manager')
    const mgr = new MemoryManager()
    expect(() => mgr.estimateTokens([{ role: 'user', content: undefined } as any])).not.toThrow()
  })
})

describe('LRUBoundedCache.update 淘汰', () => {
  it('原地增量更新超出上限时按 LRU 淘汰，不突破 maxBytes', async () => {
    const { LRUBoundedCache } = await import('../../../electron/main/services/kms/lru-bounded-cache')
    // 每条约 100 字节，上限 250 字节
    const cache = new LRUBoundedCache<{ text: string }>(250, v => v.text.length)
    cache.set('a', { text: 'x'.repeat(100) })
    cache.set('b', { text: 'y'.repeat(100) })
    // 更新 a 膨胀到 200：总 300 > 250，应淘汰最旧的 b
    cache.update('a', v => { v.text = 'z'.repeat(200) })
    expect(cache.getBytes()).toBeLessThanOrEqual(250)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
  })

  it('单条超过上限时移除该条且字节数归零', async () => {
    const { LRUBoundedCache } = await import('../../../electron/main/services/kms/lru-bounded-cache')
    const cache = new LRUBoundedCache<{ text: string }>(50, v => v.text.length)
    cache.set('a', { text: 'x'.repeat(10) })
    cache.update('a', v => { v.text = 'y'.repeat(100) })
    expect(cache.has('a')).toBe(false)
    expect(cache.getBytes()).toBe(0)
  })

  it('更新视为最近使用：不会淘汰刚更新的条目', async () => {
    const { LRUBoundedCache } = await import('../../../electron/main/services/kms/lru-bounded-cache')
    const cache = new LRUBoundedCache<{ text: string }>(250, v => v.text.length)
    cache.set('a', { text: 'x'.repeat(100) })
    cache.set('b', { text: 'y'.repeat(100) })
    cache.update('a', v => { v.text = 'z'.repeat(120) })
    expect(cache.has('a')).toBe(true)
    expect(cache.getBytes()).toBeLessThanOrEqual(250)
  })
})

describe('pi-agent-adapter toolcall_delta 定位（多工具并发不串卡）', () => {
  // 首次动态 import 需编译 pi-agent-adapter 及 tools 全链（含 office 模块 require），并行 fork 冷启动可达数秒
  it('按 contentIndex 取对应工具调用，而非恒取第一个', { timeout: 20000 }, async () => {
    const { findToolCallByContentIndex } = await import(
      '../../../electron/main/services/agent/core/pi-agent-adapter'
    )
    // 模拟：thinking(0) + toolCall-A(1) + toolCall-B(2)
    const content = [
      { type: 'thinking', thinking: '...' },
      { type: 'toolCall', id: 'call_A', name: 'tool_a', arguments: {} },
      { type: 'toolCall', id: 'call_B', name: 'tool_b', arguments: {} },
    ]
    expect(findToolCallByContentIndex(content, 2)?.id).toBe('call_B')
    expect(findToolCallByContentIndex(content, 1)?.id).toBe('call_A')
    // 无前置文本时 index 0 直接命中
    expect(findToolCallByContentIndex([{ type: 'toolCall', id: 'call_C', name: 't', arguments: {} }], 0)?.id).toBe('call_C')
  })

  it('越界/类型不符时回退到第一个 toolCall（保持旧行为兜底）', async () => {
    const { findToolCallByContentIndex } = await import(
      '../../../electron/main/services/agent/core/pi-agent-adapter'
    )
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'toolCall', id: 'call_X', name: 'x', arguments: {} },
    ]
    expect(findToolCallByContentIndex(content, 99)?.id).toBe('call_X')
    expect(findToolCallByContentIndex(content, undefined)?.id).toBe('call_X')
    expect(findToolCallByContentIndex([], 0)).toBeUndefined()
  })
})

describe('renderer LRUCache 上限', () => {
  it('超过 maxSize 淘汰最久未使用条目', async () => {
    const { LRUCache } = await import('../../../src/utils/lru-cache')
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a') // a 变为最近使用
    cache.set('c', 3) // 淘汰 b
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.size).toBe(2)
  })
})

describe('path-normalize 边界补充', () => {
  it('isWithinPath 对空串安全', async () => {
    const { isWithinPath } = await import('../../../electron/main/services/path-normalize')
    expect(isWithinPath('', '')).toBe(false)
  })
})
