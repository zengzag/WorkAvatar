import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ScheduledTaskBase } from '../../../electron/main/services/scheduled-task-base'

class TestTask extends ScheduledTaskBase {
  runCount = 0
  shouldFail = false
  protected async runCheck(): Promise<void> {
    this.runCount++
    if (this.shouldFail) throw new Error('check failed')
  }
}

describe('scheduled-task-base', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start 后立即执行一次并按间隔重复', async () => {
    const task = new TestTask('t', 1000)
    task.start()
    // start 内同步调用 runCheck（async 但内部无 await），等待微任务
    await Promise.resolve()
    expect(task.runCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(task.runCount).toBe(3) // 0ms + 1000ms + 2000ms
    task.stop()
  })

  it('runCheck 抛错不影响下一次调度', async () => {
    const task = new TestTask('t', 100)
    task.shouldFail = true
    task.start()
    await vi.advanceTimersByTimeAsync(350)
    expect(task.runCount).toBe(4)
    task.stop()
  })

  it('并发防护：上一次未完成时不重复执行', async () => {
    let resolveFirst: () => void = () => {}
    class SlowTask extends ScheduledTaskBase {
      runCount = 0
      protected async runCheck(): Promise<void> {
        this.runCount++
        await new Promise<void>(r => { resolveFirst = r })
      }
    }
    const task = new SlowTask('t', 50)
    task.start()
    await Promise.resolve()
    expect(task.runCount).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(task.runCount).toBe(1)
    resolveFirst()
    await Promise.resolve()
    task.stop()
  })

  it('triggerNow 在未启动时不执行', async () => {
    const task = new TestTask('t', 1000)
    await task.triggerNow()
    expect(task.runCount).toBe(0)
  })

  it('triggerNow 立即执行一次', async () => {
    const task = new TestTask('t', 100000)
    task.start()
    await vi.advanceTimersByTimeAsync(0) // flush start 那次的微任务链
    const n = task.runCount
    await task.triggerNow()
    expect(task.runCount).toBe(n + 1)
    task.stop()
  })

  it('stop 后 isRunning=false 且不再调度', async () => {
    const task = new TestTask('t', 100)
    task.start()
    expect(task.isRunning()).toBe(true)
    task.stop()
    expect(task.isRunning()).toBe(false)
    const n = task.runCount
    await vi.advanceTimersByTimeAsync(500)
    expect(task.runCount).toBe(n)
  })

  it('重复 start 先清理旧定时器', async () => {
    const task = new TestTask('t', 100)
    task.start()
    task.start()
    await vi.advanceTimersByTimeAsync(150)
    // 若旧定时器未清理会执行更多次
    expect(task.runCount).toBeLessThanOrEqual(3)
    task.stop()
  })
})
