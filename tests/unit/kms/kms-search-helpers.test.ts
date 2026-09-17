import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  computeEmbeddingEntriesBytes,
  extractQueryKeywords,
  buildFtsQuery,
  buildLikeWhereClause,
  buildFtsWhereClause,
  cosineSimilarity,
  norm,
  getResultKey,
} from '../../../electron/main/services/kms/kms-search-helpers'
import type { EmbeddingEntry, SearchResult } from '../../../electron/main/services/kms/kms-search-types'

const tokenizerMock = vi.hoisted(() => ({ segmentForSearch: vi.fn(() => ['知识库']) }))

vi.mock('../../../electron/main/services/kms/kms-tokenizer.service', () => ({
  default: tokenizerMock,
}))

function makeEntry(id: string): EmbeddingEntry {
  return {
    id,
    embedding: new Float32Array(4),
    sourceType: 'file',
    sourceId: 's1',
    fileId: 'f1',
    model: 'test-model',
  } as unknown as EmbeddingEntry
}

describe('kms-search-helpers / computeEmbeddingEntriesBytes', () => {
  it('按字符串长度*2 + embedding 字节累加', () => {
    const entries = [makeEntry('a'), makeEntry('bb')]
    const total = computeEmbeddingEntriesBytes(entries)
    const base = 16 // Float32Array(4).byteLength
    const perEntry = (idLen: number) => base + (idLen + 4 + 2 + 2 + 10) * 2
    expect(total).toBe(perEntry(1) + perEntry(2))
  })

  it('空数组返回 0', () => {
    expect(computeEmbeddingEntriesBytes([])).toBe(0)
  })
})

describe('kms-search-helpers / buildFtsQuery', () => {
  it('单关键词包裹为短语前缀查询', () => {
    expect(buildFtsQuery(['知识库'])).toBe('"知识库"*')
  })

  it('多关键词 OR 连接', () => {
    expect(buildFtsQuery(['a', 'b'])).toBe('"a"* OR "b"*')
  })

  it('关键词内双引号转义', () => {
    expect(buildFtsQuery(['he"llo'])).toBe('"he""llo"*')
  })

  it('FTS 特殊字符被移除（同一关键词内清理后仍是一个 token）', () => {
    expect(buildFtsQuery(['a*b(c)^d-e+f:g'])).toBe('"abcdefg"*')
    expect(buildFtsQuery(['abc', 'd-e'])).toBe('"abc"* OR "de"*')
  })

  it('全部被清理为空时返回兜底查询', () => {
    expect(buildFtsQuery(['***', '++'])).toBe('""*')
  })

  it('空数组返回兜底查询', () => {
    expect(buildFtsQuery([])).toBe('""*')
  })
})

describe('kms-search-helpers / buildLikeWhereClause', () => {
  it('无选项返回恒真条件', () => {
    const r = buildLikeWhereClause()
    expect(r.whereClause).toBe('1=1')
    expect(r.params).toEqual([])
  })

  it('fileIds/sourceTypes 生成 IN 占位符', () => {
    const r = buildLikeWhereClause({ fileIds: ['f1', 'f2'], sourceTypes: ['file'] })
    expect(r.whereClause).toContain('si.file_id IN (?,?)')
    expect(r.whereClause).toContain('si.source_type IN (?)')
    expect(r.params).toEqual(['f1', 'f2', 'file'])
  })

  it('时间范围/扩展名/集合/目录条件', () => {
    const r = buildLikeWhereClause({
      timeRangeStart: 100,
      timeRangeEnd: 200,
      fileExtensions: ['.md'],
      collectionIds: ['c1'],
      dirIds: ['d1'],
    })
    expect(r.whereClause).toContain('f.modified_time >= ?')
    expect(r.whereClause).toContain('f.modified_time <= ?')
    expect(r.whereClause).toContain('f.file_ext IN (?)')
    expect(r.whereClause).toContain('kms_file_collections')
    expect(r.whereClause).toContain('dir_id IN')
    expect(r.params).toEqual([100, 200, '.md', 'c1', 'd1'])
  })

  it('仅 timeRangeEnd 时也生成条件', () => {
    const r = buildLikeWhereClause({ timeRangeEnd: 200 })
    expect(r.whereClause).toContain('<=')
    expect(r.whereClause).not.toContain('>=')
  })

  it('空数组选项不生成条件', () => {
    const r = buildLikeWhereClause({ fileIds: [], sourceTypes: [] })
    expect(r.whereClause).toBe('1=1')
    expect(r.params).toEqual([])
  })
})

describe('kms-search-helpers / buildFtsWhereClause', () => {
  it('时间范围时追加 f.id = kms_fts.file_id 关联', () => {
    const r = buildFtsWhereClause({ timeRangeStart: 1 })
    expect(r.whereClause).toContain('f.id = kms_fts.file_id')
  })

  it('各过滤条件使用 kms_fts 前缀', () => {
    const r = buildFtsWhereClause({ fileIds: ['f1'] })
    expect(r.whereClause).toContain('kms_fts.file_id IN (?)')
  })
})

describe('kms-search-helpers / cosineSimilarity', () => {
  it('相同向量相似度为 1', () => {
    const v = new Float32Array([1, 2, 3])
    expect(cosineSimilarity(v, v)).toBeCloseTo(1)
  })

  it('正交向量相似度为 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0)
  })

  it('反向向量相似度为 -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1)
  })

  it('空向量/无效输入返回 0', () => {
    expect(cosineSimilarity(new Float32Array(0), new Float32Array([1]))).toBe(0)
    expect(cosineSimilarity(null as any, new Float32Array([1]))).toBe(0)
    expect(cosineSimilarity(new Float32Array([1]), null as any)).toBe(0)
  })

  it('零向量返回 0（不产生 NaN）', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0)
  })

  it('预提供 normA 时不再重复计算', () => {
    const a = new Float32Array([3, 0])
    const b = new Float32Array([0, 4])
    // normA 正确传入时结果为 0；若误用 normA 会得到非 0
    expect(cosineSimilarity(a, b, 3)).toBe(0)
  })

  it('维度不匹配返回 0（截断会产生无意义分数污染排序）', () => {
    const s = cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]))
    expect(s).toBe(0)
  })
})

describe('kms-search-helpers / norm', () => {
  it('3-4-5 向量模为 5', () => {
    expect(norm(new Float32Array([3, 4]))).toBe(5)
  })

  it('空向量/无效输入返回 0', () => {
    expect(norm(new Float32Array(0))).toBe(0)
    expect(norm(null as any)).toBe(0)
  })
})

describe('kms-search-helpers / getResultKey', () => {
  it('带 paragraph_id 时键与向量侧格式一致（match_type-段落id）', () => {
    const r = { paragraph_id: 'p1', file_id: 'f1', match_type: 'paragraph' } as unknown as SearchResult
    expect(getResultKey(r)).toBe('paragraph-p1')
    const cp = { paragraph_id: 'p1', file_id: 'f1', match_type: 'content_paragraph' } as unknown as SearchResult
    expect(getResultKey(cp)).toBe('content_paragraph-p1')
  })

  it('无 paragraph_id 的 content_paragraph 使用 file_id + start_offset', () => {
    const r = { file_id: 'f1', match_type: 'content_paragraph', start_offset: 42 } as unknown as SearchResult
    expect(getResultKey(r)).toBe('content-f1-42')
  })

  it('其他情况使用 match_type + file_id', () => {
    const r = { file_id: 'f1', match_type: 'keyword' } as unknown as SearchResult
    expect(getResultKey(r)).toBe('keyword-f1')
  })
})

describe('kms-search-helpers / buildFtsQuery 边界补充', () => {
  it('空白关键词被清理后剔除（不产生空 token）', () => {
    expect(buildFtsQuery(['   ', 'a'])).toBe('"a"*')
  })

  it('< > ~ 等运算符字符被移除', () => {
    expect(buildFtsQuery(['a<b>c~d'])).toBe('"abcd"*')
  })

  it('FTS5 逻辑运算符被引号包裹，不构成语法注入', () => {
    expect(buildFtsQuery(['OR'])).toBe('"OR"*')
    expect(buildFtsQuery(['NOT', 'NEAR'])).toBe('"NOT"* OR "NEAR"*')
  })

  it('重复关键词不去重（保持原样顺序）', () => {
    expect(buildFtsQuery(['a', 'a'])).toBe('"a"* OR "a"*')
  })

  it('超长关键词不截断', () => {
    const k = 'x'.repeat(5000)
    expect(buildFtsQuery([k])).toBe(`"${k}"*`)
  })
})

describe('kms-search-helpers / buildLikeWhereClause 边界补充', () => {
  it('timeRangeStart/End 为 0（epoch）时仍生成条件', () => {
    const r = buildLikeWhereClause({ timeRangeStart: 0, timeRangeEnd: 0 })
    expect(r.whereClause).toContain('f.modified_time >= ?')
    expect(r.whereClause).toContain('f.modified_time <= ?')
    expect(r.params).toEqual([0, 0])
  })

  it('负数时间范围仍生成条件', () => {
    const r = buildLikeWhereClause({ timeRangeStart: -1 })
    expect(r.whereClause).toContain('f.modified_time >= ?')
    expect(r.params).toEqual([-1])
  })

  it('全量过滤条件：参数顺序与占位符数量一致', () => {
    const r = buildLikeWhereClause({
      fileIds: ['f1', 'f2'],
      sourceTypes: ['file_title', 'paragraph'],
      timeRangeStart: 10,
      timeRangeEnd: 20,
      fileExtensions: ['.md', '.txt'],
      collectionIds: ['c1', 'c2'],
      dirIds: ['d1', 'd2'],
    })
    expect(r.params).toEqual(['f1', 'f2', 'file_title', 'paragraph', 10, 20, '.md', '.txt', 'c1', 'c2', 'd1', 'd2'])
    const placeholders = (r.whereClause.match(/\?/g) || []).length
    expect(placeholders).toBe(r.params.length)
  })

  it('空字符串元素仍生成条件（仅按数组长度判断）', () => {
    const r = buildLikeWhereClause({ fileIds: [''], sourceTypes: [''] })
    expect(r.whereClause).toContain('si.file_id IN (?)')
    expect(r.params).toEqual(['', ''])
  })
})

describe('kms-search-helpers / buildFtsWhereClause 边界补充', () => {
  it('无选项返回恒真条件', () => {
    expect(buildFtsWhereClause()).toEqual({ whereClause: '1=1', params: [] })
  })

  it('仅 timeRangeEnd 时同样追加关联与上界', () => {
    const r = buildFtsWhereClause({ timeRangeEnd: 200 })
    expect(r.whereClause).toContain('f.id = kms_fts.file_id')
    expect(r.whereClause).toContain('f.modified_time <= ?')
    expect(r.whereClause).not.toContain('>=')
    expect(r.params).toEqual([200])
  })

  it('timeRangeStart 为 0 时同样追加关联表与条件', () => {
    const r = buildFtsWhereClause({ timeRangeStart: 0 })
    expect(r.whereClause).toBe('1=1 AND f.id = kms_fts.file_id AND f.modified_time >= ?')
    expect(r.params).toEqual([0])
  })

  it('collectionIds / dirIds 使用 kms_fts.file_id 子查询', () => {
    const r = buildFtsWhereClause({ collectionIds: ['c1'], dirIds: ['d1'] })
    expect(r.whereClause).toContain('kms_fts.file_id IN (SELECT file_id FROM kms_file_collections')
    expect(r.whereClause).toContain('kms_fts.file_id IN (SELECT id FROM kms_files')
    expect(r.params).toEqual(['c1', 'd1'])
  })
})

describe('kms-search-helpers / extractQueryKeywords', () => {
  beforeEach(() => tokenizerMock.segmentForSearch.mockClear())

  it('空串/纯空白返回空数组且不调用分词器', () => {
    expect(extractQueryKeywords('')).toEqual([])
    expect(extractQueryKeywords('   \n\t ')).toEqual([])
    expect(tokenizerMock.segmentForSearch).not.toHaveBeenCalled()
  })

  it('查询词先转小写与 trim 再分词', () => {
    tokenizerMock.segmentForSearch.mockReturnValueOnce(['kms', '检索'])
    expect(extractQueryKeywords('  KMS 检索  ')).toEqual(['kms', '检索'])
    expect(tokenizerMock.segmentForSearch).toHaveBeenCalledWith('kms 检索')
  })

  it('分词结果原样透传（含重复项）', () => {
    tokenizerMock.segmentForSearch.mockReturnValueOnce(['a', 'a'])
    expect(extractQueryKeywords('A')).toEqual(['a', 'a'])
  })
})

describe('kms-search-helpers / cosineSimilarity 边界补充', () => {
  it('显式传入 normA=0 时短路返回 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([1, 1]), 0)).toBe(0)
  })

  it('向量含 NaN 时结果为 NaN（无 NaN 防御）', () => {
    expect(Number.isNaN(cosineSimilarity(new Float32Array([NaN, 1]), new Float32Array([1, 1])))).toBe(true)
  })

  it('同向缩放向量相似度为 1', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([10, 20]))).toBeCloseTo(1)
  })

  it('维度不匹配优先于 normA 生效（返回 0）', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2]), 3)).toBe(0)
  })

  it('单维向量', () => {
    expect(cosineSimilarity(new Float32Array([5]), new Float32Array([2]))).toBeCloseTo(1)
    expect(cosineSimilarity(new Float32Array([5]), new Float32Array([-2]))).toBeCloseTo(-1)
  })
})

describe('kms-search-helpers / norm 边界补充', () => {
  it('单元素向量模为绝对值', () => {
    expect(norm(new Float32Array([-3]))).toBe(3)
  })

  it('含 NaN 时返回 NaN', () => {
    expect(Number.isNaN(norm(new Float32Array([NaN])))).toBe(true)
  })

  it('含 Infinity 时返回 Infinity', () => {
    expect(norm(new Float32Array([Infinity]))).toBe(Infinity)
  })
})

describe('kms-search-helpers / computeEmbeddingEntriesBytes 边界补充', () => {
  it('embedding 字节数按 Float32Array 实际长度计算', () => {
    const entry = { ...makeEntry('a'), embedding: new Float32Array(128) } as unknown as EmbeddingEntry
    const single = computeEmbeddingEntriesBytes([entry])
    expect(single).toBe(128 * 4 + (1 + 4 + 2 + 2 + 10) * 2)
  })

  it('字段缺失（undefined）时抛 TypeError，无防御性兜底', () => {
    const broken = { embedding: new Float32Array(1) } as unknown as EmbeddingEntry
    expect(() => computeEmbeddingEntriesBytes([broken])).toThrow(TypeError)
  })

  it('极大数组累加不溢出（100k 条）', () => {
    const entries = Array.from({ length: 100_000 }, () => makeEntry('a'))
    const total = computeEmbeddingEntriesBytes(entries)
    expect(total).toBe(entries.length * (16 + (1 + 4 + 2 + 2 + 10) * 2))
    expect(Number.isSafeInteger(total)).toBe(true)
  })
})
