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
import { createLogger, LoggerBackend } from '../logger'

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

type WorkerTask = 'buildFull' | 'incremental' | 'rebuildDir' | 'processCollectionDeep' | 'processSingleFileDeep' | 'processPromotedFiles' | 'autoIndexCheck'

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
   * 增加任务级超时：Worker 任务挂起时（如原生模块在打包环境卡死），
   * 主动 reject 并降级，避免 pendingTasks 永久驻留、autoIndexRunning 永久为 true。
   *
   * 超时策略区分：
   * - 任务超时（timed out）：仅拒绝当前 Promise，不标记 Worker 失败。
   *   Worker 可能仍在运行（大库索引耗时超过预期），后续任务可继续使用 Worker。
   * - Worker 初始化失败 / fatal 错误 / Worker 异常退出：标记 Worker 永久失败，
   *   后续任务直接走主线程降级路径。
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
      // autoIndexCheck 包含爬虫+解析+LLM+embedding，可能很慢，给 30 分钟
      // 其他批量索引任务给 30 分钟
      const timeoutMs = task === 'autoIndexCheck' ? 30 * 60 * 1000 : 30 * 60 * 1000
      logger.info(`Dispatching worker task "${task}" (id=${id}, timeout=${timeoutMs / 1000}s)`)
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pendingTasks.has(id)) {
            this.pendingTasks.delete(id)
            // 超时后向 Worker 发送 cancel 消息，避免 Worker 被超时任务永久阻塞
            // 否则 Worker 事件循环被占用，后续任务 postMessage 也无法被处理
            this.sendCancelForTask(task)
            logger.warn(`Worker task ${task} (id=${id}) timed out after ${timeoutMs / 1000}s — cancel sent to worker, task rejected`)
            reject(new Error(`Worker task ${task} timed out after ${timeoutMs / 1000}s`))
          }
        }, timeoutMs)
        this.pendingTasks.set(id, {
          resolve: (v: any) => { clearTimeout(timer); resolve(v) },
          reject: (e: any) => { clearTimeout(timer); reject(e) },
          task,
        })
        const msg: StartMessage = { type: 'start', id, task, args }
        worker.postMessage(msg)
      })
      return result
    } catch (err: any) {
      const isTimeout = err?.message?.includes?.('timed out')
      if (isTimeout) {
        // 超时：仅 reject 当前任务，Worker 仍可能存活，不标记失败
        logger.warn(`Worker task ${task} timed out, rejecting task without marking worker as failed:`, err?.message || err)
      } else {
        // Worker 初始化失败 / 其他错误：标记 Worker 不可用
        logger.warn(`Worker task ${task} failed (non-timeout), marking worker as failed:`, err?.message || err)
        this.markWorkerFailed()
      }
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
   * 取消冷热数据晋升处理（Worker 内执行的 processPromotedFiles）
   */
  cancelPromotion(): void {
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: 'cancelPromotion' })
    }
  }

  /**
   * 取消 Worker 内正在执行的自动索引检查
   */
  cancelAutoIndex(): void {
    if (this.worker && this.workerReady) {
      this.worker.postMessage({ type: 'cancelAutoIndex' })
    }
  }

  /**
   * 根据任务类型发送对应的 cancel 消息到 Worker（超时时调用）
   */
  private sendCancelForTask(task: WorkerTask): void {
    if (!this.worker || !this.workerReady) return
    try {
      switch (task) {
        case 'buildFull':
        case 'incremental':
        case 'rebuildDir':
          this.worker.postMessage({ type: 'cancel' })
          break
        case 'processCollectionDeep':
        case 'processSingleFileDeep':
          this.worker.postMessage({ type: 'cancelCollectionDeep' })
          break
        case 'processPromotedFiles':
          this.worker.postMessage({ type: 'cancelPromotion' })
          break
        case 'autoIndexCheck':
          this.worker.postMessage({ type: 'cancelAutoIndex' })
          break
      }
    } catch (err: any) {
      logger.warn(`sendCancelForTask(${task}) failed:`, err?.message || err)
    }
  }

  /**
   * 主动销毁 Worker（用于应用退出或数据目录切换）
   *
   * 必须先拒绝所有 pending 任务，否则调用方 await 的 Promise 会永久挂起。
   * 应用退出场景下，未拒绝的 pending 会导致退出流程卡住。
   */
  async terminate(): Promise<void> {
    // 先拒绝所有待处理任务，避免调用方永久 await
    for (const pending of this.pendingTasks.values()) {
      pending.reject(new Error('Worker terminated'))
    }
    this.pendingTasks.clear()

    if (this.worker) {
      try {
        // 给 Worker 一个清理的机会
        this.worker.postMessage({ type: 'cancel' })
        await new Promise((r) => setTimeout(r, 100))
        await this.worker.terminate()
      } catch (err: any) {
        logger.warn('Failed to terminate index worker gracefully:', err?.message || err)
      }
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
        } catch (err: any) {
          logger.warn(`Failed to decrypt API key for provider ${p.id}:`, err?.message || err)
        }
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
    // 主进程判断的 isDev 透传给 worker，避免 worker 中访问 electron.app.isPackaged
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const isDev = !require('electron').app.isPackaged
    // 透传当前日志文件路径，让 Worker 复用同一文件，避免日志碎片化
    const logFilePath = LoggerBackend.getInstance().getLogFilePath()

    logger.info(`Spawning KMS index worker: ${workerPath}`)

    const worker = new Worker(workerPath, {
      workerData: {
        dataDir,
        apiKeys,
        isDev,
        logFilePath,
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
