import type Database from 'better-sqlite3'
import { createLogger } from '../logger'
import { generateId } from '../common-utils'
import KMSDatabaseService from './kms-database.service'

const logger = createLogger('KMS-ContentVersion')

class KMSContentVersionService {
  private db: Database.Database
  private static instance: KMSContentVersionService

  private constructor() {
    this.db = KMSDatabaseService.getInstance().getDb()
  }

  static getInstance(): KMSContentVersionService {
    if (!KMSContentVersionService.instance) {
      KMSContentVersionService.instance = new KMSContentVersionService()
    }
    return KMSContentVersionService.instance
  }

  ensureForFile(fileId: string): string {
    const file = this.db.prepare(`
      SELECT id, file_hash, file_size, content_version_id, file_path
      FROM kms_files WHERE id = ?
    `).get(fileId) as any
    if (!file?.file_hash) return ''

    const existing = this.db.prepare(
      'SELECT id FROM kms_content_versions WHERE exact_hash = ?'
    ).get(file.file_hash) as any

    let versionId = existing?.id as string | undefined
    if (!versionId) {
      versionId = generateId()
      this.db.prepare(`
        INSERT INTO kms_content_versions (
          id, exact_hash, canonical_file_id, file_size, status,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 'active', unixepoch(), unixepoch())
      `).run(versionId, file.file_hash, fileId, file.file_size || 0)
    } else {
      this.db.prepare(`
        UPDATE kms_content_versions
        SET last_seen_at = unixepoch(),
            canonical_file_id = COALESCE(canonical_file_id, ?),
            file_size = CASE WHEN ? > 0 THEN ? ELSE file_size END
        WHERE id = ?
      `).run(fileId, file.file_size || 0, file.file_size || 0, versionId)
    }

    if (file.content_version_id !== versionId) {
      this.db.prepare('UPDATE kms_files SET content_version_id = ? WHERE id = ?').run(versionId, fileId)
    }
    this.db.prepare(`
      UPDATE kms_search_index
      SET content_version_id = ?
      WHERE file_id = ? AND COALESCE(content_version_id, '') != ?
    `).run(versionId, fileId, versionId)
    return versionId
  }

  backfillBatch(limit: number = 1000): { processed: number; versions: number } {
    const rows = this.db.prepare(`
      SELECT id, file_hash, file_size
      FROM kms_files
      WHERE COALESCE(content_version_id, '') = '' AND file_hash != ''
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as any[]

    let versions = 0
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const existing = this.db.prepare(
          'SELECT id FROM kms_content_versions WHERE exact_hash = ?'
        ).get(row.file_hash) as any
        let versionId: string
        if (existing) {
          versionId = existing.id
        } else {
          versionId = generateId()
          versions++
          this.db.prepare(`
            INSERT INTO kms_content_versions (
              id, exact_hash, canonical_file_id, file_size, status,
              first_seen_at, last_seen_at
            ) VALUES (?, ?, ?, ?, 'active', unixepoch(), unixepoch())
          `).run(versionId, row.file_hash, row.id, row.file_size || 0)
        }
        this.db.prepare('UPDATE kms_files SET content_version_id = ? WHERE id = ?').run(versionId, row.id)
        this.db.prepare('UPDATE kms_search_index SET content_version_id = ? WHERE file_id = ?').run(versionId, row.id)
      }
    })
    tx()

    logger.info(`Content version backfill processed=${rows.length}, newVersions=${versions}`)
    return { processed: rows.length, versions }
  }

  getStats(): { filesMissingVersion: number; contentVersions: number; duplicateClusters: number } {
    const filesMissingVersion = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM kms_files WHERE COALESCE(content_version_id, '') = ''
    `).get() as any)?.cnt || 0
    const contentVersions = (this.db.prepare('SELECT COUNT(*) AS cnt FROM kms_content_versions').get() as any)?.cnt || 0
    const duplicateClusters = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT exact_hash FROM kms_files
        WHERE file_hash != ''
        GROUP BY file_hash HAVING COUNT(*) > 1
      )
    `).get() as any)?.cnt || 0
    return { filesMissingVersion, contentVersions, duplicateClusters }
  }
}

export default KMSContentVersionService
