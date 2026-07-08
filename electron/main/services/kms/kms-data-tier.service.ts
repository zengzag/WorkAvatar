import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-DataTier')

// 晋升阈值：需要足够高的使用频率才升级为热数据，避免一搜索就变热数据
// 命中阈值 15 次：30天内被搜索命中 15 次以上才晋升（约每两天命中 1 次）
const HOT_PROMOTE_HIT_THRESHOLD = 15
// 读取阈值 8 次：30天内被读取 8 次以上才晋升（读取权重高于命中）
const HOT_PROMOTE_READ_THRESHOLD = 8
const HOT_PROMOTE_DAYS = 30
const COLD_DEMOTE_DAYS = 90

/** 搜索触发的冷热评估最小间隔（5分钟），避免频繁搜索时反复评估 */
const MIN_EVALUATION_INTERVAL_MS = 5 * 60 * 1000

export interface DataTierEvaluationResult {
  promotedFileIds: string[]
  demotedFileIds: string[]
}

class KMSDataTierService {
  private db: Database.Database
  private static instance: KMSDataTierService
  /** 上次评估时间戳（毫秒），用于搜索触发的去抖 */
  private lastEvaluationAt: number = 0

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSDataTierService {
    if (!KMSDataTierService.instance) {
      KMSDataTierService.instance = new KMSDataTierService()
    }
    return KMSDataTierService.instance
  }

  /**
   * 评估冷热数据层级，返回需要晋升/降级的文件ID列表
   *
   * @param force 是否强制评估（忽略去抖间隔）。索引流程结束后应传 true；
   *              搜索触发的评估传 false，受 MIN_EVALUATION_INTERVAL_MS 去抖控制
   * @returns 晋升的文件ID列表（cold→hot）和降级的文件ID列表（hot→cold）
   */
  evaluateDataTiers(force: boolean = false): DataTierEvaluationResult {
    // 去抖：非强制模式下，5分钟内不重复评估
    if (!force) {
      const elapsed = Date.now() - this.lastEvaluationAt
      if (elapsed < MIN_EVALUATION_INTERVAL_MS) {
        return { promotedFileIds: [], demotedFileIds: [] }
      }
    }
    this.lastEvaluationAt = Date.now()

    const crawler = KMSCrawlerService.getInstance()
    const now = Math.floor(Date.now() / 1000)

    const hotFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'hot'").all() as any[]
    const hotFileIds = hotFiles.map(f => f.id)

    const demoteIds: string[] = []
    const coldThreshold = now - COLD_DEMOTE_DAYS * 86400
    if (hotFileIds.length > 0) {
      const statsMap = crawler.getFileAccessStatsBatch(hotFileIds, COLD_DEMOTE_DAYS)
      for (const fileId of hotFileIds) {
        const stats = statsMap.get(fileId)!
        if (stats.lastAccessed && stats.lastAccessed < coldThreshold) {
          demoteIds.push(fileId)
        }
      }
    }

    const coldFiles = this.db.prepare("SELECT id FROM kms_files WHERE data_tier = 'cold'").all() as any[]
    const coldFileIds = coldFiles.map(f => f.id)

    const promoteIds: string[] = []
    if (coldFileIds.length > 0) {
      const statsMap = crawler.getFileAccessStatsBatch(coldFileIds, HOT_PROMOTE_DAYS)
      for (const fileId of coldFileIds) {
        const stats = statsMap.get(fileId)!
        if (stats.hitCount >= HOT_PROMOTE_HIT_THRESHOLD || stats.readCount >= HOT_PROMOTE_READ_THRESHOLD) {
          promoteIds.push(fileId)
        }
      }
    }

    const updateTierBatch = (ids: string[], tier: 'cold' | 'hot') => {
      if (ids.length === 0) return
      const tx = this.db.transaction((fileIds: string[], targetTier: string) => {
        const placeholders = fileIds.map(() => '?').join(',')
        this.db.prepare(
          `UPDATE kms_files SET data_tier = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`
        ).run(targetTier, ...fileIds)
      })
      tx(ids, tier)
    }

    if (demoteIds.length > 0) {
      updateTierBatch(demoteIds, 'cold')
      logger.info(`Demoted ${demoteIds.length} file(s) from hot to cold (no access in ${COLD_DEMOTE_DAYS} days)`)
    }
    if (promoteIds.length > 0) {
      updateTierBatch(promoteIds, 'hot')
      logger.info(`Promoted ${promoteIds.length} file(s) from cold to hot`)
    }

    return { promotedFileIds: promoteIds, demotedFileIds: demoteIds }
  }
}

export default KMSDataTierService
