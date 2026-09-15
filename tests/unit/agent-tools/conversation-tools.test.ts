import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 对话记忆工具（list_conversations / get_conversation_detail / search_conversations）。
 * 通过 mock DatabaseService 注入受控 SQL 桩，覆盖分页夹取、员工/时间过滤、
 * 消息抽取（剥离 thinking/tool_call）、增量切片与游标续取等分支。
 */
const dbState = vi.hoisted(() => ({
  db: null as any,
  calls: [] as { sql: string; args: any[] }[],
}))

vi.mock('../../../electron/main/services/database.service', () => ({
  default: { getInstance: () => ({ getDb: () => dbState.db }) },
}))

const { createConversationListTool } = await import('../../../electron/main/services/agent/tools/conversation-list.tool')
const { createConversationSearchTool } = await import('../../../electron/main/services/agent/tools/conversation-search.tool')

type StubOpts = {
  count?: number
  rows?: any[]
  row?: any
  ftsRows?: any[]
  failOn?: 'count' | 'rows' | 'detail' | 'fts'
}

function installDb(opts: StubOpts = {}) {
  dbState.calls = []
  const record = (sql: string, args: any[]) => dbState.calls.push({ sql, args })
  dbState.db = {
    prepare(sql: string) {
      return {
        get(...args: any[]) {
          record(sql, args)
          if (/COUNT\(\*\)/.test(sql)) {
            if (opts.failOn === 'count') throw new Error('db down')
            return { n: opts.count ?? 0 }
          }
          if (opts.failOn === 'detail') throw new Error('db down')
          return opts.row
        },
        all(...args: any[]) {
          record(sql, args)
          if (/conversations_fts MATCH/.test(sql)) {
            if (opts.failOn === 'fts') throw new Error('fts broken')
            return opts.ftsRows ?? []
          }
          if (opts.failOn === 'rows') throw new Error('db down')
          return opts.rows ?? []
        },
      }
    },
  }
}

function lastCall(match: RegExp) {
  return [...dbState.calls].reverse().find(c => match.test(c.sql))
}

const EMP = 'emp-current'

describe('agent/tools/conversation-list / list_conversations', () => {
  beforeEach(() => installDb())

  const listTool = () => createConversationListTool(EMP)[0].handler!

  it('默认：仅当前员工，limit=20 offset=0', () => {
    installDb({ count: 1, rows: [{ id: 'c1', title: 'T', employee_id: EMP, created_at: 1750000000 }] })
    const res = listTool()({})
    expect(res.success).toBe(true)
    const dataCall = lastCall(/LEFT JOIN employees/)!
    expect(dataCall.sql).toContain('AND c.employee_id = ?')
    expect(dataCall.args).toEqual([EMP, 20, 0])
    expect(res.results[0].conversationId).toBe('c1')
    expect(res.total).toBe(1)
    expect(res.hasMore).toBe(false)
  })

  it('limit 夹取到 1-100，offset 不为负', () => {
    installDb({ count: 0 })
    const handler = listTool()

    handler({ limit: 0 })
    expect(lastCall(/COUNT\(\*\)/)!.args).toEqual([EMP])

    handler({ limit: -5, offset: -3 })
    expect(lastCall(/COUNT\(\*\)/)!.args).toEqual([EMP])
    // count=0 提前返回，用有数据的桩再验证 limit 传参
    installDb({ count: 2, rows: [] })
    listTool()({ limit: -5, offset: -3 })
    const neg = lastCall(/LEFT JOIN employees/)!
    expect(neg.args).toEqual([EMP, 1, 0])

    installDb({ count: 2, rows: [] })
    listTool()({ limit: 1000, offset: 10 })
    expect(lastCall(/LEFT JOIN employees/)!.args).toEqual([EMP, 100, 10])

    installDb({ count: 2, rows: [] })
    listTool()({ limit: 3.9, offset: 2.9 })
    expect(lastCall(/LEFT JOIN employees/)!.args).toEqual([EMP, 3, 2])
  })

  it('employee_ids 只保留非空字符串：null/数字被丢弃（不再 String() 强转为 "null"/"3"）', () => {
    installDb({ count: 2, rows: [] })
    listTool()({ employee_ids: ['a', '', ' b ', null, 3] })
    const call = lastCall(/LEFT JOIN employees/)!
    expect(call.sql).toContain('AND c.employee_id IN (?,?)')
    expect(call.args.slice(0, 2)).toEqual(['a', 'b'])
  })

  it('employee_ids 全为空白或全为非字符串时回退到当前员工', () => {
    installDb({ count: 1, rows: [] })
    listTool()({ employee_ids: ['', '   '] })
    const blank = lastCall(/COUNT\(\*\)/)!
    expect(blank.sql).toContain('AND c.employee_id = ?')
    expect(blank.args).toEqual([EMP])

    installDb({ count: 1, rows: [] })
    listTool()({ employee_ids: [null, 3] })
    const nonString = lastCall(/COUNT\(\*\)/)!
    expect(nonString.sql).toContain('AND c.employee_id = ?')
    expect(nonString.args).toEqual([EMP])
  })

  it('include_all_employees=true 时不加员工过滤（employee_ids 被忽略）', () => {
    installDb({ count: 1, rows: [] })
    listTool()({ include_all_employees: true, employee_ids: ['a'] })
    const call = lastCall(/COUNT\(\*\)/)!
    expect(call.sql).not.toContain('c.employee_id IN')
    expect(call.sql).not.toContain('c.employee_id = ?')
    expect(call.args).toEqual([])
  })

  it('时间过滤：字符串解析为 unix 秒，非法时间被忽略', () => {
    installDb({ count: 1, rows: [] })
    const start = Math.floor(new Date(2026, 6, 24).getTime() / 1000)
    const end = Math.floor(new Date(2026, 6, 25).getTime() / 1000)
    listTool()({ start_time: '2026-07-24', end_time: '2026-07-25' })
    const call = lastCall(/COUNT\(\*\)/)!
    expect(call.sql).toContain('COALESCE(c.last_message_at, c.created_at) >= ?')
    expect(call.sql).toContain('COALESCE(c.last_message_at, c.created_at) <= ?')
    expect(call.args).toEqual([EMP, start, end])

    installDb({ count: 1, rows: [] })
    listTool()({ start_time: '不是时间', end_time: '' })
    const noTime = lastCall(/COUNT\(\*\)/)!
    expect(noTime.sql).not.toContain('>=' )
    expect(noTime.args).toEqual([EMP])
  })

  it('total=0 时返回空结果提示且不查明细', () => {
    installDb({ count: 0 })
    const res = listTool()({})
    expect(res).toMatchObject({ success: true, output: '未找到符合条件的历史对话。', results: [], total: 0, hasMore: false })
    expect(lastCall(/LEFT JOIN employees/)).toBeUndefined()
  })

  it('分页输出：编号从 offset 续接，last_message_at 缺失时回退 created_at', () => {
    installDb({
      count: 7,
      rows: [
        { id: 'c1', title: '', summary: '', message_count: 0, last_message_at: null, created_at: 1750000000, employee_id: EMP, employee_name: null },
        { id: 'c2', title: 'T2', summary: 'S2', message_count: 4, last_message_at: 1750000100, created_at: 1750000000, employee_id: EMP, employee_name: '小王' },
      ],
    })
    const res = listTool()({ offset: 2 })
    expect(res.success).toBe(true)
    expect(res.output).toContain('[3] 无标题对话')
    expect(res.output).toContain('[4] T2')
    expect(res.output).toContain('员工: (员工已删除)')
    expect(res.output).toContain('员工: 小王')
    expect(res.output).toContain('摘要: 无')
    expect(res.output).toContain('消息数: 0')
    expect(res.results[0]).toMatchObject({ conversationId: 'c1', employeeName: null, messageCount: 0 })
    // 2 + 2 < 7 → 还有更多
    expect(res.hasMore).toBe(true)
    expect(res.output).toContain('还有更多')
  })

  it('offset 超过总数时 hasMore 为 false', () => {
    installDb({ count: 2, rows: [{ id: 'c1', title: 'T', created_at: 1, message_count: 1 }] })
    const res = listTool()({ offset: 10 })
    expect(res.hasMore).toBe(false)
  })

  it('明细查询异常时返回可读错误', () => {
    installDb({ count: 5, failOn: 'rows' })
    const res = listTool()({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('列出对话失败: db down')
  })

  it('计数查询异常同样被捕获', () => {
    installDb({ failOn: 'count' })
    const res = listTool()({})
    expect(res.success).toBe(false)
    expect(res.error).toContain('db down')
  })

  it('工具元信息：按需 + 安全权限', () => {
    const tool = createConversationListTool(EMP)[0]
    expect(tool.onDemand).toBe(true)
    expect(tool.permission).toBe('safe')
    expect(tool.parameters.required).toBeUndefined()
  })
})

describe('agent/tools/conversation-list / get_conversation_detail', () => {
  beforeEach(() => installDb())

  const detailTool = () => createConversationListTool(EMP)[1].handler!

  function detailRow(messages: any[], extra: Record<string, any> = {}) {
    return {
      id: 'conv-1',
      title: '测试对话',
      summary: '摘要',
      message_count: messages.length,
      messages_json: JSON.stringify(messages),
      last_message_at: 1750000000,
      created_at: 1749999999,
      employee_id: EMP,
      employee_name: '小王',
      ...extra,
    }
  }

  it('conversation_id 为空/空白时报错', () => {
    expect(detailTool()({})).toMatchObject({ success: false, error: 'conversation_id 不能为空' })
    expect(detailTool()({ conversation_id: '   ' })).toMatchObject({ success: false, error: 'conversation_id 不能为空' })
  })

  it('对话不存在时报错并回显 id', () => {
    installDb({})
    const res = detailTool()({ conversation_id: 'missing' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('未找到 conversation_id=missing 的对话')
  })

  it('非法 messages_json 退化为无内容', () => {
    installDb({ row: { ...detailRow([]), messages_json: 'not-json' } })
    const res = detailTool()({ conversation_id: 'conv-1' })
    expect(res.success).toBe(true)
    expect(res.output).toContain('(无文本内容)')
    expect(res.output).toContain('文本条目(剥离工具/思考后): 0')
    expect(res.hasMore).toBe(false)
    expect(res.nextCursor).toBeNull()
    expect(res.returnedChars).toBe(0)
  })

  it('messages_json 为非数组 JSON 时同样视为空', () => {
    installDb({ row: { ...detailRow([]), messages_json: '{"a":1}' } })
    const res = detailTool()({ conversation_id: 'conv-1' })
    expect(res.output).toContain('(无文本内容)')
  })

  it('仅保留 user/assistant 的 answer 文本，剥离 thinking/tool_call，两种时间戳格式均归一', () => {
    installDb({
      row: detailRow([
        { role: 'user', content: '你好', timestamp: 1750000000 },
        { role: 'assistant', content: '', segments: [
          { type: 'thinking', content: '内部推理' },
          { type: 'tool_call', content: '工具调用' },
          { type: 'answer', content: '回答正文' },
        ], timestamp: 1750000000000 },
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '   ' },
        null,
        'not-object',
      ]),
    })
    const res = detailTool()({ conversation_id: 'conv-1' })
    expect(res.success).toBe(true)
    expect(res.output).toMatch(/\[1\] 用户 @ /)
    expect(res.output).toMatch(/\[2\] 助手 @ /)
    expect(res.output).toContain('回答正文')
    expect(res.output).not.toContain('内部推理')
    expect(res.output).not.toContain('工具调用')
    expect(res.output).not.toContain('系统提示')
    expect(res.output).toContain('文本条目(剥离工具/思考后): 2')
    expect(res.output).toContain('标题: 测试对话')
    expect(res.output).toContain('对话ID: conv-1')
    expect(res.output).toContain('员工: 小王')
    expect(res.output).toContain('摘要: 摘要')
  })

  it('assistant 的 content 与 answer 段同时存在时按顺序拼接', () => {
    installDb({
      row: detailRow([
        { role: 'assistant', content: '第一部分', segments: [{ type: 'answer', content: '第二部分' }] },
      ]),
    })
    const res = detailTool()({ conversation_id: 'conv-1' })
    expect(res.output).toContain('第一部分\n第二部分')
  })

  it('max_chars 夹取到 500-30000', () => {
    installDb({ row: detailRow([{ role: 'user', content: 'hi' }]) })
    expect(detailTool()({ conversation_id: 'conv-1', max_chars: 100 }).output).toContain('上限: 500')
    installDb({ row: detailRow([{ role: 'user', content: 'hi' }]) })
    expect(detailTool()({ conversation_id: 'conv-1', max_chars: 99999 }).output).toContain('上限: 30000')
    installDb({ row: detailRow([{ role: 'user', content: 'hi' }]) })
    expect(detailTool()({ conversation_id: 'conv-1', max_chars: 0 }).output).toContain('上限: 8000')
  })

  it('单条超长消息被截断并给出 nextCursor，续取可拿到剩余内容', () => {
    const long = 'A'.repeat(1200)
    installDb({ row: detailRow([{ role: 'user', content: long }]) })

    const first = detailTool()({ conversation_id: 'conv-1', max_chars: 500 })
    expect(first.hasMore).toBe(true)
    expect(first.truncated).toBe(true)
    expect(first.returnedChars).toBe(500)
    expect(first.nextCursor).toBeTruthy()
    expect(first.output).toContain('本条消息已截断')
    expect(first.output).toContain('还有更多内容未取出')

    const second = detailTool()({ conversation_id: 'conv-1', max_chars: 500, cursor: first.nextCursor })
    expect(second.returnedChars).toBe(500)
    expect(second.hasMore).toBe(true)

    const third = detailTool()({ conversation_id: 'conv-1', max_chars: 500, cursor: second.nextCursor })
    expect(third.returnedChars).toBe(200)
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBeNull()
    expect(third.output).toContain('已到末尾')

    // 三段内容中的 A 字符总数应等于原文长度（截断提示语不丢失内容）
    const totalAs = [first, second, third]
      .map(r => (String(r.output).match(/A/g) || []).length)
      .reduce((a, b) => a + b, 0)
    expect(totalAs).toBe(1200)
  })

  it('多条消息在预算内整体返回，超出预算时以 nextCursor 指向未取部分', () => {
    installDb({
      row: detailRow([
        { role: 'user', content: 'B'.repeat(10) },
        { role: 'user', content: 'C'.repeat(10) },
      ]),
    })
    const all = detailTool()({ conversation_id: 'conv-1', max_chars: 500 })
    expect(all.hasMore).toBe(false)
    expect(all.output).toContain('B'.repeat(10))
    expect(all.output).toContain('C'.repeat(10))

    const partial = detailTool()({ conversation_id: 'conv-1', max_chars: 500, cursor: Buffer.from(JSON.stringify({ entryIdx: 1, charOffset: 0 })).toString('base64') })
    expect(partial.hasMore).toBe(false)
    expect(partial.output).toContain('C'.repeat(10))
    expect(partial.output).not.toContain('B'.repeat(10))
  })

  it('非法 cursor 报错（服务端解析失败被兜底捕获）', () => {
    installDb({ row: detailRow([{ role: 'user', content: 'hi' }]) })
    const res = detailTool()({ conversation_id: 'conv-1', cursor: '这不是 base64 游标' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('获取对话详情失败')
  })

  it('cursor 字段越界/负数被规范化为 0', () => {
    installDb({ row: detailRow([{ role: 'user', content: 'hello' }]) })
    const cursor = Buffer.from(JSON.stringify({ entryIdx: -5, charOffset: -3 })).toString('base64')
    const res = detailTool()({ conversation_id: 'conv-1', cursor })
    expect(res.success).toBe(true)
    expect(res.output).toContain('hello')
  })

  it('查询异常时报错（DB 层失败）', () => {
    installDb({ failOn: 'detail' })
    const res = detailTool()({ conversation_id: 'conv-1' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('获取对话详情失败: db down')
  })
})

describe('agent/tools/conversation-search / search_conversations', () => {
  beforeEach(() => installDb())

  const searchTool = () => createConversationSearchTool(EMP)[0].handler!

  it('空查询报错；工具元信息为按需 + 安全权限', () => {
    const tool = createConversationSearchTool(EMP)[0]
    expect(tool.onDemand).toBe(true)
    expect(tool.permission).toBe('safe')
    expect(tool.parameters.required).toEqual(['query'])
    expect(searchTool()({ query: '   ' })).toMatchObject({ success: false, error: '查询不能为空' })
  })

  it('FTS 查询：英文 token 加前缀通配符，中文不加', () => {
    installDb({ ftsRows: [{ id: 'c1', title: 'T', summary: 'S', last_message_at: 1750000000, message_count: 2, preview_snippet: '片段' }] })
    const res = searchTool()({ query: 'hello 知识库 a' })
    const ftsCall = lastCall(/conversations_fts MATCH/)!
    // 空白拆分 → hello* / 知识库 / a（单字符英文不加 *）
    expect(ftsCall.args[1]).toBe('hello* 知识库 a')
    expect(res.success).toBe(true)
    expect(res.output).toContain('找到 1 条相关历史对话')
    expect(res.output).toContain('相关片段: 片段')
  })

  it('FTS 查询清洗特殊字符（" * ( ) ^ + -）后再分词', () => {
    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: '"a*b(c)^d+e-f"' })
    // 特殊字符被移除后字母相连 → 单个 token
    expect(lastCall(/conversations_fts MATCH/)!.args[1]).toBe('abcdef*')
  })

  it('清洗后为空时跳过 FTS，直接走 LIKE', () => {
    installDb({ rows: [{ id: 'c1', title: '标题', summary: null, message_count: 1, last_message_at: 1750000000, preview_snippet: '' }] })
    const res = searchTool()({ query: '***' })
    expect(lastCall(/conversations_fts MATCH/)).toBeUndefined()
    expect(lastCall(/ESCAPE/)!.args[1]).toBe('%***%')
    expect(res.success).toBe(true)
    expect(res.output).toContain('相关片段: 无')
  })

  it('LIKE 降级时转义 % 与 _ 通配符', () => {
    installDb({ rows: [{ id: 'c1', title: '50% 增长', summary: null, message_count: 1, last_message_at: 1750000000, preview_snippet: '' }] })
    const res = searchTool()({ query: '50%_' })
    // FTS 仍会先尝试（% 与 _ 不在清洗字符集内）
    expect(lastCall(/conversations_fts MATCH/)!.args[1]).toBe('50%_')
    expect(lastCall(/ESCAPE/)!.args[1]).toBe('%50\\%\\_%')
    expect(res.success).toBe(true)
    expect(res.output).toContain('50% 增长')
  })

  it('limit 夹取到 1-5（含非数字与 0）', () => {
    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: 'abc', limit: 100 })
    expect(lastCall(/conversations_fts MATCH/)!.args[2]).toBe(5)

    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: 'abc', limit: -3 })
    expect(lastCall(/conversations_fts MATCH/)!.args[2]).toBe(1)

    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: 'abc', limit: 0 })
    expect(lastCall(/conversations_fts MATCH/)!.args[2]).toBe(3)

    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: 'abc', limit: '2' as any })
    expect(lastCall(/conversations_fts MATCH/)!.args[2]).toBe(2)
  })

  it('FTS 命中时不触发 LIKE 降级', () => {
    installDb({ ftsRows: [{ id: 'c1', title: 'T', message_count: 1 }] })
    searchTool()({ query: 'abc' })
    expect(lastCall(/ESCAPE/)).toBeUndefined()
  })

  it('FTS 空结果降级 LIKE 后仍无结果时给出空提示', () => {
    installDb({ ftsRows: [], rows: [] })
    const res = searchTool()({ query: 'abc' })
    expect(res).toMatchObject({ success: true, output: '未找到匹配的历史对话。', results: [] })
    expect(lastCall(/ESCAPE/)).toBeDefined()
  })

  it('last_message_at 缺失时日期显示为「未知」', () => {
    installDb({ ftsRows: [{ id: 'c1', title: 'T', summary: 'S', message_count: 0, last_message_at: null, preview_snippet: '' }] })
    const res = searchTool()({ query: 'abc' })
    expect(res.output).toContain('(未知, 0条消息)')
    expect(res.output).toContain('相关片段: S') // 无 snippet 时回退 summary
  })

  it('FTS 查询抛错时报错（不静默降级）', () => {
    installDb({ failOn: 'fts' })
    const res = searchTool()({ query: 'abc' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('搜索失败: fts broken')
  })

  it('LIKE 查询抛错时报错', () => {
    installDb({ rows: [], failOn: 'rows' })
    const res = searchTool()({ query: '***' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('搜索失败: db down')
  })
})
