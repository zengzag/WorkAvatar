import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  provider: null as any,
  createCalls: [] as Array<{ providerId: string; modelId?: string }>,
  chatCalls: [] as Array<{ messages: any[]; options: any }>,
  responses: [] as string[],
  chatError: null as any,
  onChat: null as null | (() => void),
}))

vi.mock('../../../electron/main/services/agent/llm/pi-provider-factory', () => ({
  createPiProvider: async (providerId: string, modelId?: string) => {
    state.createCalls.push({ providerId, modelId })
    return state.provider
  },
}))

import {
  callLLMForToc,
  restoreTocWithLLM,
  generateParagraphSummary,
  generateDocumentSummaryFromParagraphs,
  generateFileSummary,
  generateSimpleDirSummary,
  generateDirSummaryViaLLM,
  buildDirFileList,
  formatSize,
  updateParagraphSummaries,
} from '../../../electron/main/services/kms/kms-index-llm-helpers'

function installProvider() {
  state.provider = {
    chat: async (msgs: any[], _tools: any[], options: any) => {
      state.chatCalls.push({ messages: msgs, options })
      state.onChat?.()
      if (state.chatError) throw state.chatError
      return { content: state.responses.shift() ?? '{}' }
    },
  }
}

beforeEach(() => {
  state.provider = null
  state.createCalls.length = 0
  state.chatCalls.length = 0
  state.responses = []
  state.chatError = null
  state.onChat = null
})

describe('kms-index-llm-helpers / formatSize', () => {
  it('按 B / KB / MB 分级格式化', () => {
    expect(formatSize(0)).toBe('0B')
    expect(formatSize(1023)).toBe('1023B')
    expect(formatSize(1024)).toBe('1.0KB')
    expect(formatSize(1536)).toBe('1.5KB')
    expect(formatSize(1024 * 1024 - 1)).toBe('1024.0KB')
    expect(formatSize(1024 * 1024)).toBe('1.0MB')
    expect(formatSize(3.5 * 1024 * 1024)).toBe('3.5MB')
  })

  it('负数与 NaN 无防御（当前行为）', () => {
    expect(formatSize(-5)).toBe('-5B')
    expect(formatSize(NaN)).toBe('NaNMB')
  })
})

describe('kms-index-llm-helpers / buildDirFileList', () => {
  it('优先使用 summary，其次 light_summary，并截断到 80 字', () => {
    const out = buildDirFileList([
      { file_name: 'a.md', file_ext: 'md', file_size: 2048, summary: 'x'.repeat(100) },
      { file_name: 'b.txt', file_ext: 'txt', file_size: 10, light_summary: '轻摘要' },
      { file_name: 'c', file_ext: null, file_size: 0 },
    ])
    const lines = out.split('\n')
    expect(lines[0]).toBe(`- a.md (md, 2.0KB): ${'x'.repeat(80)}`)
    expect(lines[1]).toBe('- b.txt (txt, 10B): 轻摘要')
    expect(lines[2]).toBe('- c (无扩展名, 0B)')
  })

  it('空数组返回空串', () => {
    expect(buildDirFileList([])).toBe('')
  })
})

describe('kms-index-llm-helpers / generateSimpleDirSummary', () => {
  it('统计扩展名并按数量降序排列', () => {
    const out = generateSimpleDirSummary([
      { file_name: 'a.md', file_ext: 'md' },
      { file_name: 'b.md', file_ext: 'md' },
      { file_name: 'c.txt', file_ext: 'txt' },
      { file_name: 'd', file_ext: null },
    ])
    expect(out).toBe('目录包含 4 个文件（md(2), txt(1), 其他(1)）。代表文件：a.md, b.md, c.txt, d')
  })

  it('代表文件最多列 10 个', () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ file_name: `f${i}`, file_ext: 'md' }))
    const out = generateSimpleDirSummary(files)
    expect(out).toContain('f9')
    expect(out).not.toContain('f10')
  })

  it('空数组产生空括号摘要（当前行为）', () => {
    expect(generateSimpleDirSummary([])).toBe('目录包含 0 个文件（）。代表文件：')
  })

  it('数量相同的扩展名保持首次出现顺序', () => {
    const out = generateSimpleDirSummary([
      { file_name: 'a', file_ext: 'pdf' },
      { file_name: 'b', file_ext: 'docx' },
    ])
    expect(out).toContain('pdf(1), docx(1)')
  })
})

describe('kms-index-llm-helpers / generateDirSummaryViaLLM', () => {
  const files = [{ file_name: 'a.md', file_ext: 'md', file_size: 100 }]

  it('未配置 provider/model 时降级为简单摘要且不调用 LLM', async () => {
    const out = await generateDirSummaryViaLLM('/dir', files, undefined, undefined)
    expect(out.keywords).toEqual([])
    expect(out.summary).toContain('目录包含 1 个文件')
    expect(state.createCalls).toHaveLength(0)
  })

  it('文件数超过 100 时降级为简单摘要', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ file_name: `f${i}`, file_ext: 'md', file_size: 1 }))
    const out = await generateDirSummaryViaLLM('/dir', many, 'p1', 'm1')
    expect(out.summary).toContain('目录包含 101 个文件')
    expect(state.createCalls).toHaveLength(0)
  })

  it('恰好 100 个文件仍走 LLM', async () => {
    installProvider()
    const many = Array.from({ length: 100 }, (_, i) => ({ file_name: `f${i}`, file_ext: 'md', file_size: 1 }))
    state.responses = ['{"summary":"LLM 摘要","keywords":["k1"]}']
    const out = await generateDirSummaryViaLLM('/dir', many, 'p1', 'm1')
    expect(out).toEqual({ summary: 'LLM 摘要', keywords: ['k1'] })
  })

  it('LLM 返回空 summary 时降级为简单摘要', async () => {
    installProvider()
    state.responses = ['{"summary":"","keywords":["k"]}']
    const out = await generateDirSummaryViaLLM('/dir', files, 'p1', 'm1')
    expect(out.summary).toContain('目录包含 1 个文件')
    expect(out.keywords).toEqual([])
  })

  it('LLM 调用失败时降级为简单摘要', async () => {
    installProvider()
    state.chatError = new Error('llm down')
    const out = await generateDirSummaryViaLLM('/dir', files, 'p1', 'm1')
    expect(out.summary).toContain('目录包含 1 个文件')
  })

  it('keywords 缺失时返回空数组', async () => {
    installProvider()
    state.responses = ['{"summary":"S"}']
    expect((await generateDirSummaryViaLLM('/dir', files, 'p1', 'm1')).keywords).toEqual([])
  })
})

describe('kms-index-llm-helpers / callLLMForToc', () => {
  it('返回 LLM 识别的 toc 数组', async () => {
    installProvider()
    state.responses = ['{"toc":[{"title":"第一章","level":1,"lineNumber":3}]}']
    const toc = await callLLMForToc('[L1] 内容', 'p1', 'm1')
    expect(toc).toEqual([{ title: '第一章', level: 1, lineNumber: 3 }])
  })

  it('toc 非数组时返回空数组', async () => {
    installProvider()
    state.responses = ['{"toc":"not-array"}']
    expect(await callLLMForToc('[L1] 内容', 'p1', 'm1')).toEqual([])
  })

  it('缺少 toc 字段时返回空数组', async () => {
    installProvider()
    state.responses = ['{}']
    expect(await callLLMForToc('[L1] 内容', 'p1', 'm1')).toEqual([])
  })

  it('已有目录上下文会拼入 system prompt', async () => {
    installProvider()
    state.responses = ['{"toc":[]}']
    await callLLMForToc('[L10] 内容', 'p1', 'm1', '[L5] 上级标题')
    expect(state.chatCalls[0].messages[0].content).toContain('[L5] 上级标题')
  })

  it('enableThinking 映射为 enableThinking: high', async () => {
    installProvider()
    state.responses = ['{"toc":[]}']
    await callLLMForToc('[L1] 内容', 'p1', 'm1', undefined, undefined, true)
    expect(state.chatCalls[0].options.enableThinking).toBe('high')
  })
})

describe('kms-index-llm-helpers / restoreTocWithLLM', () => {
  it('短文档（≤100 行）单次调用并校验行号', async () => {
    installProvider()
    const body = Array.from({ length: 30 }, (_, i) => `正文第 ${i} 行`)
    const text = ['# 第一章', ...body].join('\n')
    state.responses = ['{"toc":[{"title":"第一章","level":1,"lineNumber":1}]}']
    const out = await restoreTocWithLLM(text, 'p1', 'm1')
    expect(state.chatCalls).toHaveLength(1)
    expect(out).toEqual([{ title: '第一章', level: 1, lineNumber: 1, offset: 0 }])
    expect(state.chatCalls[0].messages[1].content).toContain('[L1] # 第一章')
  })

  it('长文档分块调用并带 10 行重叠，进度回调报告总块数', async () => {
    installProvider()
    const text = Array.from({ length: 260 }, (_, i) => `第${i + 1}行内容`).join('\n')
    state.responses = ['{"toc":[]}', '{"toc":[]}', '{"toc":[]}']
    const progress: any[] = []
    await restoreTocWithLLM(text, 'p1', 'm1', p => progress.push(p))

    expect(state.chatCalls).toHaveLength(3)
    // 第二块起始行 = 100 - 10 + 1 = 91
    expect(state.chatCalls[1].messages[1].content).toContain('[L91] 第91行内容')
    expect(progress.map(p => p.current)).toEqual([1, 2, 3])
    expect(progress.map(p => p.total)).toEqual([3, 3, 3])
    expect(progress[0].phase).toBe('toc')
  })

  it('后续块携带前序已识别目录作为上下文', async () => {
    installProvider()
    const text = Array.from({ length: 150 }, (_, i) => `第${i + 1}行内容`).join('\n')
    state.responses = ['{"toc":[{"title":"第一章","level":1,"lineNumber":1}]}', '{"toc":[]}']
    await restoreTocWithLLM(text, 'p1', 'm1')
    expect(state.chatCalls).toHaveLength(2)
    expect(state.chatCalls[1].messages[0].content).toContain('[L1] 第一章')
  })

  it('信号已中断时抛出 AbortError', async () => {
    installProvider()
    const text = Array.from({ length: 260 }, (_, i) => `第${i + 1}行内容`).join('\n')
    const controller = new AbortController()
    controller.abort()
    await expect(restoreTocWithLLM(text, 'p1', 'm1', undefined, controller.signal)).rejects.toThrow('Parse cancelled')
    expect(state.chatCalls).toHaveLength(0)
  })

  it('恰好 100 行时不走分块路径', async () => {
    installProvider()
    const text = Array.from({ length: 100 }, (_, i) => `第${i + 1}行内容`).join('\n')
    state.responses = ['{"toc":[]}']
    await restoreTocWithLLM(text, 'p1', 'm1')
    expect(state.chatCalls).toHaveLength(1)
  })

  it('101 行时走分块路径', async () => {
    installProvider()
    const text = Array.from({ length: 101 }, (_, i) => `第${i + 1}行内容`).join('\n')
    state.responses = ['{"toc":[]}', '{"toc":[]}']
    await restoreTocWithLLM(text, 'p1', 'm1')
    expect(state.chatCalls).toHaveLength(2)
  })
})

describe('kms-index-llm-helpers / generateParagraphSummary', () => {
  it('段落内容超过 8000 字时被截断后送 LLM', async () => {
    installProvider()
    state.responses = ['{"title":"T","summary":"S","keywords":["k"]}']
    const out = await generateParagraphSummary('x'.repeat(9000), '标题', 'p1', 'm1')
    expect(out).toEqual({ title: 'T', summary: 'S', keywords: ['k'] })
    const prompt: string = state.chatCalls[0].messages[1].content
    expect(prompt).toContain('x'.repeat(8000))
    expect(prompt).not.toContain('x'.repeat(8001))
  })

  it('失败时抛错并带上段落标题', async () => {
    installProvider()
    state.chatError = new Error('boom')
    await expect(generateParagraphSummary('内容', '我的标题', 'p1', 'm1'))
      .rejects.toThrow('Paragraph summary generation failed (我的标题): boom')
  })
})

describe('kms-index-llm-helpers / generateDocumentSummaryFromParagraphs', () => {
  it('汇总段落摘要并返回结果', async () => {
    installProvider()
    state.responses = ['{"summary":"总","keywords":["a"],"mainTopics":["b"]}']
    const out = await generateDocumentSummaryFromParagraphs(
      [{ title: 'P1', summary: 'S1', keywords: ['k1'] }],
      '文档标题',
      'p1',
      'm1',
    )
    expect(out).toEqual({ summary: '总', keywords: ['a'], mainTopics: ['b'] })
    expect(state.chatCalls[0].messages[1].content).toContain('### 段落1: P1')
  })

  it('失败时抛错并带上文档标题', async () => {
    installProvider()
    state.chatError = new Error('boom')
    await expect(generateDocumentSummaryFromParagraphs([], '我的文档', 'p1', 'm1'))
      .rejects.toThrow('Document summary generation failed (我的文档): boom')
  })
})

describe('kms-index-llm-helpers / generateFileSummary', () => {
  const engine = () => ({ indexFileSummary: vi.fn() }) as any

  it('未配置 modelId 时抛 MODEL_NOT_CONFIGURED', async () => {
    const searchEngine = engine()
    const onSave = vi.fn()
    await expect(generateFileSummary('f1', 'text', 'p1', undefined, searchEngine, undefined, undefined, onSave))
      .rejects.toThrow('MODEL_NOT_CONFIGURED')
    expect(state.createCalls).toHaveLength(0)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('signal 已中断时直接返回，不调用 LLM 也不保存', async () => {
    installProvider()
    const controller = new AbortController()
    controller.abort()
    const searchEngine = engine()
    const onSave = vi.fn()
    await generateFileSummary('f1', 'text', 'p1', 'm1', searchEngine, controller.signal, undefined, onSave)
    expect(state.createCalls).toHaveLength(0)
    expect(onSave).not.toHaveBeenCalled()
    expect(searchEngine.indexFileSummary).not.toHaveBeenCalled()
  })

  it('成功时保存摘要并更新文件摘要索引', async () => {
    installProvider()
    state.responses = ['{"summary":"摘要","keywords":["k1","k2"],"main_topics":["t"]}']
    const searchEngine = engine()
    const onSave = vi.fn()
    await generateFileSummary('f1', 'x'.repeat(5000), 'p1', 'm1', searchEngine, undefined, undefined, onSave)
    expect(onSave).toHaveBeenCalledWith('f1', '摘要', ['k1', 'k2'], ['t'])
    expect(searchEngine.indexFileSummary).toHaveBeenCalledWith('f1', '摘要', ['k1', 'k2'])
    expect(state.chatCalls[0].messages[1].content).toContain('x'.repeat(3000))
    expect(state.chatCalls[0].messages[1].content).not.toContain('x'.repeat(3001))
  })

  it('LLM 返回缺失字段时回落为空值', async () => {
    installProvider()
    state.responses = ['{}']
    const onSave = vi.fn()
    await generateFileSummary('f1', 'text', 'p1', 'm1', engine(), undefined, undefined, onSave)
    expect(onSave).toHaveBeenCalledWith('f1', '', [], [])
  })

  it('LLM 调用失败时抛错且不保存（避免用空摘要覆盖已有摘要）', async () => {
    installProvider()
    state.chatError = new Error('llm down')
    const searchEngine = engine()
    const onSave = vi.fn()
    await expect(generateFileSummary('f1', 'text', 'p1', 'm1', searchEngine, undefined, undefined, onSave))
      .rejects.toThrow('LLM call failed: llm down')
    expect(onSave).not.toHaveBeenCalled()
    expect(searchEngine.indexFileSummary).not.toHaveBeenCalled()
  })

  it('LLM 返回前中断则不保存', async () => {
    installProvider()
    const controller = new AbortController()
    state.onChat = () => controller.abort()
    state.responses = ['{"summary":"摘要"}']
    const onSave = vi.fn()
    await generateFileSummary('f1', 'text', 'p1', 'm1', engine(), controller.signal, undefined, onSave)
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('kms-index-llm-helpers / updateParagraphSummaries', () => {
  const makeEngine = () => ({ updateParagraphSummary: vi.fn(), indexParagraph: vi.fn() }) as any
  const paragraphs = [
    { title: 'A', titlePath: 'A', level: 1, paragraphIndex: 0, startOffset: 0, endOffset: 10 },
    { title: 'B', titlePath: 'A > B', level: 2, paragraphIndex: 5, startOffset: 10, endOffset: 20 },
  ]

  it('summary 与 keywords 均为空时跳过', () => {
    const engine = makeEngine()
    updateParagraphSummaries('f1', paragraphs, [{ id: 'p0', paragraphIndex: 0 }], [{ title: 'A', summary: '', keywords: [] }], engine)
    expect(engine.updateParagraphSummary).not.toHaveBeenCalled()
  })

  it('按 paragraphIndex 映射（候选跳号不会错位）', () => {
    const engine = makeEngine()
    updateParagraphSummaries(
      'f1',
      paragraphs,
      [{ id: 'p5', paragraphIndex: 5 }],
      [{ title: 'B', summary: 'S', keywords: ['k'], paragraphIndex: 5 }],
      engine,
    )
    expect(engine.updateParagraphSummary).toHaveBeenCalledWith('p5', 'S', ['k'])
    expect(engine.indexParagraph).toHaveBeenCalledWith('f1', 'p5', 'B', 'A > B', 'S', ['k'], 10, 20)
  })

  it('未提供 paragraphIndex 时回退用数组下标', () => {
    const engine = makeEngine()
    updateParagraphSummaries('f1', paragraphs, [{ id: 'p0', paragraphIndex: 0 }], [{ title: 'A', summary: 'S', keywords: ['k'] }], engine)
    expect(engine.updateParagraphSummary).toHaveBeenCalledWith('p0', 'S', ['k'])
  })

  it('目标段落未保存时跳过', () => {
    const engine = makeEngine()
    updateParagraphSummaries('f1', paragraphs, [{ id: 'p9', paragraphIndex: 9 }], [{ title: 'A', summary: 'S', keywords: ['k'] }], engine)
    expect(engine.updateParagraphSummary).not.toHaveBeenCalled()
  })

  it('paragraphs 中缺少对应序号时只更新摘要索引', () => {
    const engine = makeEngine()
    updateParagraphSummaries(
      'f1',
      [],
      [{ id: 'p0', paragraphIndex: 0 }],
      [{ title: 'A', summary: 'S', keywords: ['k'], paragraphIndex: 0 }],
      engine,
    )
    expect(engine.updateParagraphSummary).toHaveBeenCalledWith('p0', 'S', ['k'])
    expect(engine.indexParagraph).not.toHaveBeenCalled()
  })

  it('多条摘要按各自 paragraphIndex 写入', () => {
    const engine = makeEngine()
    updateParagraphSummaries(
      'f1',
      paragraphs,
      [{ id: 'p0', paragraphIndex: 0 }, { id: 'p5', paragraphIndex: 5 }],
      [
        { title: 'A', summary: 'SA', keywords: ['a'], paragraphIndex: 0 },
        { title: 'B', summary: 'SB', keywords: ['b'], paragraphIndex: 5 },
      ],
      engine,
    )
    expect(engine.updateParagraphSummary.mock.calls).toEqual([['p0', 'SA', ['a']], ['p5', 'SB', ['b']]])
  })
})
