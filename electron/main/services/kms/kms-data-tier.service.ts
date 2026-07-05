import type Database from 'better-sqlite3'
import KMSDatabaseService from './kms-database.service'
import KMSCrawlerService from './kms-crawler.service'
import { createLogger } from '../logger'

const logger = createLogger('KMS-DataTier')

const HOT_PROMOTE_HIT_THRESHOLD = 5
const HOT_PROMOTE_READ_THRESHOLD = 3
const HOT_PROMOTE_DAYS = 30
const COLD_DEMOTE_DAYS = 90

class KMSDataTierService {
  private db: Database.Database
  private static instance: KMSDataTierService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSDataTierService {
    if (!KMSDataTierService.instance) {
      KMSDataTierService.instance = new KMSDataTierService()
    }
    return KMSDataTierService.instance
  }

  evaluateDataTiers(): void {
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
  }
}

export default KMSDataTierService
