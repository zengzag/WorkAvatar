import DatabaseService from './database.service'
import LLMClientService from './llm-client.service'
import { createLogger } from './logger'
import { cosineSimilarity } from './kms/kms-search-helpers'
import {
  MEMORY_EMBED_BACKFILL_BATCH,
  MEMORY_EMBED_TEXT_LIMIT,
  MEMORY_QUERY_EMBED_TIMEOUT_MS,
  type MemoryVectorRow,
} from './employee-memory-types'

const logger = createLogger('MemoryEmbedding')

interface EmbeddingConfig {
  providerId: string
  /** 真实模型名（写入 vectors.model，用于模型切换后判定失效；勿存 providerId） */
  modelName: string
}

interface MemoryContentRow {
  id: string
  key: string
  topic: string
  content: string
}

interface MemoryRow extends MemoryContentRow {
  deleted_at: number | null
}

/**
 * 记忆向量服务：为跨任务记忆生成 embedding，供每轮按用户问题做语义召回。
 *
 * - 复用宿主 embedding 能力（default_model_embedding 场景模型 + /embeddings 接口），不新增配置入口
 * - 向量以 BLOB 存主库 employee_memory_vectors，召回时在 JS 侧算余弦
 *   （记忆量级为几十~几百条，全扫描成本可忽略，故不引入 sqlite-vec 虚表）
 * - 未配置 embedding 模型时所有方法安全返回空，由调用方降级到 FTS5 关键词召回
 */
class EmployeeMemoryEmbeddingService {
  private db: DatabaseService
  private llm: LLMClientService
  private static instance: EmployeeMemoryEmbeddingService
  /** 单条即时生成队列：串行化避免同一记忆并发重复请求，也避免瞬时打爆 embedding 接口 */
  private queue: string[] = []
  private draining = false

  private constructor() {
    this.db = DatabaseService.getInstance()
    this.llm = LLMClientService.getInstance()
  }

  static getInstance(): EmployeeMemoryEmbeddingService {
    if (!EmployeeMemoryEmbeddingService.instance) {
      EmployeeMemoryEmbeddingService.instance = new EmployeeMemoryEmbeddingService()
    }
    return EmployeeMemoryEmbeddingService.instance
  }

  /** 当前可用的 embedding 配置；未配置时返回 null（调用方据此降级） */
  getConfig(): EmbeddingConfig | null {
    try {
      const cfg = this.llm.getDefaultEmbeddingConfig()
      if (!cfg?.providerId) return null
      return { providerId: cfg.providerId, modelName: cfg.modelName || cfg.providerId }
    } catch {
      return null
    }
  }

  /** 记忆内容哈希：key|topic|content 变更后向量应重新生成 */
  contentHash(memory: Pick<MemoryContentRow, 'key' | 'topic' | 'content'>): string {
    const text = `${memory.key}\n${memory.topic}\n${memory.content}`
    let hash = 2166136261
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(36)
  }

  /** 异步生成单条记忆向量（fire-and-forget，失败仅告警，靠回填自愈） */
  embedMemoryAsync(memoryId: string): void {
    if (!this.getConfig()) return
    if (this.queue.includes(memoryId)) return
    this.queue.push(memoryId)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        try {
          await this.embedMemoryById(id)
        } catch (err: any) {
          logger.warn(`生成记忆向量失败 (${id}): ${err?.message || err}`)
        }
      }
    } finally {
      this.draining = false
    }
  }

  /** 生成 / 刷新指定记忆的向量；内容未变且模型未变时跳过 */
  async embedMemoryById(memoryId: string): Promise<void> {
    const cfg = this.getConfig()
    if (!cfg) return

    const row = this.db.getDb().prepare(
      'SELECT id, key, topic, content, deleted_at FROM employee_memories WHERE id = ?'
    ).get(memoryId) as MemoryRow | undefined
    if (!row || row.deleted_at) return

    const hash = this.contentHash(row)
    const existing = this.db.getDb().prepare(
      'SELECT model, content_hash FROM employee_memory_vectors WHERE memory_id = ?'
    ).get(memoryId) as { model: string; content_hash: string } | undefined
    if (existing && existing.content_hash === hash && existing.model === cfg.modelName) return

    const text = `${row.topic} ${row.key} ${row.content}`.slice(0, MEMORY_EMBED_TEXT_LIMIT)
    const [vector] = await this.llm.createEmbeddings(cfg.providerId, [text], cfg.modelName)
    if (!vector?.length) return
    this.storeVector(memoryId, cfg.modelName, vector, hash)
  }

  /** 将查询文本向量化；未配置 / 超时 / 失败时返回 null，由调用方降级 */
  async embedQuery(text: string): Promise<Float32Array | null> {
    const cfg = this.getConfig()
    const query = (text || '').trim()
    if (!cfg || !query) return null
    try {
      const vectors = await withTimeout(
        this.llm.createEmbeddings(cfg.providerId, [query.slice(0, MEMORY_EMBED_TEXT_LIMIT)], cfg.modelName),
        MEMORY_QUERY_EMBED_TIMEOUT_MS,
      )
      return vectors?.[0] ?? null
    } catch (err: any) {
      logger.warn(`查询向量化失败，降级为关键词召回: ${err?.message || err}`)
      return null
    }
  }

  /** 加载某员工可见（员工作用域 + 全局）的全部有效记忆向量 */
  listVectorsForScope(employeeId: string): MemoryVectorRow[] {
    const rows = this.db.getDb().prepare(`
      SELECT v.memory_id, v.model, v.content_hash, v.embedding
      FROM employee_memory_vectors v
      JOIN employee_memories m ON m.id = v.memory_id
      WHERE m.deleted_at IS NULL
        AND ((m.scope = 'employee' AND m.employee_id = ?) OR m.scope = 'global')
    `).all(employeeId) as Array<{
      memory_id: string
      model: string
      content_hash: string
      embedding: Buffer
    }>

    return rows.map(r => ({
      memory_id: r.memory_id,
      model: r.model,
      content_hash: r.content_hash,
      embedding: bufferToFloat32(r.embedding),
    }))
  }

  /** 按余弦相似度对候选向量排序，返回 [{ memoryId, score }]（已按降序） */
  rankBySimilarity(queryVector: Float32Array, candidates: MemoryVectorRow[]): Array<{ memoryId: string; score: number }> {
    const scored: Array<{ memoryId: string; score: number }> = []
    for (const c of candidates) {
      if (c.embedding.length !== queryVector.length) continue
      scored.push({ memoryId: c.memory_id, score: cosineSimilarity(queryVector, c.embedding) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored
  }

  /**
   * 回填缺失 / 失效的记忆向量（新增记忆、内容变更、模型切换后自动补齐）。
   * @returns 本次实际处理的条数
   */
  async backfillMissing(limit: number = MEMORY_EMBED_BACKFILL_BATCH): Promise<number> {
    const cfg = this.getConfig()
    if (!cfg) return 0

    // 记忆量级为几十~几百条，直接一次取全量再在 JS 侧判定失效，避免写多条分支查询
    const candidates = this.db.getDb().prepare(`
      SELECT m.id, m.key, m.topic, m.content, v.model AS stored_model, v.content_hash AS stored_hash
      FROM employee_memories m
      LEFT JOIN employee_memory_vectors v ON v.memory_id = m.id
      WHERE m.deleted_at IS NULL
      ORDER BY m.is_pinned DESC, m.updated_at DESC
    `).all() as Array<MemoryContentRow & { stored_model: string | null; stored_hash: string | null }>

    const stale = candidates
      .filter(m => m.stored_model !== cfg.modelName || m.stored_hash !== this.contentHash(m))
      .slice(0, limit)
    if (stale.length === 0) return 0

    let processed = 0
    for (let i = 0; i < stale.length; i += 20) {
      const slice = stale.slice(i, i + 20)
      try {
        const texts = slice.map(m => `${m.topic} ${m.key} ${m.content}`.slice(0, MEMORY_EMBED_TEXT_LIMIT))
        const vectors = await this.llm.createEmbeddings(cfg.providerId, texts, cfg.modelName)
        for (let j = 0; j < slice.length && j < vectors.length; j++) {
          const vec = vectors[j]
          if (!vec?.length) continue
          this.storeVector(slice[j].id, cfg.modelName, vec, this.contentHash(slice[j]))
          processed++
        }
      } catch (err: any) {
        logger.warn(`批量回填记忆向量失败: ${err?.message || err}`)
        break
      }
    }
    if (processed > 0) logger.info(`回填记忆向量 ${processed} 条`)
    return processed
  }

  private storeVector(memoryId: string, model: string, vector: Float32Array, hash: string): void {
    this.db.getDb().prepare(`
      INSERT INTO employee_memory_vectors (memory_id, model, content_hash, embedding, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(memory_id) DO UPDATE SET
        model = excluded.model,
        content_hash = excluded.content_hash,
        embedding = excluded.embedding,
        updated_at = excluded.updated_at
    `).run(memoryId, model, hash, float32ToBuffer(vector))
  }
}

/** BLOB → Float32Array（slice 复制规避对齐问题） */
function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  return new Float32Array(copy)
}

function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

/** 超时包装：超时抛错由调用方降级，底层请求即使继续完成也不影响对话 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`embedding timeout after ${ms}ms`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      err => { clearTimeout(timer); reject(err) },
    )
  })
}

export default EmployeeMemoryEmbeddingService
