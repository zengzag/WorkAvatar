import * as fs from 'fs'
import * as path from 'path'
import DatabaseService from './database.service'
import { interactionContext } from './unified-interaction.service'
import { generateId, moveToTrash } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('FileSnapshot')

/** 每个会话保留的快照条数上限：超出后丢弃最旧记录，防止 DB 无界增长 */
const MAX_SNAPSHOTS_PER_CONVERSATION = 200

/** 可快照的文件大小上限：超过则只登记路径（不可还原），避免把大文件内容写进 DB */
export const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024

export type FileChangeKind = 'write' | 'append' | 'edit' | 'delete'

export interface FileSnapshotInput {
  toolName: string
  changeKind: FileChangeKind
  path: string
  /** 修改前文件是否存在 */
  existed: boolean
  /** 修改前内容（existed 且读取成功时提供，用于回滚） */
  beforeContent?: string | null
  /** 能否在应用内还原（目录、超大文件、未读到内容时为 false） */
  restorable: boolean
}

export interface FileSnapshotRow {
  id: string
  conversationId: string
  toolName: string
  changeKind: FileChangeKind
  path: string
  existed: boolean
  restorable: boolean
  createdAt: number
}

export interface RevertResult {
  reverted: number
  skipped: Array<{ path: string; reason: string }>
}

/**
 * 工作区文件改动快照：每次文件写入/编辑/删除前记录变更前状态，
 * 供 UI 撤销单个改动或整轮任务的改动（由 file_write/file_edit/file_delete 埋点）。
 *
 * 仅登记内容、不参与权限判定；回滚直接写回原内容或移入回收站，不做三方合并。
 */
class FileSnapshotService {
  private static instance: FileSnapshotService

  private constructor() {}

  static getInstance(): FileSnapshotService {
    if (!FileSnapshotService.instance) {
      FileSnapshotService.instance = new FileSnapshotService()
    }
    return FileSnapshotService.instance
  }

  private getDb() {
    return DatabaseService.getInstance().getDb()
  }

  /** 记录一次改动（无会话上下文时跳过：无法归组到任务，也就不提供回滚入口） */
  recordChange(input: FileSnapshotInput): void {
    try {
      const ctx = interactionContext.getStore()
      const conversationId = ctx?.conversationId
      if (!conversationId) return
      if (!input.path) return

      const db = this.getDb()
      db.prepare(
        `INSERT INTO file_snapshots
           (id, conversation_id, employee_id, tool_name, change_kind, path, existed, restorable, before_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        generateId(),
        conversationId,
        ctx?.employeeId || '',
        input.toolName,
        input.changeKind,
        input.path,
        input.existed ? 1 : 0,
        input.restorable ? 1 : 0,
        input.restorable && input.beforeContent != null ? input.beforeContent : null,
      )
      this.prune(conversationId)
    } catch (err: any) {
      // 快照失败不阻断文件操作
      logger.warn('recordChange failed:', err?.message || err)
    }
  }

  /** 丢弃超出上限的最旧记录 */
  private prune(conversationId: string): void {
    const overflow = this.getDb().prepare(
      `SELECT id FROM file_snapshots WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`
    ).all(conversationId, MAX_SNAPSHOTS_PER_CONVERSATION) as Array<{ id: string }>
    if (overflow.length === 0) return
    const stmt = this.getDb().prepare('DELETE FROM file_snapshots WHERE id = ?')
    for (const row of overflow) stmt.run(row.id)
  }

  /** 列出会话的改动记录（最新在前） */
  list(conversationId: string): FileSnapshotRow[] {
    if (!conversationId) return []
    const rows = this.getDb().prepare(
      `SELECT id, conversation_id, tool_name, change_kind, path, existed, restorable, created_at
       FROM file_snapshots WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC`
    ).all(conversationId) as any[]
    return rows.map(r => ({
      id: r.id,
      conversationId: r.conversation_id,
      toolName: r.tool_name,
      changeKind: r.change_kind,
      path: r.path,
      existed: r.existed === 1,
      restorable: r.restorable === 1,
      createdAt: r.created_at,
    }))
  }

  /**
   * 回滚指定记录（不传 ids 则回滚该会话全部记录）。
   * 按时间倒序依次还原，最终得到最早一次记录前的状态。
   */
  async revert(conversationId: string, ids?: string[]): Promise<RevertResult> {
    if (!conversationId) return { reverted: 0, skipped: [] }
    const db = this.getDb()
    let rows: any[]
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',')
      rows = db.prepare(
        `SELECT * FROM file_snapshots WHERE conversation_id = ? AND id IN (${placeholders})
         ORDER BY created_at DESC, rowid DESC`
      ).all(conversationId, ...ids)
    } else {
      rows = db.prepare(
        `SELECT * FROM file_snapshots WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC`
      ).all(conversationId)
    }

    const skipped: Array<{ path: string; reason: string }> = []
    const revertedIds: string[] = []

    for (const row of rows) {
      const target = String(row.path || '')
      if (!target) continue
      if (row.restorable !== 1) {
        skipped.push({ path: target, reason: '该改动无法自动还原（目录或超大文件）' })
        continue
      }
      try {
        if (row.existed === 1) {
          const dir = path.dirname(target)
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(target, String(row.before_content ?? ''), 'utf-8')
        } else if (fs.existsSync(target)) {
          await moveToTrash(target)
        }
        revertedIds.push(row.id)
      } catch (err: any) {
        skipped.push({ path: target, reason: err?.message || String(err) })
      }
    }

    if (revertedIds.length > 0) {
      const stmt = db.prepare('DELETE FROM file_snapshots WHERE id = ?')
      for (const id of revertedIds) stmt.run(id)
    }
    return { reverted: revertedIds.length, skipped }
  }

  /** 会话删除时清理记录 */
  clearForConversation(conversationId: string): void {
    if (!conversationId) return
    try {
      this.getDb().prepare('DELETE FROM file_snapshots WHERE conversation_id = ?').run(conversationId)
    } catch (err: any) {
      logger.warn('clearForConversation failed:', err?.message || err)
    }
  }
}

export default FileSnapshotService
