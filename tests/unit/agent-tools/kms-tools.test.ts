import { describe, it, expect, beforeEach, vi } from 'vitest'

/** 通过 mock KMSService 覆盖 kms_search / kms_get_content / kms_list_collections 的分支 */
const kmsState = vi.hoisted(() => ({
  svc: {} as any,
  searchCalls: [] as any[],
  contentCalls: [] as any[],
}))

vi.mock('../../../electron/main/services/kms/kms.service', () => ({
  default: { getInstance: () => kmsState.svc },
}))

const { createKMSTools } = await import('../../../electron/main/services/agent/tools/kms-search.tool')
const { createKMSCollectionTools } = await import('../../../electron/main/services/agent/tools/kms-collection-tools')

function makeService(overrides: Record<string, any> = {}) {
  return {
    search: async (query: string, opts: any) => {
      kmsState.searchCalls.push({ query, opts })
      return []
    },
    searchKnowledgeCards: async () => [],
    searchCollectionSummaries: () => [],
    getFileToc: () => [],
    getFileSummary: () => null,
    getFileParagraphs: () => [],
    getParagraphsByIds: () => [],
    getFileContent: async (fileId: string, opts: any) => {
      kmsState.contentCalls.push({ fileId, opts })
      return 'CONTENT'
    },
    listCollections: () => [],
    getCollectionSummariesByIds: (ids: string[]) => new Map(ids.map(id => [id, null])),
    ...overrides,
  }
}

beforeEach(() => {
  kmsState.searchCalls = []
  kmsState.contentCalls = []
  kmsState.svc = makeService()
})

const kmsSearch = (scopeRef?: any) => createKMSTools(scopeRef)[0].handler!
const kmsGetContent = (scopeRef?: any) => createKMSTools(scopeRef)[1].handler!
const listCollections = (scopeRef: any) => createKMSCollectionTools(scopeRef)[0].handler!

describe('agent/tools/kms_search', () => {
  it('空查询（缺失/空串/空白）返回提示且不检索', async () => {
    const handler = kmsSearch()
    expect(await handler({})).toMatchObject({ success: true, output: '请输入查询内容。' })
    expect(await handler({ query: '' })).toMatchObject({ success: true, output: '请输入查询内容。' })
    expect(await handler({ query: '   ' })).toMatchObject({ success: true, output: '请输入查询内容。' })
    expect(kmsState.searchCalls).toHaveLength(0)
  })

  it('支持 keyword 别名（部分模型的参数命名习惯）', async () => {
    await kmsSearch()({ keyword: '预算' })
    expect(kmsState.searchCalls[0].query).toBe('预算')
  })

  it('数值 0 作为查询被 String() 保留而非判空', async () => {
    await kmsSearch()({ query: 0 })
    expect(kmsState.searchCalls[0].query).toBe('0')
  })

  it('top_k 夹取到 1-20，缺省 5', async () => {
    await kmsSearch()({ query: 'a', top_k: 0 })
    await kmsSearch()({ query: 'a', top_k: -4 })
    await kmsSearch()({ query: 'a', top_k: 100 })
    await kmsSearch()({ query: 'a', top_k: 3 })
    expect(kmsState.searchCalls.map(c => c.opts.topK)).toEqual([5, 1, 20, 3])
  })

  it('search_mode=hybrid 时启用语义检索，其余值按关键词', async () => {
    await kmsSearch()({ query: 'a', search_mode: 'hybrid' })
    await kmsSearch()({ query: 'a', search_mode: 'keyword' })
    await kmsSearch()({ query: 'a', search_mode: 'HYBRID' })
    expect(kmsState.searchCalls.map(c => c.opts.useSemantic)).toEqual([true, false, false])
  })

  it('时间范围仅接受 number', async () => {
    await kmsSearch()({ query: 'a', time_range_start: 100, time_range_end: '200' })
    expect(kmsState.searchCalls[0].opts.timeRangeStart).toBe(100)
    expect(kmsState.searchCalls[0].opts.timeRangeEnd).toBeUndefined()
  })

  it('无结果：关键词模式给出混合检索建议，限定合集时额外提示放宽范围', async () => {
    const plain = String((await kmsSearch()({ query: '缺资料' })).output)
    expect(plain).toContain('本地搜索无结果："缺资料"。')
    expect(plain).toContain('建议：尝试混合检索(search_mode:"hybrid")')

    const scoped = String((await kmsSearch()({ query: '缺资料', collection_ids: ['c1'] })).output)
    expect(scoped).toContain('当前限定在指定合集中检索')
    expect(scoped).toContain('建议：尝试混合检索')

    // 已是混合检索时不再重复建议
    const hybrid = String((await kmsSearch()({ query: '缺资料', search_mode: 'hybrid' })).output)
    expect(hybrid).not.toContain('建议：尝试混合检索')
  })

  it('无结果但命中知识卡片/合集摘要时附加到提示后', async () => {
    kmsState.svc = makeService({
      searchKnowledgeCards: async () => [{
        displayKeyword: '报销', searchCount: 3, status: 'stale', summary: '报销摘要',
        keyPoints: [{ point: '要点1', sourceIndex: 0 }], citations: [{ fileName: '制度.pdf' }],
      }],
      searchCollectionSummaries: () => [{ collectionName: '财务合集', collectionId: 'c9', fileCount: 4, keyTopics: ['报销'], summary: '合集摘要' }],
    })
    const out = String((await kmsSearch()({ query: '报销' })).output)
    expect(out).toContain('但找到相关知识：')
    expect(out).toContain('--- 知识卡片 ---')
    expect(out).toContain('[卡片1] 报销（搜索3次，需刷新）')
    expect(out).toContain('要点：')
    expect(out).toContain('- 要点1（来源：制度.pdf）')
    expect(out).toContain('--- 相关合集摘要 ---')
    expect(out).toContain('[合集1] 财务合集 [c9] 4篇 | 报销')
    expect(out).toContain('合集摘要')
  })

  it('命中结果：输出类型标签、路径、行号与偏移', async () => {
    kmsState.svc = makeService({
      search: async () => [
        {
          match_type: 'paragraph', file_name: '报告.docx', paragraph_title: '第一章', file_path: 'D:\\kms\\报告.docx',
          text: '正文片段', file_id: 'f1', paragraph_id: 'p1', start_line: 10, end_line: 12, start_offset: 100, end_offset: 200,
        },
        { match_type: 'unknown_type', file_name: 'b.md', file_path: '/kms/b.md', text: 'x', file_id: 'f2' },
      ],
    })
    const out = String((await kmsSearch()({ query: '报告' })).output)
    expect(out).toContain('2 条结果(关键词):')
    expect(out).toContain('[1] 段落 | 报告.docx > 第一章')
    expect(out).toContain('路径: D:\\kms\\报告.docx')
    expect(out).toContain('paragraph_id: p1')
    expect(out).toContain('lines: 10-12')
    expect(out).toContain('offset: 100-200')
    // 未知类型原样输出
    expect(out).toContain('[2] unknown_type | b.md')
    expect(out).not.toContain('paragraph_id: undefined')
  })

  it('混合检索命中的结果标记为 (混合) 并附加合集数量', async () => {
    kmsState.svc = makeService({ search: async () => [{ match_type: 'hybrid', file_name: 'a.md', file_path: '/a', text: 't', file_id: 'f' }] })
    const out = String((await kmsSearch()({ query: 'a', search_mode: 'hybrid', collection_ids: ['c1', 'c2'] })).output)
    expect(out).toContain('1 条结果(混合)(合集2个):')
  })

  it('scopeRef 提供默认合集/目录/扩展名，显式参数优先覆盖', async () => {
    const scopeRef = { current: { collectionIds: ['scope-c'], dirIds: ['scope-d'], fileExtensions: ['pdf'] } }
    await kmsSearch(scopeRef)({ query: 'a' })
    expect(kmsState.searchCalls[0].opts).toMatchObject({ collectionIds: ['scope-c'], dirIds: ['scope-d'], fileExtensions: ['pdf'] })

    await kmsSearch(scopeRef)({ query: 'a', collection_ids: ['explicit-c'], dir_ids: ['explicit-d'], file_extensions: ['docx'] })
    expect(kmsState.searchCalls[1].opts).toMatchObject({ collectionIds: ['explicit-c'], dirIds: ['explicit-d'], fileExtensions: ['docx'] })
  })

  it('无 scopeRef 且无显式参数时不传过滤条件', async () => {
    await kmsSearch()({ query: 'a' })
    expect(kmsState.searchCalls[0].opts).toMatchObject({ collectionIds: undefined, dirIds: undefined, fileExtensions: undefined })
  })

  it('检索异常被捕获为错误结果', async () => {
    kmsState.svc = makeService({ search: async () => { throw new Error('索引损坏') } })
    expect(await kmsSearch()({ query: 'a' })).toMatchObject({ success: false, error: '本地搜索失败: 索引损坏' })
  })

  it('知识卡片检索异常被静默忽略（不影响主结果）', async () => {
    kmsState.svc = makeService({
      search: async () => [{ match_type: 'paragraph', file_name: 'a', file_path: '/a', text: 't', file_id: 'f' }],
      searchKnowledgeCards: async () => { throw new Error('卡片刻失败') },
      searchCollectionSummaries: () => { throw new Error('合集读失败') },
    })
    const res = await kmsSearch()({ query: 'a' })
    expect(res.success).toBe(true)
    expect(String(res.output)).not.toContain('知识卡片')
    expect(String(res.output)).not.toContain('合集摘要')
  })
})

describe('agent/tools/kms_get_content', () => {
  it('缺少 file_id 时给出提示', async () => {
    expect(await kmsGetContent()({})).toMatchObject({ success: true, output: '请提供 file_id。' })
  })

  it('file_id 前缀被剥离（f:xxx）', async () => {
    await kmsGetContent()({ file_id: 'f:8170964a' })
    expect(kmsState.contentCalls[0].fileId).toBe('8170964a')
  })

  it('view=toc：无目录时提示；有目录时按层级缩进并带段落 ID', async () => {
    expect(await kmsGetContent()({ file_id: 'f1', view: 'toc' })).toMatchObject({ success: true, output: '该文件暂无段落目录。' })

    kmsState.svc = makeService({
      getFileToc: () => [
        { id: 'p1', title: '第一章', level: 1 },
        { id: 'p2', title: '1.1 节', level: 2 },
        { id: 'p3', title: '无级别', level: 0 },
      ],
      getFileSummary: () => ({ file_name: '报告.docx' }),
    })
    const out = String((await kmsGetContent()({ file_id: 'f1', view: 'toc' })).output)
    expect(out).toContain('报告.docx (3段, #后为段落ID):')
    expect(out).toContain('第一章 #p1')
    expect(out).toContain('  1.1 节 #p2')
    expect(out).toContain('无级别 #p3')
  })

  it('view=toc：缺少文件摘要时回退 file_id 作为文件名', async () => {
    kmsState.svc = makeService({ getFileToc: () => [{ id: 'p1', title: 'T', level: 1 }] })
    expect(String((await kmsGetContent()({ file_id: 'f1', view: 'toc' })).output)).toContain('f1 (1段')
  })

  it('view=paragraphs：无段落时提示；超过 200 条只显示前 200 条', async () => {
    expect(await kmsGetContent()({ file_id: 'f1', view: 'paragraphs' }))
      .toMatchObject({ success: true, output: '该文件暂无段落摘要（仅热数据文件有摘要）。' })

    const many = Array.from({ length: 205 }, (_, i) => ({
      id: `p${i}`, title: `标题${i}`, title_path: `路径${i}`, summary: `摘要${i}`, file_id: 'f1', start_offset: i, end_offset: i + 1,
    }))
    kmsState.svc = makeService({ getFileParagraphs: () => many })
    const out = String((await kmsGetContent()({ file_id: 'f1', view: 'paragraphs' })).output)
    expect(out).toContain('205个段落 (仅显示前 200 个):')
    expect(out).toContain('[1] 路径0 [p0] 摘要0')
    expect(out).toContain('[200] 路径199 [p199]')
    expect(out).not.toContain('[201] 路径200')
  })

  it('view=paragraphs：无 title_path 时回退 title，再回退 (无标题)', async () => {
    kmsState.svc = makeService({
      getFileParagraphs: () => [
        { id: 'p1', title: '只有标题', file_id: 'f1', start_offset: 0, end_offset: 1 },
        { id: 'p2', file_id: 'f1', start_offset: 0, end_offset: 1 },
      ],
    })
    const out = String((await kmsGetContent()({ file_id: 'f1', view: 'paragraphs' })).output)
    expect(out).toContain('[1] 只有标题 [p1]')
    expect(out).toContain('[2] (无标题) [p2]')
  })

  it('view=content + paragraph_ids：批量取段落并解析关键词', async () => {
    kmsState.svc = makeService({
      getParagraphsByIds: (ids: string[]) => {
        expect(ids).toEqual(['p1', 'p2'])
        return [
          { id: 'p1', title: 'T1', file_id: 'f1', file_name: 'a.docx', start_offset: 0, end_offset: 5, summary: 'S1', keywords_json: '["预算","报销"]' },
          { id: 'p2', title: 'T2', file_id: 'f1', file_name: 'a.docx', start_offset: 5, end_offset: 9, keywords_json: 'not-json' },
        ]
      },
    })
    const out = String((await kmsGetContent()({ file_id: 'f1', paragraph_ids: ['p:p1', 'p2'] })).output)
    expect(out).toContain('2个段落:')
    expect(out).toContain('[1] T1 [p1] S1 | 关键词: 预算、报销')
    expect(out).toContain('[2] T2 [p2]')
    expect(out).toContain('file:f1 (a.docx) off:0-5')
    expect(kmsState.contentCalls).toHaveLength(0)
  })

  it('view=content + paragraph_ids 未命中时提示', async () => {
    kmsState.svc = makeService({ getParagraphsByIds: () => [] })
    expect(await kmsGetContent()({ file_id: 'f1', paragraph_ids: ['nope'] }))
      .toMatchObject({ success: true, output: '未找到匹配的段落。请检查 paragraph_id 是否正确。' })
  })

  it('paragraph_ids 为空数组时不走批量分支', async () => {
    await kmsGetContent()({ file_id: 'f1', paragraph_ids: [] })
    expect(kmsState.contentCalls).toHaveLength(1)
  })

  it('单段定位：paragraph_id 前缀被剥离并传给服务', async () => {
    await kmsGetContent()({ file_id: 'f1', paragraph_id: 'p:abc', start_offset: 5, end_offset: 9, start_line: 2, max_chars: 100 })
    expect(kmsState.contentCalls[0].opts).toEqual({
      paragraphId: 'abc', startOffset: 5, endOffset: 9, startLine: 2, maxChars: 100,
    })
  })

  it('未指定 max_chars 时默认 5000；未知 view 按 content 处理', async () => {
    await kmsGetContent()({ file_id: 'f1', view: 'weird' })
    expect(kmsState.contentCalls[0].opts.maxChars).toBe(5000)
  })

  it('获取内容异常被捕获', async () => {
    kmsState.svc = makeService({ getFileContent: async () => { throw new Error('文件已删除') } })
    expect(await kmsGetContent()({ file_id: 'f1' })).toMatchObject({ success: false, error: '获取文件内容失败: 文件已删除' })
  })

  it('两个工具均为按需工具（未声明 permission 元信息）', () => {
    const tools = createKMSTools()
    expect(tools.map(t => t.id)).toEqual(['kms_search', 'kms_get_content'])
    expect(tools.every(t => t.onDemand === true)).toBe(true)
    expect(tools.map(t => t.permission)).toEqual([undefined, undefined])
    expect(tools[0].timeoutMs).toBe(120000)
  })
})

describe('agent/tools/kms_list_collections', () => {
  it('无合集且会话未选定时给出空提示', async () => {
    const out = await listCollections({ current: { collectionIds: [] } })({})
    expect(out).toMatchObject({ success: true, output: '当前会话未选择任何合集，且系统中暂无合集。' })
  })

  it('会话限定合集时只显示命中的合集', async () => {
    kmsState.svc = makeService({
      listCollections: () => [
        { id: 'c1', name: '财务', file_count: 3, description: '财务文档' },
        { id: 'c2', name: '研发', file_count: 5 },
      ],
    })
    const out = String((await listCollections({ current: { collectionIds: ['c2'] } })({})).output)
    expect(out).toContain('1个合集:')
    expect(out).toContain('1. 研发 [c2] 5篇')
    expect(out).not.toContain('财务')
    expect(out).toContain('当前会话已选定 1 个合集')
  })

  it('限定的合集不存在时同样给出空提示', async () => {
    kmsState.svc = makeService({ listCollections: () => [{ id: 'c1', name: '财务' }] })
    expect(await listCollections({ current: { collectionIds: ['ghost'] } })({}))
      .toMatchObject({ success: true, output: '当前会话未选择任何合集，且系统中暂无合集。' })
  })

  it('未限定合集时显示全部，并批量查询摘要（非 N+1）', async () => {
    const calls: string[][] = []
    kmsState.svc = makeService({
      listCollections: () => [
        { id: 'c1', name: '财务', file_count: 3, description: '财务文档' },
        { id: 'c2', name: '研发', file_count: 5 },
      ],
      getCollectionSummariesByIds: (ids: string[]) => {
        calls.push(ids)
        return new Map([['c1', { key_topics_json: '["报销","发票"]' }]])
      },
    })
    const out = String((await listCollections({ current: { collectionIds: [] } })({})).output)
    expect(calls).toEqual([['c1', 'c2']])
    expect(out).toContain('2个合集:')
    expect(out).toContain('1. 财务 [c1] 3篇 | 报销、发票')
    expect(out).toContain('\n   财务文档')
    expect(out).toContain('2. 研发 [c2] 5篇')
    expect(out).toContain('当前会话未选定合集，检索将覆盖全部资料库')
  })

  it('摘要缺失或 key_topics_json 非法时不输出主题', async () => {
    kmsState.svc = makeService({
      listCollections: () => [{ id: 'c1', name: '财务', file_count: 1 }],
      getCollectionSummariesByIds: () => new Map([['c1', { key_topics_json: 'oops' }]]),
    })
    const out = String((await listCollections({ current: { collectionIds: [] } })({})).output)
    expect(out).toContain('1. 财务 [c1] 1篇\n')
    expect(out).not.toContain('|')
  })

  it('file_count 缺失时按 0 篇输出', async () => {
    kmsState.svc = makeService({ listCollections: () => [{ id: 'c1', name: '空合集' }] })
    expect(String((await listCollections({ current: { collectionIds: [] } })({})).output)).toContain('1. 空合集 [c1] 0篇')
  })

  it('服务异常被捕获为错误结果', async () => {
    kmsState.svc = makeService({ listCollections: () => { throw new Error('数据库锁定') } })
    expect(await listCollections({ current: { collectionIds: [] } })({}))
      .toMatchObject({ success: false, error: '合集列表获取失败: 数据库锁定' })
  })

  it('工具为按需 + 无参数（KMS 系列未声明 permission 元信息）', () => {
    const tool = createKMSCollectionTools({ current: { collectionIds: [] } })[0]
    expect(tool.id).toBe('kms_list_collections')
    expect(tool.onDemand).toBe(true)
    expect(tool.parameters.properties).toEqual({})
    expect(tool.parameters.required).toEqual([])
    // 现状：KMS 工具未声明 permission（kms_search / kms_get_content 同样缺失）
    expect(tool.permission).toBeUndefined()
  })
})
