import DatabaseService from '../../database.service'
import { parseNaturalTime } from './calendar.tool'
import type { ToolDefinition } from './types'

/**
 * 对话记忆列表/详情工具
 *
 * 与 search_conversations（关键词检索）互补：
 * - list_conversations：按员工/时间范围过滤，返回基础元信息（标题、id、消息数等），支持分页
 * - get_conversation_detail：按 conversation_id 取单条对话的完整内容（仅 user/assistant 文本，
 *   剥离 thinking/tool_call），通过 max_chars + cursor 实现增量访问，避免一次性灌爆 LLM 上下文
 *
 * "任务 id" 在数字员工语境下即 conversation_id（前端任务列表与对话一一对应）
 */

interface ConvEntry {
  role: 'user' | 'assistant'
  text: string
  /** 消息时间戳（毫秒），缺失则不显示 */
  timestampMs?: number
}

interface DetailCursor {
  entryIdx: number
  charOffset: number
}

/** 将毫秒时间戳格式化为本地可读字符串 */
function formatMsgTime(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return ''
  return new Date(ms).toLocaleString('zh-CN')
}

/** 从 messages_json 中抽取干净的对话文本：仅保留 user/assistant 的 answer 内容，剥离 thinking/tool_call */
function extractConversationEntries(messagesJson: string): ConvEntry[] {
  try {
    const messages = JSON.parse(messagesJson || '[]')
    if (!Array.isArray(messages)) return []
    const entries: ConvEntry[] = []
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue
      // 兼容毫秒（Date.now()）与秒两种格式
      const rawTs = typeof m.timestamp === 'number' ? m.timestamp : undefined
      const timestampMs = rawTs !== undefined
        ? (rawTs > 1e12 ? rawTs : rawTs * 1000)
        : undefined
      if (m.role === 'user') {
        if (typeof m.content === 'string' && m.content.trim()) {
          entries.push({ role: 'user', text: m.content, timestampMs })
        }
      } else if (m.role === 'assistant') {
        const parts: string[] = []
        if (typeof m.content === 'string' && m.content.trim()) parts.push(m.content)
        if (Array.isArray(m.segments)) {
          for (const seg of m.segments) {
            // 仅保留 answer 段；跳过 thinking / tool_call 段
            if (seg && seg.type === 'answer' && typeof seg.content === 'string' && seg.content.trim()) {
              parts.push(seg.content)
            }
          }
        }
        const text = parts.join('\n').trim()
        if (text) entries.push({ role: 'assistant', text, timestampMs })
      }
    }
    return entries
  } catch {
    return []
  }
}

/** 按 max_chars 增量切片：从 cursor 处开始累加 entry 文本，超出预算时在 entry 内部切分 */
function sliceEntries(
  entries: ConvEntry[],
  cursor: DetailCursor,
  maxChars: number,
): { text: string; nextCursor: DetailCursor | null; totalChars: number } {
  const parts: string[] = []
  let used = 0
  let i = Math.max(0, cursor.entryIdx)
  let charOffset = Math.max(0, cursor.charOffset)

  while (i < entries.length) {
    const e = entries[i]
    const remaining = e.text.slice(charOffset)
    const budget = maxChars - used
    const timeTag = formatMsgTime(e.timestampMs)
    const header = timeTag
      ? `[${i + 1}] ${e.role === 'user' ? '用户' : '助手'} @ ${timeTag}:`
      : `[${i + 1}] ${e.role === 'user' ? '用户' : '助手'}:`
    if (remaining.length <= budget) {
      parts.push(`${header}\n${remaining}`)
      used += remaining.length
      i++
      charOffset = 0
    } else {
      // 当前 entry 太长，按预算切分，标记截断位置
      const slice = remaining.slice(0, budget)
      parts.push(`${header}\n${slice}\n…(本条消息已截断，续取请用 nextCursor)`)
      used += slice.length
      charOffset += budget
      break
    }
  }

  const nextCursor = i < entries.length ? { entryIdx: i, charOffset } : null
  return { text: parts.join('\n\n'), nextCursor, totalChars: used }
}

function encodeCursor(cursor: DetailCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf-8').toString('base64')
}

function decodeCursor(raw: string): DetailCursor {
  const json = Buffer.from(raw, 'base64').toString('utf-8')
  const parsed = JSON.parse(json)
  return {
    entryIdx: Math.max(0, Math.floor(Number(parsed.entryIdx) || 0)),
    charOffset: Math.max(0, Math.floor(Number(parsed.charOffset) || 0)),
  }
}

/** 格式化时间参数：兼容 Unix 秒/毫秒/日期字符串，失败返回 undefined */
function coerceTime(input: any): number | undefined {
  if (input == null || input === '') return undefined
  const parsed = parseNaturalTime(input)
  return parsed !== null ? parsed : undefined
}

const TIME_HINT = '时间参数接受 Unix 秒（number）或日期字符串（如 "2026-07-24"、"2026-07-24 15:00"），由服务端解析。'

export function createConversationListTool(employeeId: string): ToolDefinition[] {
  const db = DatabaseService.getInstance().getDb()

  const listConversations: ToolDefinition = {
    id: 'list_conversations',
    name: 'list_conversations',
    title: '列出历史对话',
    summary: '按员工/时间范围列出历史对话元信息（标题、id、消息数等），支持分页。用于浏览而非关键词检索。',
    description: [
      '按员工 ID 与时间范围过滤，列出历史对话的基础元信息（仅 id、标题、摘要、消息数、最后消息时间、员工信息），不返回对话正文。',
      '用途：浏览某段时间内的对话清单、定位具体 conversation_id 后用 get_conversation_detail 取正文。',
      '与 search_conversations 的区别：本工具是按条件过滤列表，不做关键词匹配；需要按内容关键词检索时用 search_conversations。',
      '',
      '员工过滤：',
      '- 不传 employee_ids 且 include_all_employees=false（默认）：仅检索当前数字员工的对话',
      '- 传入 employee_ids（一个或多个）：仅检索指定数字员工的对话',
      '- include_all_employees=true：检索所有数字员工的对话（忽略 employee_ids）',
      '',
      TIME_HINT,
      '分页：使用 limit + offset，返回 total 总数和 hasMore 标记。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        employee_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '指定数字员工 ID 列表（一个或多个）。不传且 include_all_employees=false 时仅检索当前数字员工',
        },
        include_all_employees: {
          type: 'boolean',
          description: '是否检索所有数字员工的对话。设为 true 时忽略 employee_ids（默认 false）',
        },
        start_time: {
          type: 'string',
          description: '起始时间（含），按对话最后消息时间过滤',
        },
        end_time: {
          type: 'string',
          description: '结束时间（含），按对话最后消息时间过滤',
        },
        limit: {
          type: 'number',
          description: '返回数量（1-100，默认 20）',
          minimum: 1,
          maximum: 100,
        },
        offset: {
          type: 'number',
          description: '偏移量，用于分页（默认 0）',
          minimum: 0,
        },
      },
    },
    handler: (args: Record<string, any>) => {
      try {
        const limit = Math.min(Math.max(Math.floor(args.limit ?? 20) || 20, 1), 100)
        const offset = Math.max(Math.floor(args.offset ?? 0) || 0, 0)
        const includeAll = args.include_all_employees === true
        const rawIds = Array.isArray(args.employee_ids) ? args.employee_ids : []
        const employeeIds = rawIds.map((x: any) => String(x).trim()).filter(Boolean)

        // 解析员工过滤范围
        let empFilterSql = ''
        const empParams: any[] = []
        if (includeAll) {
          // 全部员工，不加 WHERE
        } else if (employeeIds.length > 0) {
          empFilterSql = `AND c.employee_id IN (${employeeIds.map(() => '?').join(',')})`
          empParams.push(...employeeIds)
        } else {
          // 默认仅当前员工
          empFilterSql = `AND c.employee_id = ?`
          empParams.push(employeeId)
        }

        // 解析时间过滤
        const startTime = coerceTime(args.start_time)
        const endTime = coerceTime(args.end_time)
        const timeClauses: string[] = []
        const timeParams: any[] = []
        if (startTime !== undefined) {
          timeClauses.push('COALESCE(c.last_message_at, c.created_at) >= ?')
          timeParams.push(startTime)
        }
        if (endTime !== undefined) {
          timeClauses.push('COALESCE(c.last_message_at, c.created_at) <= ?')
          timeParams.push(endTime)
        }
        const timeSql = timeClauses.length > 0 ? `AND ${timeClauses.join(' AND ')}` : ''

        // 总数
        const countRow = db.prepare(`
          SELECT COUNT(*) AS n
          FROM conversations c
          WHERE c.status = 'active'
            AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
            ${empFilterSql}
            ${timeSql}
        `).get(...empParams, ...timeParams) as { n: number }
        const total = countRow?.n ?? 0

        if (total === 0) {
          return {
            success: true,
            output: '未找到符合条件的历史对话。',
            results: [],
            total: 0,
            hasMore: false,
          }
        }

        // 分页数据：LEFT JOIN employees 取员工名（防止员工被级联删除后对话残留）
        const rows = db.prepare(`
          SELECT
            c.id,
            c.title,
            c.summary,
            c.message_count,
            c.last_message_at,
            c.created_at,
            c.employee_id,
            e.name AS employee_name
          FROM conversations c
          LEFT JOIN employees e ON e.id = c.employee_id
          WHERE c.status = 'active'
            AND (c.parent_conversation_id = '' OR c.parent_conversation_id IS NULL)
            ${empFilterSql}
            ${timeSql}
          ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
          LIMIT ? OFFSET ?
        `).all(...empParams, ...timeParams, limit, offset) as any[]

        const formatted = rows.map((r, i) => {
          const date = r.last_message_at
            ? new Date(r.last_message_at * 1000).toLocaleString('zh-CN')
            : (r.created_at ? new Date(r.created_at * 1000).toLocaleString('zh-CN') : '未知')
          const empName = r.employee_name || '(员工已删除)'
          return `[${offset + i + 1}] ${r.title || '无标题对话'}\n  id: ${r.id}\n  员工: ${empName}\n  最后消息: ${date}\n  消息数: ${r.message_count || 0}\n  摘要: ${r.summary || '无'}`
        }).join('\n\n')

        const hasMore = offset + rows.length < total

        return {
          success: true,
          output: `找到 ${total} 条历史对话（显示 ${offset + 1}-${offset + rows.length}）：\n\n${formatted}${hasMore ? `\n\n还有更多，可用更大的 offset 续取。` : ''}`,
          results: rows.map(r => ({
            conversationId: r.id,
            title: r.title,
            summary: r.summary,
            messageCount: r.message_count,
            lastMessageAt: r.last_message_at,
            createdAt: r.created_at,
            employeeId: r.employee_id,
            employeeName: r.employee_name || null,
          })),
          total,
          hasMore,
        }
      } catch (err: any) {
        return { success: false, error: `列出对话失败: ${err?.message || err}` }
      }
    },
    source: 'builtin',
    onDemand: true,
    permission: 'safe',
  }

  const getConversationDetail: ToolDefinition = {
    id: 'get_conversation_detail',
    name: 'get_conversation_detail',
    title: '获取对话详情',
    summary: '按对话 id 取单条对话正文（仅用户/助手文本，剥离工具与思考），支持增量续取。',
    description: [
      '按 conversation_id 获取单条对话的详细内容（即数字员工的"任务详情"）。',
      '返回内容仅包含 user 与 assistant 的 answer 文本，剥离 thinking（推理）与 tool_call（工具调用）段，避免污染上下文。',
      '每条消息附带发送时间（取自消息 timestamp，格式化为本地可读字符串）。',
      '',
      '增量访问：',
      '- 通过 max_chars 限制单次返回的字符总数（默认 8000，最大 30000）',
      '- 当一次取不完时返回 nextCursor，将其原样传入下一次调用的 cursor 参数即可续取后续内容',
      '- hasMore=false 表示已到末尾',
      '- 单条超长消息会在内部切分，nextCursor 指向剩余部分',
      '',
      '推荐先用 list_conversations 或 search_conversations 拿到 conversation_id，再用本工具读正文。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        conversation_id: {
          type: 'string',
          description: '对话 ID（即任务 ID，由 list_conversations 或 search_conversations 返回的 conversationId）',
        },
        max_chars: {
          type: 'number',
          description: '单次返回的最大字符数（500-30000，默认 8000）',
          minimum: 500,
          maximum: 30000,
        },
        cursor: {
          type: 'string',
          description: '续取游标（上一次返回的 nextCursor 原样传入即可，无需解析）',
        },
      },
      required: ['conversation_id'],
    },
    handler: (args: Record<string, any>) => {
      try {
        const conversationId = String(args.conversation_id || '').trim()
        if (!conversationId) {
          return { success: false, error: 'conversation_id 不能为空' }
        }
        const maxChars = Math.min(Math.max(Math.floor(args.max_chars ?? 8000) || 8000, 500), 30000)

        const cursor: DetailCursor = args.cursor
          ? decodeCursor(String(args.cursor))
          : { entryIdx: 0, charOffset: 0 }

        const row = db.prepare(`
          SELECT
            c.id,
            c.title,
            c.summary,
            c.message_count,
            c.messages_json,
            c.last_message_at,
            c.created_at,
            c.employee_id,
            e.name AS employee_name
          FROM conversations c
          LEFT JOIN employees e ON e.id = c.employee_id
          WHERE c.id = ?
          LIMIT 1
        `).get(conversationId) as any

        if (!row) {
          return { success: false, error: `未找到 conversation_id=${conversationId} 的对话` }
        }

        const entries = extractConversationEntries(row.messages_json || '[]')
        const totalEntries = entries.length
        const slice = sliceEntries(entries, cursor, maxChars)

        const nextCursor = slice.nextCursor ? encodeCursor(slice.nextCursor) : null
        const hasMore = nextCursor !== null

        // 拼装输出
        const headerLines: string[] = []
        headerLines.push(`标题: ${row.title || '无标题对话'}`)
        headerLines.push(`对话ID: ${row.id}`)
        headerLines.push(`员工: ${row.employee_name || '(员工已删除)'}`)
        const lastTime = row.last_message_at
          ? new Date(row.last_message_at * 1000).toLocaleString('zh-CN')
          : (row.created_at ? new Date(row.created_at * 1000).toLocaleString('zh-CN') : '未知')
        headerLines.push(`最后消息: ${lastTime}`)
        headerLines.push(`消息数(元信息): ${row.message_count || 0} / 文本条目(剥离工具/思考后): ${totalEntries}`)
        if (row.summary) headerLines.push(`摘要: ${row.summary}`)
        const cursorInfo = `本次返回字符: ${slice.totalChars} / 上限: ${maxChars}`
        const tailInfo = hasMore
          ? `${cursorInfo}\n\n⚠ 还有更多内容未取出，请用相同 conversation_id 与 max_chars，并把 nextCursor 作为 cursor 参数传入续取。`
          : `${cursorInfo}\n\n✓ 已到末尾，无更多内容。`

        const output = `${headerLines.join('\n')}\n\n--- 对话内容 ---\n${slice.text || '(无文本内容)'}\n\n--- ${tailInfo} ---`

        return {
          success: true,
          output,
          conversationId: row.id,
          title: row.title,
          summary: row.summary,
          messageCount: row.message_count,
          employeeId: row.employee_id,
          employeeName: row.employee_name || null,
          nextCursor,
          hasMore,
          truncated: hasMore,
          returnedChars: slice.totalChars,
        }
      } catch (err: any) {
        return { success: false, error: `获取对话详情失败: ${err?.message || err}` }
      }
    },
    source: 'builtin',
    onDemand: true,
    permission: 'safe',
  }

  return [listConversations, getConversationDetail]
}
