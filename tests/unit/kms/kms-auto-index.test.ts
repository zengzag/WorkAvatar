import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Module from 'module'

const state = vi.hoisted(() => ({
  crawlResult: { newFiles: 0, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0 } as any,
  crawlError: null as any,
  pendingFiles: [] as any[],
  runTaskResult: null as any,
  runTaskError: null as any,
  runTaskCalls: [] as any[],
  cancelAutoIndexCalls: 0,
}))

vi.mock('../../../electron/main/services/kms/kms-crawler.service', () => ({
  default: {
    getInstance: () => ({
      crawlAllDirectories: async () => {
        if (state.crawlError) throw state.crawlError
        return state.crawlResult
      },
      getPendingFiles: () => state.pendingFiles,
      updateFileStatus: vi.fn(),
    }),
  },
}))

vi.mock('../../../electron/main/services/kms/kms-search-engine.service', () => ({
  default: { getInstance: () => ({}) },
}))

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: { getInstance: () => ({ runInTransaction: (fn: any) => fn(), checkpoint: vi.fn() }) },
}))

vi.mock('../../../electron/main/services/file-parser.service', () => ({
  default: { getInstance: () => ({ parseFilePath: vi.fn() }) },
}))

vi.mock('../../../electron/main/services/llm-client.service', () => ({
  default: { getInstance: () => ({}) },
}))

import KMSAutoIndexService from '../../../electron/main/services/kms/kms-auto-index.service'

const svc = KMSAutoIndexService.getInstance()

const workerClient = {
  runTask: vi.fn(async (task: string, args: any[], fallback: () => Promise<any>) => {
    state.runTaskCalls.push({ task, args })
    if (state.runTaskError) throw state.runTaskError
    return state.runTaskResult
  }),
  cancelAutoIndex: vi.fn(() => { state.cancelAutoIndexCalls++ }),
}

const origModuleLoad = (Module as any)._load

function installWorkerClientMock() {
  ;(Module as any)._load = function (this: any, request: string, parent: any, isMain: boolean) {
    if (typeof request === 'string' && request.includes('kms-index-worker-client.service')) {
      return { default: { getInstance: () => workerClient } }
    }
    return origModuleLoad.call(this, request, parent, isMain)
  }
}

function restoreModuleLoad() {
  ;(Module as any)._load = origModuleLoad
}

beforeEach(() => {
  installWorkerClientMock()
  state.crawlResult = { newFiles: 0, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0 }
  state.crawlError = null
  state.pendingFiles = []
  state.runTaskCalls.length = 0
  state.runTaskResult = null
  state.runTaskError = null
  workerClient.runTask.mockClear()
  workerClient.cancelAutoIndex.mockClear()
  svc.setProgressCallback(null)
  svc.stop()
  svc.setAbortController(null)
  ;(svc as any).autoIndexRunning = false
  ;(svc as any).autoIndexLastRunAt = null
  ;(svc as any).autoIndexLastResult = null
  state.cancelAutoIndexCalls = 0
})

afterEach(() => {
  vi.useRealTimers()
  restoreModuleLoad()
})

describe('kms-auto-index / getStatus 与定时器管理', () => {
  it('默认状态：未运行、未执行过、nextRunAt 为 null', () => {
    const status = svc.getStatus()
    expect(status.running).toBe(false)
    expect(status.lastRunAt).toBeNull()
    expect(status.nextRunAt).toBeNull()
    expect(status.lastResult).toBeNull()
    expect(status.config).toEqual({ enabled: false, intervalMinutes: 1, stableThresholdMinutes: 5 })
  })

  it('getStatus 返回配置副本，外部修改不影响内部状态', () => {
    svc.start({ enabled: true, intervalMinutes: 10, stableThresholdMinutes: 2 })
    const status = svc.getStatus()
    status.config.intervalMinutes = 999
    expect(svc.getStatus().config.intervalMinutes).toBe(10)
    svc.stop()
  })

  it('enabled=false 时只保存配置不启动定时器', async () => {
    vi.useFakeTimers()
    svc.start({ enabled: false, intervalMinutes: 1, stableThresholdMinutes: 5 })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(state.runTaskCalls).toHaveLength(0)
    expect(svc.getStatus().config.enabled).toBe(false)
  })

  it('intervalMinutes 为 0 时按最小 1 分钟兜底触发', async () => {
    vi.useFakeTimers()
    svc.start({ enabled: true, intervalMinutes: 0, stableThresholdMinutes: 5 })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(state.runTaskCalls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(state.runTaskCalls).toHaveLength(1)
    expect(state.runTaskCalls[0].task).toBe('autoIndexCheck')
    svc.stop()
  })

  it('重复 start 会重置定时器而不是叠加', async () => {
    vi.useFakeTimers()
    const config = { enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 }
    svc.start(config)
    svc.start(config)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.runTaskCalls).toHaveLength(1)
    svc.stop()
  })

  it('stop 清除定时器并取消当前运行', async () => {
    vi.useFakeTimers()
    svc.start({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })
    svc.setAbortController(new AbortController())
    svc.stop()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(state.runTaskCalls).toHaveLength(0)
    expect(state.cancelAutoIndexCalls).toBe(1)
    expect(svc.getAbortController()).toBeNull()
  })

  it('cancelCurrentRun 在无 controller 时不抛错且仍通知 Worker', () => {
    expect(() => svc.cancelCurrentRun()).not.toThrow()
    expect(state.cancelAutoIndexCalls).toBe(1)
  })

  it('cancelCurrentRun 会 abort 并清空 controller', () => {
    const controller = new AbortController()
    svc.setAbortController(controller)
    svc.cancelCurrentRun()
    expect(controller.signal.aborted).toBe(true)
    expect(svc.getAbortController()).toBeNull()
  })
})

describe('kms-auto-index / runCheck', () => {
  it('已在运行时跳过并推送进度（避免前端无反馈）', async () => {
    ;(svc as any).autoIndexRunning = true
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    await svc.runCheck()
    expect(state.runTaskCalls).toHaveLength(0)
    expect(progress).toHaveLength(1)
    expect(progress[0].phase).toBe('done')
    expect(progress[0].message).toContain('正在运行中')
  })

  it('成功后记录 lastRunAt 与 lastResult', async () => {
    state.runTaskResult = { newFiles: 2, modifiedFiles: 1, deletedFiles: 0, skippedUnstableFiles: 3 }
    const before = Math.floor(Date.now() / 1000)
    await svc.runCheck()
    const after = Math.floor(Date.now() / 1000)
    const status = svc.getStatus()
    expect(status.lastRunAt).toBeGreaterThanOrEqual(before)
    expect(status.lastRunAt).toBeLessThanOrEqual(after)
    expect(status.lastResult).toEqual(state.runTaskResult)
    expect(status.running).toBe(false)
  })

  it('Worker 返回 null 时保留上一次 lastResult 但刷新 lastRunAt', async () => {
    state.runTaskResult = { newFiles: 1, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0 }
    await svc.runCheck()
    state.runTaskResult = null
    await svc.runCheck()
    expect(svc.getStatus().lastResult).toEqual({ newFiles: 1, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0 })
    expect(svc.getStatus().lastRunAt).not.toBeNull()
  })

  it('Worker 异常时推送 error 进度且不残留运行标记', async () => {
    state.runTaskError = new Error('worker exploded')
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    await svc.runCheck()
    expect(progress).toHaveLength(1)
    expect(progress[0].phase).toBe('error')
    expect(progress[0].message).toBe('worker exploded')
    expect(svc.getRunning()).toBe(false)
  })

  it('成功执行后 running 标记复位（幂等可重复调用）', async () => {
    await svc.runCheck()
    await svc.runCheck()
    expect(state.runTaskCalls).toHaveLength(2)
    expect(svc.getRunning()).toBe(false)
  })
})

describe('kms-auto-index / runCheckInternal', () => {
  it('已有 abortController 时视为进行中，返回 null', async () => {
    svc.setAbortController(new AbortController())
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    const out = await svc.runCheckInternal({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })
    expect(out).toBeNull()
    expect(progress[0].message).toContain('正在运行中')
  })

  it('无变更时返回爬虫统计并推送完成进度', async () => {
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    const out = await svc.runCheckInternal({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })
    expect(out).toEqual({ newFiles: 0, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0 })
    expect(progress.map(p => p.phase)).toEqual(['crawling', 'done'])
    expect(progress[1].message).toBe('未检测到文件变更')
    expect(svc.getAbortController()).toBeNull()
  })

  it('仅存在删除时推送清理数量', async () => {
    state.crawlResult = { newFiles: 0, modifiedFiles: 0, deletedFiles: 3, skippedUnstableFiles: 1 }
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    const out = await svc.runCheckInternal({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })
    expect(out).toEqual({ newFiles: 0, modifiedFiles: 0, deletedFiles: 3, skippedUnstableFiles: 1 })
    expect(progress[progress.length - 1].message).toBe('已清理 3 个已删除文件的索引')
  })

  it('爬虫阶段失败时推送 error 并返回 null，同时复位 controller', async () => {
    state.crawlError = new Error('crawl failed')
    const progress: any[] = []
    svc.setProgressCallback(p => progress.push(p))
    const out = await svc.runCheckInternal({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })
    expect(out).toBeNull()
    expect(progress.some(p => p.phase === 'error' && p.message === 'crawl failed')).toBe(true)
    expect(svc.getAbortController()).toBeNull()
  })

  it('无进度回调时不抛错', async () => {
    svc.setProgressCallback(null)
    await expect(svc.runCheckInternal({ enabled: true, intervalMinutes: 1, stableThresholdMinutes: 5 })).resolves.toEqual({
      newFiles: 0, modifiedFiles: 0, deletedFiles: 0, skippedUnstableFiles: 0,
    })
  })
})
