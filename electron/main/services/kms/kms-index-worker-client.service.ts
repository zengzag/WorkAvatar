import { Worker } from 'worker_threads'
import path from 'path'
import LLMClientService from '../llm-client.service'
import KMSSearchEngineService from './kms-search-engine.service'
import KMSDatabaseService from './kms-database.service'
import PathService from '../path.service'
import {
  type IndexProgress,
  type ProgressCallback,
} from './kms-index-manager.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-WorkerClient')

/**
 * Worker 线程批量索引客户端
 *
 * 把 KMS 的批量索引/合集深度处理任务委托给独立的 worker_thread 执行，
 * 避免 better-sqlite3 的同步 API 阻塞 Electron 主线程导致 UI 卡死。
 *
 * 设计要点：
 * 1. Worker 持有自己独立的 DB 连接（指向同一组 .db 文件），WAL 模式允许
 *    主线程读 + Worker 写并发。主线程在批量任务期间继续提供搜索/读取服务。
 * 2. Worker 启动时通过 workerData 接收预解密的 LLM API Key 映射，
 *    避免在 Worker 中依赖 electron.safeStorage（worker_threads 不可用）。
 * 3. Worker 完成任务后，主线程主动 invalidate 自身的搜索/向量缓存，
 *    让下一次查询从 DB 读取最新数据。
 * 4. Worker 初始化失败时降级为“主线程直接执行”，保证功能可用。
 */

type WorkerTask = 'buildFull' | 'incremental' | 'rebuildDir' | 'processCollectionDeep'

interface StartMessage {
  type: 'start'
  id: string
  task: WorkerTask
  args: any[]
}

interface WorkerDoneMessage {
  type: 'done'
  id: string
  result?: any
  error?: string
}

interface WorkerProgressMessage {
  type: 'progress'
  progress: IndexProgress
}

interface WorkerReadyMessage {
  type: 'ready'
}

interface WorkerFatalMessage {
  type: 'fatal'
  error: string
}

interface WorkerPongMessage {
  type: 'pong'
}

type WorkerResponse =
  | WorkerDoneMessage
  | WorkerProgressMessage
  | WorkerReadyMessage
  | WorkerFatalMessage
  | WorkerPongMessage

interface PendingTask {
  resolve: (value: any) => void
  reject: (reason: any) => void
  task: WorkerTask
}

class KMSIndexWorkerClientService {
  private static instance: KMSIndexWorkerClientService
  private worker: Worker | null = null
  private workerReady: boolean = false
  private workerFailed: boolean = false
  private pendingTasks: Map<string, PendingTask> = new Map()
  private taskIdCounter = 0
  private progressCallback: ProgressCallback | null = null

  private constructor() {}

  static getInstance(): KMSIndexWorkerClientService {
    if (!KMSIndexWorkerClientService.instance) {
      KMSIndexWorkerClientService.instance = new KMSIndexWorkerClientService()
    }
    return KMSIndexWorkerClientService.instance
  }

  /**
   * 设置全局进度回调（由 KMSService 注入，转发到 IPC 进度通道）
   */
  setProgressCallback(cb: ProgressCallback | null): void {
    this.progressCallback = cb
  }

  /**
   * 启动一个批量任务。如果 Worker 不可用，降级为主线程直接执行。
   */
  async runTask(
    task: WorkerTask,
    args: any[],
    fallback: () => Promise<any>,
  ): Promise<any> {
    // Worker 初始化失败过：直接走降级路径，避免每次都重试
    if (this.workerFailed) {
      return fallback()
    }

    try {
      const worker = await this.ensureWorker()
      const id = this.nextTaskId()
      const result = await new Promise<any>((resolve, reject) => {
        this.pendingTasks.set(id, { resolve, reject, task })
        const msg: StartMessage = { type: 'start', id, task, args }
        worker.postMessage(msg)
      })
      return result
    } catch (err: any) {
      logger.warn(`Worker task ${task} failed, falling back to main thread:`, err?.message || err)
      // 标记 Worker 不可用，后续任务直接走降级路径
      this.markWorkerFailed()
      return fallback()
    }
  }

  /**
   * 取消当前正在执行的索引任务（buildFull/incremental/rebuildDir）
   */
  cancelIndexing(): void {
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: 'cancel' })
    }
  }

  /**
   * 取消合集深度处理
   */
  cancelCollectionDeepProcess(): void {
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: 'cancelCollectionDeep' })
    }
  }

  /**
   * 主动销毁 Worker（用于应用退出或数据目录切换）
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      try {
        // 给 Worker 一个清理的机会
        this.worker.postMessage({ type: 'cancel' })
        await new Promise((r) => setTimeout(r, 100))
        await this.worker.terminate()
      } catch {}
      this.worker = null
      this.workerReady = false
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 内部实现
  // ════════════════════════════════════════════════════════════════

  private nextTaskId(): string {
    return `task-${++this.taskIdCounter}`
  }

  /**
   * 收集所有 LLM Provider 的解密后 API Key，用于 Worker 启动时注入
   */
  private async collectDecryptedApiKeys(): Promise<Record<string, string>> {
    const apiKeys: Record<string, string> = {}
    try {
      const llmClient = LLMClientService.getInstance()
      const providers = (llmClient as any).getProviderList?.() as any[] || []
      for (const p of providers) {
        try {
          const config = await llmClient.getProviderConfig(p.id)
          if (config?.api_key) {
            apiKeys[p.id] = config.api_key
          }
        } catch {}
      }
    } catch (err: any) {
      logger.warn('Failed to collect decrypted API keys for worker:', err?.message || err)
    }
    return apiKeys
  }

  /**
   * 确保 Worker 已启动并就绪。返回 Worker 实例。
   * 如果启动失败（如原生模块加载失败），抛出异常，调用方降级。
   */
  private async ensureWorker(): Promise<Worker> {
    if (this.worker && this.workerReady) return this.worker
    if (this.workerFailed) throw new Error('Worker marked as failed')

    // Worker 文件路径：dist-electron/main/kms-index-worker.js
    // 开发模式与生产模式下 __dirname 都指向主进程产物目录
    const workerPath = path.join(__dirname, 'kms-index-worker.js')

    const dataDir = PathService.getInstance().getDataDir()
    const apiKeys = await this.collectDecryptedApiKeys()

    logger.info(`Spawning KMS index worker: ${workerPath}`)

    const worker = new Worker(workerPath, {
      workerData: {
        dataDir,
        apiKeys,
      },
    })

    this.worker = worker

    return new Promise<Worker>((resolve, reject) => {
      const initTimeout = setTimeout(() => {
        reject(new Error('Worker init timeout (15s)'))
      }, 15000)

      const onMessage = (msg: WorkerResponse) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimeout)
          this.workerReady = true
          logger.info('KMS index worker ready')
          // 移除初始化监听器，挂上正式消息处理器
          worker.off('message', onMessage)
          worker.off('error', onError)
          worker.on('message', this.handleWorkerMessage.bind(this))
          worker.on('error', this.handleWorkerError.bind(this))
          worker.on('exit', this.handleWorkerExit.bind(this))
          resolve(worker)
        } else if (msg.type === 'fatal') {
          clearTimeout(initTimeout)
          reject(new Error(`Worker fatal: ${msg.error}`))
        }
      }

      const onError = (err: Error) => {
        clearTimeout(initTimeout)
        reject(err)
      }

      worker.on('message', onMessage)
      worker.on('error', onError)
    })
  }

  private markWorkerFailed(): void {
    this.workerFailed = true
    // 拒绝所有待处理任务
    for (const pending of this.pendingTasks.values()) {
      pending.reject(new Error('Worker unavailable'))
    }
    this.pendingTasks.clear()
    // 尝试终止 Worker
    if (this.worker) {
      this.worker.terminate().catch(() => {})
      this.worker = null
      this.workerReady = false
    }
  }

  private handleWorkerMessage(msg: WorkerResponse): void {
    if (msg.type === 'progress') {
      // 转发进度到全局回调（由 KMSService 注入）
      if (this.progressCallback) {
        try {
          this.progressCallback(msg.progress)
        } catch (err: any) {
          logger.warn('Progress callback error:', err?.message || err)
        }
      }
      return
    }

    if (msg.type === 'done') {
      const pending = this.pendingTasks.get(msg.id)
      if (!pending) {
        logger.warn(`Received done for unknown task ${msg.id}`)
        return
      }
      this.pendingTasks.delete(msg.id)

      // Worker 完成任务后，主线程的搜索/向量缓存可能与 Worker 的写入不一致，
      // 主动失效所有缓存，让下一次查询重新从 DB 加载
      try {
        KMSSearchEngineService.getInstance().invalidateCache()
        KMSDatabaseService.getInstance().checkpoint('PASSIVE')
      } catch (err: any) {
        logger.warn('Post-task cache invalidation/checkpoint failed:', err?.message || err)
      }

      if (msg.error) {
        pending.reject(new Error(msg.error))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.type === 'fatal') {
      logger.error('Worker fatal error:', msg.error)
      this.markWorkerFailed()
    }
  }

  private handleWorkerError(err: Error): void {
    logger.error('Worker error:', err?.message || err)
    this.markWorkerFailed()
  }

  private handleWorkerExit(code: number): void {
    if (code !== 0) {
      logger.warn(`Worker exited with code ${code}`)
    }
    this.worker = null
    this.workerReady = false
    // 如果还有待处理任务，说明是异常退出，拒绝它们
    for (const pending of this.pendingTasks.values()) {
      pending.reject(new Error(`Worker exited unexpectedly (code=${code})`))
    }
    this.pendingTasks.clear()
  }
}

export default KMSIndexWorkerClientService
