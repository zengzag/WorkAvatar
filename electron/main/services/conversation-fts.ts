import kmsTokenizer from './kms/kms-tokenizer.service'
import { extractMessagePreview } from './common-utils'
import { createLogger } from './logger'

const logger = createLogger('ConversationFTS')

/**
 * 单条对话进入检索索引的最大字符数。
 * 上限过小时，对话中后段的内容（结论、命令、细节）永远搜不到。
 */
export const CONVERSATION_PREVIEW_MAX_CHARS = 32000

/** 查询侧 token 上限，避免 MATCH 表达式过长拖慢 FTS */
const MAX_QUERY_TERMS = 12

/** 迁移所需的最小数据库接口（better-sqlite3 / node:sqlite 均满足） */
export interface ConversationFtsDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: any[]): unknown
    all(...params: any[]): any[]
    get(...params: any[]): any
  }
}

const FTS_TABLE_DDL = `CREATE VIRTUAL TABLE conversations_fts USING fts5(
  title,
  summary,
  content_preview,
  content_raw UNINDEXED,
  conversation_id UNINDEXED,
  employee_id UNINDEXED,
  tokenize='unicode61',
  prefix='2,3'
)`

/**
 * 对话 FTS 索引/查询的分词桥接层。
 *
 * FTS5 的 `unicode61` 会把一整段连续中文视作单个 token（"保密协议" 无法命中原文），
 * 因此索引侧必须用 jieba 预分词建立词边界，查询侧用同一分词器切词。
 * 与记忆库检索（employee-memory-fts）保持同一套方案，两侧分词器必须一致，
 * 否则会出现"能写不能中"的静默失效。
 */

/** 索引侧：jieba 精确模式分词（英文/数字原样保留） */
export function segmentConversationText(text: string): string {
  return kmsTokenizer.segment(text)
}

/** 索引侧：从 messages_json 抽取可检索正文（分词前的原文，供展示片段使用） */
export function buildConversationPreview(messagesJson: string): string {
  return extractMessagePreview(messagesJson, CONVERSATION_PREVIEW_MAX_CHARS)
}

/** 剔除 FTS5 语法字符，避免用户输入触发 syntax error */
function stripFtsSyntax(query: string): string {
  return (query || '').replace(/["*()^+\-:{}[\]<>~&|!]/g, '').trim()
}

/**
 * 查询侧：构造 FTS5 MATCH 表达式。
 * - jieba 搜索引擎模式分词（长词会拆出子词，提升召回）
 * - mode='all'：AND 连接，全部词命中才算匹配（精度优先）
 * - mode='any'：OR 连接，单个词缺失不会把整条查询清零（召回优先，由 BM25 排序）
 */
export function buildConversationFtsMatch(query: string, mode: 'all' | 'any' = 'all'): string | null {
  const cleaned = stripFtsSyntax(query)
  if (!cleaned) return null
  const tokens = kmsTokenizer.segmentForSearch(cleaned).slice(0, MAX_QUERY_TERMS)
  if (tokens.length === 0) return null
  const joiner = mode === 'all' ? ' AND ' : ' OR '
  return tokens.map(t => `"${t.replace(/"/g, '')}"`).join(joiner)
}

/**
 * 查询侧：LIKE 兜底用的关键词（按 jieba 词粒度 AND）。
 * FTS 无结果时使用，可覆盖词典未收录的生僻子串。
 * 无有效词元时回退为清洗后的整句，保持"用户原样输入"的语义。
 */
export function buildConversationLikeTerms(query: string): string[] {
  const cleaned = stripFtsSyntax(query)
  const tokens = cleaned ? kmsTokenizer.segmentForSearch(cleaned) : []
  const terms = tokens.length > 0 ? tokens : [cleaned || (query || '').trim()].filter(Boolean)
  return terms.slice(0, MAX_QUERY_TERMS)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 片段高亮用的关键词：用户原样词优先，叠加 jieba 词，长词在前避免被短词截断 */
function collectSnippetTerms(query: string): string[] {
  const raw = (query || '').trim()
  if (!raw) return []
  const candidates = [
    ...raw.split(/\s+/),
    ...kmsTokenizer.segmentForSearch(stripFtsSyntax(raw)),
  ]
  const seen = new Set<string>()
  const terms: string[] = []
  for (const t of candidates) {
    const term = t.trim()
    if (term.length === 0) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms.sort((a, b) => b.length - a.length)
}

/**
 * 从原始预览中截取命中片段并加 `<highlight>` 标记。
 * FTS 列存的是分词结果，直接使用 snippet() 会得到空格断开的词序列，
 * 因此改为在原文上定位关键词。
 */
export function buildConversationSnippet(rawPreview: string, query: string, maxLen = 120): string {
  const raw = (rawPreview || '').trim()
  if (!raw) return ''
  const terms = collectSnippetTerms(query)
  const lowerRaw = raw.toLowerCase()

  let hit = -1
  for (const term of terms) {
    const idx = lowerRaw.indexOf(term.toLowerCase())
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx
  }
  if (hit < 0) {
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw
  }

  const start = Math.max(0, hit - 40)
  const end = Math.min(raw.length, start + maxLen)
  let snippet = raw.slice(start, end)
  snippet = snippet.replace(
    new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi'),
    '<highlight>$1</highlight>'
  )
  return `${start > 0 ? '...' : ''}${snippet}${end < raw.length ? '...' : ''}`
}

/**
 * 确保对话 FTS 表为"分词索引 + 原始预览"结构（幂等，每次启动可安全执行）。
 * 旧表（只有原始 content_preview、无 content_raw）会把整段中文索引成单 token，
 * 导致中文几乎无法检索，必须一次性重建。
 */
export function ensureConversationFts(db: ConversationFtsDatabase): void {
  const columns = db.prepare('PRAGMA table_info(conversations_fts)').all() as Array<{ name: string }>

  if (columns.length === 0) {
    db.exec(FTS_TABLE_DDL)
    return
  }
  if (columns.some(c => c.name === 'content_raw')) return

  const ids = db.prepare(
    `SELECT id FROM conversations
     WHERE status = 'active' AND (parent_conversation_id = '' OR parent_conversation_id IS NULL)`
  ).all() as Array<{ id: string }>
  const getConversation = db.prepare(
    'SELECT employee_id, title, summary, messages_json FROM conversations WHERE id = ?'
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DROP TABLE IF EXISTS conversations_fts')
    db.exec(FTS_TABLE_DDL)
    const insert = db.prepare(
      'INSERT INTO conversations_fts (title, summary, content_preview, content_raw, conversation_id, employee_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const { id } of ids) {
      const row = getConversation.get(id) as
        | { employee_id: string; title?: string; summary?: string; messages_json?: string }
        | undefined
      if (!row) continue
      const rawPreview = buildConversationPreview(row.messages_json || '[]')
      insert.run(
        segmentConversationText(row.title || ''),
        segmentConversationText(row.summary || ''),
        segmentConversationText(rawPreview),
        rawPreview,
        id,
        row.employee_id || ''
      )
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  logger.info(`迁移：对话 FTS 索引按 jieba 分词重建完成（${ids.length} 条）`)
}
