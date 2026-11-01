import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  registerResumableRun,
  getResumableRun,
  takeResumableRun,
  clearResumableRun,
} from '../../../electron/main/services/agent/core/resumable-runs'

const makeRun = (conversationId: string) => ({
  conversationId,
  createdAt: Date.now(),
  resume: vi.fn(async () => {}),
})

describe('resumable-runs / 原地续跑登记', () => {
  beforeEach(() => {
    clearResumableRun('conv_a')
    clearResumableRun('conv_b')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('按会话读写；同一会话再次登记时覆盖为最新句柄', () => {
    const first = makeRun('conv_a')
    const second = makeRun('conv_a')
    registerResumableRun(first)
    expect(getResumableRun('conv_a')).toBe(first)
    registerResumableRun(second)
    expect(getResumableRun('conv_a')).toBe(second)
  })

  it('take 只能取一次（续跑互斥）', () => {
    const run = makeRun('conv_a')
    registerResumableRun(run)
    expect(takeResumableRun('conv_a')).toBe(run)
    expect(takeResumableRun('conv_a')).toBeUndefined()
  })

  it('超过 TTL 的登记被丢弃，避免长期持有窗口引用', () => {
    vi.useFakeTimers()
    const run = makeRun('conv_b')
    run.createdAt = Date.now() - 31 * 60 * 1000
    registerResumableRun(run)
    expect(getResumableRun('conv_b')).toBeUndefined()
  })
})
