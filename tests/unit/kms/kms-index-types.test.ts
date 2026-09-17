/**
 * kms-index-types.ts / kms-search-types.ts 为纯类型声明（无运行时逻辑）。
 * 这里只做「契约层面」的守护测试：
 *  - 两个模块不导出任何运行时值（防止误加运行时代码导致类型文件被意外执行）
 *  - 关键联合类型的候选值列表保持稳定（消费方进度值由 kms-auto-index.test.ts 覆盖）
 *  - 各接口的必填字段在运行时确实存在，避免以 `as` 绕过类型检查
 */
import { describe, it, expect } from 'vitest'
import * as indexTypes from '../../../electron/main/services/kms/kms-index-types'
import * as searchTypes from '../../../electron/main/services/kms/kms-search-types'
import type {
  IndexPhase,
  IndexProgress,
  AutoIndexConfig,
  AutoIndexStatus,
  ProgressCallback,
} from '../../../electron/main/services/kms/kms-index-types'
import type { SearchResult, SearchOptions, EmbeddingEntry, SourceType, HighlightRange } from '../../../electron/main/services/kms/kms-search-types'

const INDEX_PHASES: IndexPhase[] = [
  'crawling',
  'parsing',
  'indexing',
  'toc',
  'paragraph_split',
  'paragraph_summary',
  'doc_summary',
  'collection_summary',
  'collection_embedding',
  'embedding',
  'done',
  'error',
]

const SOURCE_TYPES: SourceType[] = ['file_title', 'file_summary', 'paragraph', 'content_paragraph', 'file_name']

describe('kms-types / 类型模块的运行时契约', () => {
  it('两个类型模块都不导出运行时值', () => {
    expect(Object.keys(indexTypes)).toEqual([])
    expect(Object.keys(searchTypes)).toEqual([])
  })

  it('IndexPhase 候选值无重复且与实现保持一致', () => {
    expect(new Set(INDEX_PHASES).size).toBe(INDEX_PHASES.length)
    expect(INDEX_PHASES).toContain('error')
    expect(INDEX_PHASES).toContain('done')
  })

  it('SourceType 候选值无重复', () => {
    expect(new Set(SOURCE_TYPES).size).toBe(SOURCE_TYPES.length)
  })

  it('IndexProgress / AutoIndexStatus 必填字段在运行时存在', () => {
    const progress: IndexProgress = {
      phase: 'indexing',
      current: 1,
      total: 10,
      message: '处理中',
      cancelled: false,
    }
    expect(Object.keys(progress).sort()).toEqual(['cancelled', 'current', 'message', 'phase', 'total'])

    const config: AutoIndexConfig = { enabled: true, intervalMinutes: 5, stableThresholdMinutes: 3 }
    const status: AutoIndexStatus = {
      running: false,
      config,
      lastRunAt: 1_700_000_000,
      nextRunAt: 1_700_000_300,
      lastResult: { newFiles: 1, modifiedFiles: 2, deletedFiles: 3, skippedUnstableFiles: 4 },
    }
    expect(status.lastResult).toEqual({ newFiles: 1, modifiedFiles: 2, deletedFiles: 3, skippedUnstableFiles: 4 })

    const cb: ProgressCallback = (p) => { expect(p.phase).toBe('indexing') }
    cb(progress)
  })

  it('SearchResult / SearchOptions / EmbeddingEntry 必填字段可构造', () => {
    const highlight: HighlightRange = { start: 0, end: 3 }
    const result: SearchResult = {
      file_id: 'f1',
      file_name: 'a.md',
      file_path: 'C:/a.md',
      text: '文本',
      match_type: 'paragraph',
      highlights: [highlight],
    }
    expect(result.match_type).toBe('paragraph')

    const options: SearchOptions = {
      topK: 10,
      fileIds: ['f1'],
      sourceTypes: ['paragraph'],
      useVector: true,
      timeRangeStart: 0,
      timeRangeEnd: 0,
      fileExtensions: ['.md'],
      collectionIds: ['c1'],
      dirIds: ['d1'],
    }
    expect(Object.keys(options)).toHaveLength(9)

    const entry: EmbeddingEntry = {
      id: 'e1',
      sourceType: 'paragraph',
      sourceId: 'p1',
      fileId: 'f1',
      embedding: new Float32Array([1, 0]),
      model: 'm',
      dimension: 2,
    }
    expect(entry.embedding.byteLength).toBe(8)
  })
})
