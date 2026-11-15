import { describe, it, expect } from 'vitest'
import { dockPeekForStatus } from '../../../src/components/secretary/secretary-dock-peek'

/**
 * 贴边弹出状态机：
 * - 任务开始 / 等待 / 完成失败时弹出
 * - 面板轮询重复广播同一个 done 时不再弹
 * - 没有任务时收到迟到 / 重复的 done 不弹
 */

describe('dockPeekForStatus', () => {
  it('任务开始执行时弹出', () => {
    expect(dockPeekForStatus('idle', 'running')).toBe('running')
    expect(dockPeekForStatus('done', 'running')).toBe('running')
  })

  it('等待确认时弹出', () => {
    expect(dockPeekForStatus('running', 'waiting')).toBe('waiting')
    expect(dockPeekForStatus('idle', 'waiting')).toBe('waiting')
  })

  it('执行 / 等待结束后弹出完成或失败', () => {
    expect(dockPeekForStatus('running', 'done')).toBe('terminal')
    expect(dockPeekForStatus('running', 'failed')).toBe('terminal')
    expect(dockPeekForStatus('waiting', 'done')).toBe('terminal')
    expect(dockPeekForStatus('waiting', 'failed')).toBe('terminal')
  })

  it('重复广播同一个完成状态不再弹出', () => {
    expect(dockPeekForStatus('done', 'done')).toBeNull()
    expect(dockPeekForStatus('failed', 'failed')).toBeNull()
  })

  it('空闲时迟到的完成态不弹', () => {
    expect(dockPeekForStatus('idle', 'done')).toBeNull()
    expect(dockPeekForStatus('idle', 'failed')).toBeNull()
    expect(dockPeekForStatus('done', 'failed')).toBeNull()
  })
})
