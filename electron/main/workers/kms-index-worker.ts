import { parentPort, workerData } from 'worker_threads'
import KMSIndexManagerService, {
  type IndexProgress,
  type ProgressCallback,
} from '../services/kms/kms-index-manager.service'
import KMSSearchEngineService from '../services/kms/kms-search-engine.service'
import { createLogger } from '../services/logger'

const logger = createLogger('KMS-Worker')

/**
 * KMS 索引 Worker 消息协议
 *
 * 主线程 → Worker：
 *   { type: 'start', id, task, args }  启动一个批量任务
 *   { type: 'cancel' }                  取消索引任务（buildFull/incremental/rebuildDir）
 *   { type: 'cancelCollectionDeep' }    取消合集深度处理
 *   { type: 'ping' }                    健康检查
 *
 * Worker → 主线程：
 *   { type: 'progress', progress }      进度推送
 *   { type: 'done', id, result?, error? } 任务完成（成功或失败）
 *   { type: 'pong' }                    健康检查响应
 *   { type: 'ready' }                   Worker 初始化完成
 *   { type: 'fatal', error }            Worker 初始化失败
 */

interface StartMessage {
  type: 'start'
  id: string
  task: 'buildFull' | 'incremental' | 'rebuildDir' | 'processCollectionDeep' | 'processPromotedFiles'
  args: any[]
}

interface CancelMessage {
  type: 'cancel'
}

interface CancelCollectionMessage {
  type: 'cancelCollectionDeep'
}

interface CancelPromotionMessage {
  type: 'cancelPromotion'
}

interface PingMessage {
  type: 'ping'
}

type WorkerMessage = StartMessage | CancelMessage | CancelCollectionMessage | CancelPromotionMessage | PingMessage

interface WorkerData {
  dataDir: string
  apiKeys: Record<string, string>
}

const data = workerData as WorkerData
if (!data?.dataDir) {
  // 初始化失败：直接退出
  process.exit(1)
}

/**
 * Worker 初始化：触发所有 KMS 单例服务的创建。
 *
 * 由于 PathService 已在 worker 模式下从 workerData.dataDir 读取路径，
 * LLMClientService 在 worker 模式下从 workerData.apiKeys 读取预解密的 API Key，
 * 这里只需要 getInstance() 即可完成数据库连接、sqlite-vec 加载等初始化工作。
 */
let ready = false
try {
  // 预先初始化所有需要的单例
  KMSIndexManagerService.getInstance()
  ready = true
  parentPort?.postMessage({ type: 'ready' })
  logger.info('KMS index worker ready')
} catch (err: any) {
  logger.error('KMS index worker init failed:', err?.message || err)
  parentPort?.postMessage({ type: 'fatal', error: err?.message || String(err) })
  // 给主线程时间接收 fatal 消息再退出
  setTimeout(() => process.exit(1), 100)
}

/**
 * 进度转发：Worker 内的 KMSIndexManagerService 通过 onProgress 回调推送进度，
 * 这里把进度通过 parentPort 转发给主线程的 worker client。
 */
const progressForwarder: ProgressCallback = (progress: IndexProgress) => {
  parentPort?.postMessage({ type: 'progress', progress })
}

/**
 * Worker 内部晋升处理专用 AbortController
 *
 * 主线程通过 'cancelPromotion' 消息触发 abort，
 * Worker 内的 processPromotedFiles 通过 signal 感知取消并优雅退出。
 */
let promotionAbort: AbortController | null = null

parentPort?.on('message', async (msg: WorkerMessage) => {
  if (!ready) {
    if ((msg as any).type === 'ping') {
      parentPort?.postMessage({ type: 'pong' })
    }
    return
  }

  try {
    if (msg.type === 'ping') {
      parentPort?.postMessage({ type: 'pong' })
      return
    }

    if (msg.type === 'cancel') {
      KMSIndexManagerService.getInstance().cancelIndexing()
      return
    }

    if (msg.type === 'cancelCollectionDeep') {
      KMSIndexManagerService.getInstance().cancelCollectionDeepProcess()
      return
    }

    if (msg.type === 'cancelPromotion') {
      // 取消 Worker 内正在进行的晋升处理
      if (promotionAbort) {
        promotionAbort.abort()
        logger.info('Promotion cancelled by main thread')
      }
      return
    }

    if (msg.type === 'start') {
      const { id, task, args } = msg
      try {
        let result: any
        switch (task) {
          case 'buildFull':
            await KMSIndexManagerService.getInstance().buildFullIndex(
              args[0], progressForwarder, args[1] ?? true, args[2] ?? false,
            )
            result = undefined
            break
          case 'incremental':
            await KMSIndexManagerService.getInstance().incrementalIndex(
              args[0], progressForwarder, args[1] ?? true,
            )
            result = undefined
            break
          case 'rebuildDir':
            await KMSIndexManagerService.getInstance().rebuildDirIndex(
              args[0], args[1], progressForwarder, args[2] ?? true, args[3] ?? false,
            )
            result = undefined
            break
          case 'processCollectionDeep':
            result = await KMSIndexManagerService.getInstance().processCollectionDeep(
              args[0], progressForwarder,
            )
            break
          case 'processPromotedFiles':
            // 冷数据晋升处理：在 Worker 执行避免 file2md 同步解析阻塞主线程 UI
            promotionAbort = new AbortController()
            try {
              await KMSIndexManagerService.getInstance().processPromotedFilesPublic(
                args[0], promotionAbort.signal,
              )
            } finally {
              promotionAbort = null
            }
            result = undefined
            break
          default:
            throw new Error(`Unknown task: ${task}`)
        }
        // 任务完成：通知主线程，并触发主线程缓存失效
        parentPort?.postMessage({ type: 'done', id, result })
      } catch (err: any) {
        logger.error(`Worker task ${task} failed:`, err?.message || err)
        parentPort?.postMessage({ type: 'done', id, error: err?.message || String(err) })
      }
      return
    }
  } catch (err: any) {
    logger.error('Worker message handler error:', err?.message || err)
  }
})

/**
 * Worker 退出清理：关闭数据库连接。
 * Node 会在 process.exit 时自动清理，但显式关闭可以避免 WAL 未 checkpoint 的问题。
 */
process.on('exit', () => {
  try {
    KMSSearchEngineService.getInstance().invalidateCache()
  } catch {}
})

// 捕获未处理异常，避免 Worker 静默崩溃
process.on('uncaughtException', (err) => {
  logger.error('Worker uncaughtException:', err?.message || err)
  parentPort?.postMessage({ type: 'fatal', error: err?.message || String(err) })
  setTimeout(() => process.exit(1), 100)
})
