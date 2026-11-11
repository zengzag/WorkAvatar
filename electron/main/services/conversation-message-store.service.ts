import DatabaseService from './database.service'
import { createLogger } from './logger'
import { restoreOmittedInMessage } from './conversation-messages.compact'

const logger = createLogger('ConversationMessageStore')

export interface ConversationMessagePage {
  messages: any[]
  total: number
  hasOlder: boolean
  oldestSeq: number | null
}

/** 单条消息声明的产物（generatedFiles）：与任务侧栏的聚合口径一致 */
export function extractMessageArtifacts(message: any): any[] {
  const files: any[] = []
  for (const seg of message?.segments || []) {
    const list = seg?.generatedFiles?.length
      ? seg.generatedFiles
      : [...(seg?.runResult?.generatedFiles || []), ...(seg?.runResult?.autoDetectedFiles || [])]
    for (const file of list || []) {
      if (file?.path) files.push(file)
    }
  }
  return files
}

/**
 * 会话消息行存储。
 *
 * 旧版本把整段会话放在 conversations.messages_json（最大十几 MB），
 * 切换/写入都要整段解析与传输。现在消息按行存放：
 * - 读取：按 seq 分页取最近 N 条，切换成本与会话历史长度无关；
 * - 写入：只更新变化的单条消息（流式收尾、用户消息追加）；
 * - 迁移：首次访问某会话时把 messages_json 原子拆分为行，并清空旧字段。
 */
class ConversationMessageStore {
  private static instance: ConversationMessageStore
  /** 已确认迁移完成的会话，避免每次读写都查标记位 */
  private migrated = new Set<string>()

  static getInstance(): ConversationMessageStore {
    if (!ConversationMessageStore.instance) {
      ConversationMessageStore.instance = new ConversationMessageStore()
    }
    return ConversationMessageStore.instance
  }

  private db() {
    return DatabaseService.getInstance().getDb()
  }

  /** 旧数据懒迁移：把 messages_json 原子拆成行后清空旧字段 */
  ensureMigrated(conversationId: string): void {
    if (this.migrated.has(conversationId)) return
    const db = this.db()
    const row = db.prepare(
      'SELECT messages_migrated, messages_json FROM conversations WHERE id = ?'
    ).get(conversationId) as { messages_migrated?: number; messages_json?: string } | undefined
    if (!row) return
    if (row.messages_migrated) {
      this.migrated.add(conversationId)
      return
    }

    let messages: any[] = []
    try {
      const parsed = JSON.parse(row.messages_json || '[]')
      if (Array.isArray(parsed)) messages = parsed
    } catch (err: any) {
      logger.warn(`会话 ${conversationId} 消息 JSON 解析失败，跳过迁移:`, err?.message)
      return
    }

    const migrate = db.transaction(() => {
      db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conversationId)
      const insert = db.prepare(
        'INSERT INTO conversation_messages (conversation_id, message_id, seq, data_json, artifacts_json) VALUES (?, ?, ?, ?, ?)'
      )
      const usedIds = new Set<string>()
      messages.forEach((message, index) => {
        let messageId = String(message?.id || `msg_legacy_${index}`)
        if (usedIds.has(messageId)) messageId = `${messageId}_${index}`
        usedIds.add(messageId)
        insert.run(
          conversationId,
          messageId,
          index,
          JSON.stringify(message),
          JSON.stringify(extractMessageArtifacts(message)),
        )
      })
      db.prepare(
        "UPDATE conversations SET messages_migrated = 1, messages_json = '[]', message_count = ? WHERE id = ?"
      ).run(messages.length, conversationId)
    })
    migrate()
    this.migrated.add(conversationId)
  }

  count(conversationId: string): number {
    this.ensureMigrated(conversationId)
    const row = this.db().prepare(
      'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?'
    ).get(conversationId) as { n?: number } | undefined
    return Number(row?.n || 0)
  }

  getAll(conversationId: string): any[] {
    this.ensureMigrated(conversationId)
    const rows = this.db().prepare(
      'SELECT data_json FROM conversation_messages WHERE conversation_id = ? ORDER BY seq ASC'
    ).all(conversationId) as Array<{ data_json: string }>
    const messages: any[] = []
    for (const row of rows) {
      try {
        messages.push(JSON.parse(row.data_json))
      } catch {
        // 单条损坏不影响其余消息
      }
    }
    return messages
  }

  /** 读取单条消息（委托子过程按需加载用，避免解析整段会话） */
  getMessage(conversationId: string, messageId: string): any | null {
    this.ensureMigrated(conversationId)
    const row = this.db().prepare(
      'SELECT data_json FROM conversation_messages WHERE conversation_id = ? AND message_id = ?'
    ).get(conversationId, messageId) as { data_json: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.data_json) } catch { return null }
  }

  /** 分页读取：返回 seq 升序的消息切片（beforeSeq 为空表示取最新一页） */
  getPage(conversationId: string, limit: number, beforeSeq?: number): ConversationMessagePage {
    const safeLimit = Math.max(1, Math.floor(limit))
    this.ensureMigrated(conversationId)
    const db = this.db()
    const total = this.count(conversationId)
    const rows = (beforeSeq === undefined
      ? db.prepare(
          'SELECT seq, data_json FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(conversationId, safeLimit)
      : db.prepare(
          'SELECT seq, data_json FROM conversation_messages WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
        ).all(conversationId, beforeSeq, safeLimit)) as Array<{ seq: number; data_json: string }>

    rows.reverse()
    const messages: any[] = []
    for (const row of rows) {
      try {
        messages.push(JSON.parse(row.data_json))
      } catch {
        // 忽略单条损坏
      }
    }
    const oldestSeq = rows.length > 0 ? rows[0].seq : null
    const hasOlder = oldestSeq !== null && oldestSeq > 0
    return { messages, total, hasOlder, oldestSeq }
  }

  /** 追加一条新消息（已存在同 id 时按更新处理） */
  append(conversationId: string, message: any): number {
    this.ensureMigrated(conversationId)
    const db = this.db()
    const messageId = String(message?.id || '')
    if (!messageId) throw new Error('message.id 不能为空')
    const existing = db.prepare(
      'SELECT seq, data_json FROM conversation_messages WHERE conversation_id = ? AND message_id = ?'
    ).get(conversationId, messageId) as { seq: number; data_json: string } | undefined
    if (existing) return this.upsert(conversationId, message)

    const maxRow = db.prepare(
      'SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM conversation_messages WHERE conversation_id = ?'
    ).get(conversationId) as { maxSeq?: number } | undefined
    const seq = Number(maxRow?.maxSeq ?? -1) + 1
    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO conversation_messages (conversation_id, message_id, seq, data_json, artifacts_json) VALUES (?, ?, ?, ?, ?)'
      ).run(conversationId, messageId, seq, JSON.stringify(message), JSON.stringify(extractMessageArtifacts(message)))
      this.refreshCount(conversationId)
    })
    tx()
    return seq
  }

  /** 更新一条已存在的消息；不存在则追加。裁剪视图回写时按原行还原被外置的子过程 */
  upsert(conversationId: string, message: any): number {
    this.ensureMigrated(conversationId)
    const db = this.db()
    const messageId = String(message?.id || '')
    if (!messageId) throw new Error('message.id 不能为空')
    const existing = db.prepare(
      'SELECT seq, data_json FROM conversation_messages WHERE conversation_id = ? AND message_id = ?'
    ).get(conversationId, messageId) as { seq: number; data_json: string } | undefined

    if (!existing) return this.append(conversationId, message)

    let previous: any = null
    try { previous = JSON.parse(existing.data_json) } catch { previous = null }
    const merged = message?.segments ? restoreOmittedInMessage(message, previous) : message

    const tx = db.transaction(() => {
      db.prepare(
        'UPDATE conversation_messages SET data_json = ?, artifacts_json = ?, updated_at = unixepoch() WHERE conversation_id = ? AND message_id = ?'
      ).run(JSON.stringify(merged), JSON.stringify(extractMessageArtifacts(merged)), conversationId, messageId)
      this.refreshCount(conversationId)
    })
    tx()
    return existing.seq
  }

  /** 全量替换（结构性操作：删除/编辑/分支/压缩）。会按原行还原裁剪视图里被外置的子过程 */
  replaceAll(conversationId: string, messages: any[]): void {
    const db = this.db()
    const exists = db.prepare('SELECT 1 AS ok FROM conversations WHERE id = ?').get(conversationId)
    if (!exists) return
    this.ensureMigrated(conversationId)
    const safeMessages = Array.isArray(messages) ? messages : []
    const needRestore = safeMessages.some(m => m?.segments?.some?.((s: any) => s?.subSegmentsOmitted))
    const previousMap = new Map<string, any>()
    if (needRestore) {
      const rows = db.prepare(
        'SELECT message_id, data_json FROM conversation_messages WHERE conversation_id = ?'
      ).all(conversationId) as Array<{ message_id: string; data_json: string }>
      for (const row of rows) {
        try { previousMap.set(row.message_id, JSON.parse(row.data_json)) } catch { /* skip */ }
      }
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(conversationId)
      const insert = db.prepare(
        'INSERT INTO conversation_messages (conversation_id, message_id, seq, data_json, artifacts_json) VALUES (?, ?, ?, ?, ?)'
      )
      const usedIds = new Set<string>()
      safeMessages.forEach((message, index) => {
        let messageId = String(message?.id || `msg_${index}`)
        if (usedIds.has(messageId)) messageId = `${messageId}_${index}`
        usedIds.add(messageId)
        const merged = needRestore ? restoreOmittedInMessage(message, previousMap.get(messageId)) : message
        insert.run(
          conversationId,
          messageId,
          index,
          JSON.stringify(merged),
          JSON.stringify(extractMessageArtifacts(merged)),
        )
      })
      db.prepare(
        "UPDATE conversations SET messages_migrated = 1, messages_json = '[]', message_count = ?, updated_at = unixepoch() WHERE id = ?"
      ).run(safeMessages.length, conversationId)
    })
    tx()
  }

  /** 任务侧栏产物：按消息从新到旧聚合，同路径保留最新一次 */
  listArtifacts(conversationId: string): any[] {
    this.ensureMigrated(conversationId)
    const rows = this.db().prepare(
      'SELECT artifacts_json FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC'
    ).all(conversationId) as Array<{ artifacts_json: string }>
    const seen = new Set<string>()
    const result: any[] = []
    for (const row of rows) {
      let files: any[] = []
      try { files = JSON.parse(row.artifacts_json || '[]') } catch { files = [] }
      for (const file of files) {
        const path = String(file?.path || '')
        if (!path || seen.has(path)) continue
        seen.add(path)
        result.push(file)
      }
    }
    return result
  }

  /** 保留最近 keep 条消息（启动清理大对话用） */
  trimToRecent(conversationId: string, keep: number): number {
    this.ensureMigrated(conversationId)
    const db = this.db()
    const total = this.count(conversationId)
    if (total <= keep) return total
    const cutoff = db.prepare(
      'SELECT seq FROM conversation_messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?'
    ).get(conversationId, keep - 1) as { seq: number } | undefined
    if (cutoff) {
      db.prepare(
        'DELETE FROM conversation_messages WHERE conversation_id = ? AND seq < ?'
      ).run(conversationId, cutoff.seq)
      this.refreshCount(conversationId)
    }
    return this.count(conversationId)
  }

  private refreshCount(conversationId: string): void {
    const row = this.db().prepare(
      'SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ?'
    ).get(conversationId) as { n?: number } | undefined
    this.db().prepare('UPDATE conversations SET message_count = ? WHERE id = ?')
      .run(Number(row?.n || 0), conversationId)
  }

  /** 会话删除后清理内存标记（行数据由外键级联删除） */
  forget(conversationId: string): void {
    this.migrated.delete(conversationId)
  }
}

export default ConversationMessageStore
