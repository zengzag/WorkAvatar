import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const state = vi.hoisted(() => ({
  responders: [] as Array<{ match: string; respond: () => any }>,
  sqlLog: [] as string[],
  accessLog: [] as Array<{ fileId: string; type: string }>,
  parseCalls: [] as Array<{ filePath: string; mode?: string }>,
  parseResult: { fullText: '' } as any,
  parseError: null as any,
}))

vi.mock('../../../electron/main/services/kms/kms-database.service', () => ({
  default: {
    getInstance: () => ({
      getDb: () => ({
        prepare: (sql: string) => {
          const normalized = sql.replace(/\s+/g, ' ').trim()
          state.sqlLog.push(normalized)
          const hit = state.responders.find(r => normalized.includes(r.match))
          if (hit) return hit.respond()
          return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }
        },
      }),
    }),
  },
}))

vi.mock('../../../electron/main/services/kms/kms-crawler.service', () => ({
  default: {
    getInstance: () => ({
      logFileAccess: (fileId: string, type: string) => { state.accessLog.push({ fileId, type }) },
    }),
  },
}))

vi.mock('../../../electron/main/services/file-parser.service', () => ({
  default: {
    getInstance: () => ({
      parseFilePath: async (filePath: string, _signal?: any, mode?: string) => {
        state.parseCalls.push({ filePath, mode })
        if (state.parseError) throw state.parseError
        return state.parseResult
      },
    }),
  },
}))

import KMSFileReaderService from '../../../electron/main/services/kms/kms-file-reader.service'

const reader = KMSFileReaderService.getInstance()

const onSql = (match: string, respond: () => any) => state.responders.push({ match, respond })
const storedContent = (rows: string[]) => onSql('AND content !=', () => ({ all: () => rows.map(content => ({ content })) }))
const fileRow = (row: any = { id: 'f1', file_name: 'a.md', file_path: 'C:/docs/a.md' }) =>
  onSql('FROM kms_files WHERE id', () => ({ get: () => row }))

let tmpDir = ''

beforeEach(() => {
  state.responders.length = 0
  state.sqlLog.length = 0
  state.accessLog.length = 0
  state.parseCalls.length = 0
  state.parseResult = { fullText: '' }
  state.parseError = null
})

describe('kms-file-reader / scanDirFiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kms-fr-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('递归扫描并按默认扩展名过滤，统计跳过数量', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'b.TXT'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'c.exe'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'noext'), 'x')
    fs.mkdirSync(path.join(tmpDir, 'sub'))
    fs.writeFileSync(path.join(tmpDir, 'sub', 'd.PDF'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'sub', 'e.json'), 'x')

    const out = reader.scanDirFiles(tmpDir)
    expect(out.files.map(f => path.basename(f)).sort()).toEqual(['a.md', 'b.TXT', 'd.PDF'])
    expect(out.skipped).toBe(3)
    for (const f of out.files) expect(path.isAbsolute(f)).toBe(true)
  })

  it('自定义扩展名支持无点与带点写法且大小写不敏感', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'b.json'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'c.JSON'), 'x')

    const out = reader.scanDirFiles(tmpDir, ['json', '.JSON'])
    expect(out.files.map(f => path.basename(f)).sort()).toEqual(['b.json', 'c.JSON'])
    expect(out.skipped).toBe(1)
  })

  it('扩展名数组为空时回退默认列表', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.md'), 'x')
    fs.writeFileSync(path.join(tmpDir, 'b.exe'), 'x')
    const out = reader.scanDirFiles(tmpDir, [])
    expect(out.files.map(f => path.basename(f))).toEqual(['a.md'])
    expect(out.skipped).toBe(1)
  })

  it('目录不存在返回空结果', () => {
    expect(reader.scanDirFiles(path.join(tmpDir, 'not-exist'))).toEqual({ files: [], skipped: 0 })
  })

  it('传入文件路径（非目录）返回空结果', () => {
    const file = path.join(tmpDir, 'a.md')
    fs.writeFileSync(file, 'x')
    expect(reader.scanDirFiles(file)).toEqual({ files: [], skipped: 0 })
  })

  it('空目录返回空结果', () => {
    expect(reader.scanDirFiles(tmpDir)).toEqual({ files: [], skipped: 0 })
  })

  it('深层嵌套目录可被递归扫描', () => {
    const deep = path.join(tmpDir, 'l1', 'l2', 'l3')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'deep.md'), 'x')
    const out = reader.scanDirFiles(tmpDir)
    expect(out.files).toHaveLength(1)
    expect(out.files[0]).toContain('l1')
  })
})

describe('kms-file-reader / 段落与 TOC 查询', () => {
  it('getFileParagraphs 按段落序号排序返回', () => {
    onSql('FROM kms_paragraphs WHERE file_id = ?', () => ({
      all: () => [{ id: 'p1', title: 'A', title_path: 'A', level: 1, paragraph_index: 0, start_offset: 0, end_offset: 10, summary: null, keywords_json: null }],
    }))
    const rows = reader.getFileParagraphs('f1')
    expect(rows).toHaveLength(1)
    expect(state.sqlLog[0]).toContain('ORDER BY paragraph_index ASC')
  })

  it('getFileToc 做 snake_case → camelCase 映射', () => {
    onSql('FROM kms_paragraphs WHERE file_id = ?', () => ({
      all: () => [
        { id: 'p1', title: 'A', title_path: 'A', level: 1, paragraph_index: 0, start_offset: 0, end_offset: 10 },
        { id: 'p2', title: 'B', title_path: 'A > B', level: 2, paragraph_index: 1, start_offset: 10, end_offset: 20 },
      ],
    }))
    expect(reader.getFileToc('f1')).toEqual([
      { id: 'p1', title: 'A', titlePath: 'A', level: 1, paragraphIndex: 0, startOffset: 0, endOffset: 10 },
      { id: 'p2', title: 'B', titlePath: 'A > B', level: 2, paragraphIndex: 1, startOffset: 10, endOffset: 20 },
    ])
  })

  it('getParagraphsByIds 传空数组直接返回且不查库', () => {
    expect(reader.getParagraphsByIds([])).toEqual([])
    expect(state.sqlLog).toHaveLength(0)
  })

  it('getParagraphsByIds 占位符数量与参数个数一致', () => {
    onSql('FROM kms_paragraphs p', () => ({ all: () => [{ id: 'p1' }] }))
    expect(reader.getParagraphsByIds(['p1', 'p2', 'p3'])).toEqual([{ id: 'p1' }])
    expect(state.sqlLog[0]).toContain('p.id IN (?,?,?)')
  })

  it('getParagraphContent 未命中返回 null', () => {
    onSql('WHERE id = ? AND file_id = ?', () => ({ get: () => undefined }))
    expect(reader.getParagraphContent('missing')).toBeNull()
  })

  it('getStoredFullContent 无段落行返回 null', () => {
    storedContent([])
    expect(reader.getStoredFullContent('f1')).toBeNull()
  })

  it('getStoredFullContent 多段落以空行连接', () => {
    storedContent(['第一段', '第二段', '第三段'])
    expect(reader.getStoredFullContent('f1')).toBe('第一段\n\n第二段\n\n第三段')
  })
})

describe('kms-file-reader / getFileContent', () => {
  it('文件不存在时抛错且不记录访问', async () => {
    onSql('FROM kms_files WHERE id', () => ({ get: () => undefined }))
    await expect(reader.getFileContent('missing')).rejects.toThrow('File not found')
    expect(state.accessLog).toHaveLength(0)
  })

  it('热数据优先使用已存储段落内容，不重新解析文件', async () => {
    fileRow()
    storedContent(['热数据内容'])
    const content = await reader.getFileContent('f1')
    expect(content).toBe('热数据内容')
    expect(state.parseCalls).toHaveLength(0)
    expect(state.accessLog).toEqual([{ fileId: 'f1', type: 'read' }])
  })

  it('提供 paragraphId 且命中时直接返回段落内容', async () => {
    fileRow()
    onSql('WHERE id = ? AND file_id = ?', () => ({ get: () => ({ content: '段落正文' }) }))
    storedContent(['不应该被使用'])
    expect(await reader.getFileContent('f1', { paragraphId: 'p1' })).toBe('段落正文')
  })

  it('paragraphId 未命中时回退到片段/全文路径', async () => {
    fileRow()
    onSql('WHERE id = ? AND file_id = ?', () => ({ get: () => undefined }))
    storedContent(['回退内容'])
    expect(await reader.getFileContent('f1', { paragraphId: 'p-miss' })).toBe('回退内容')
  })

  it('冷数据（无段落）回退解析文件，模式为 cold', async () => {
    fileRow()
    storedContent([])
    onSql('SELECT parse_mode FROM kms_file_summaries', () => ({ get: () => undefined }))
    state.parseResult = { fullText: '冷数据全文' }
    expect(await reader.getFileContent('f1')).toBe('冷数据全文')
    expect(state.parseCalls).toEqual([{ filePath: 'C:/docs/a.md', mode: 'cold' }])
  })

  it('parse_mode 为 file2md 时使用 hot 解析路径', async () => {
    fileRow()
    storedContent([])
    onSql('SELECT parse_mode FROM kms_file_summaries', () => ({ get: () => ({ parse_mode: 'file2md' }) }))
    state.parseResult = { fullText: 'hot 全文' }
    await reader.getFileContent('f1')
    expect(state.parseCalls[0].mode).toBe('hot')
  })

  it('parse_mode 为其他解析器时使用 cold 路径', async () => {
    fileRow()
    storedContent([])
    onSql('SELECT parse_mode FROM kms_file_summaries', () => ({ get: () => ({ parse_mode: 'pdf' }) }))
    await reader.getFileContent('f1')
    expect(state.parseCalls[0].mode).toBe('cold')
  })

  it('startOffset/endOffset 生效时按区间截取', async () => {
    fileRow()
    storedContent(['0123456789'])
    expect(await reader.getFileContent('f1', { startOffset: 2, endOffset: 5 })).toBe('234')
  })

  it('仅提供 startOffset 时不切片（需 offset 成对出现）', async () => {
    fileRow()
    storedContent(['0123456789'])
    expect(await reader.getFileContent('f1', { startOffset: 2 })).toBe('0123456789')
  })

  it('startLine 返回从该行起的 51 行窗口', async () => {
    fileRow()
    const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`)
    storedContent([lines.join('\n')])
    const out = await reader.getFileContent('f1', { startLine: 10 })
    const outLines = out.split('\n')
    expect(outLines).toHaveLength(51)
    expect(outLines[0]).toBe('L10')
    expect(outLines[50]).toBe('L60')
  })

  it('startLine 超出范围时返回空串', async () => {
    fileRow()
    storedContent(['只有一行'])
    expect(await reader.getFileContent('f1', { startLine: 999 })).toBe('')
  })

  it('maxChars 截断内容', async () => {
    fileRow()
    storedContent(['abcdefghij'])
    expect(await reader.getFileContent('f1', { maxChars: 4 })).toBe('abcd')
  })

  it('maxChars 默认 5000', async () => {
    fileRow()
    storedContent(['x'.repeat(6000)])
    expect((await reader.getFileContent('f1')).length).toBe(5000)
  })

  it('maxChars 为 0 时回退默认 5000（falsy 判断）', async () => {
    fileRow()
    storedContent(['x'.repeat(6000)])
    expect((await reader.getFileContent('f1', { maxChars: 0 })).length).toBe(5000)
  })

  it('maxChars 为负数时返回空串（substring 负索引）', async () => {
    fileRow()
    storedContent(['abcdef'])
    expect(await reader.getFileContent('f1', { maxChars: -5 })).toBe('')
  })

  it('解析失败时原样抛出异常', async () => {
    fileRow()
    storedContent([])
    state.parseError = new Error('parse boom')
    await expect(reader.getFileContent('f1')).rejects.toThrow('parse boom')
  })
})

describe('kms-file-reader / getFileSummary', () => {
  it('无摘要返回 null 且不记录访问', () => {
    onSql('SELECT * FROM kms_file_summaries', () => ({ get: () => undefined }))
    expect(reader.getFileSummary('f1')).toBeNull()
    expect(state.accessLog).toHaveLength(0)
  })

  it('有摘要时记录 summary_view 访问', () => {
    onSql('SELECT * FROM kms_file_summaries', () => ({ get: () => ({ file_id: 'f1', summary: 'S' }) }))
    expect(reader.getFileSummary('f1')).toEqual({ file_id: 'f1', summary: 'S' })
    expect(state.accessLog).toEqual([{ fileId: 'f1', type: 'summary_view' }])
  })
})

describe('kms-file-reader / getFileFullContent', () => {
  it('文件不存在时抛错', async () => {
    onSql('FROM kms_files WHERE id', () => ({ get: () => undefined }))
    await expect(reader.getFileFullContent('missing')).rejects.toThrow('File not found')
  })

  it('热数据返回完整内容且 truncated=false', async () => {
    fileRow()
    storedContent(['全文内容'])
    const out = await reader.getFileFullContent('f1')
    expect(out).toEqual({ content: '全文内容', fileName: 'a.md', filePath: 'C:/docs/a.md', truncated: false })
    expect(state.parseCalls).toHaveLength(0)
    expect(state.accessLog).toEqual([{ fileId: 'f1', type: 'read' }])
  })

  it('冷数据回退解析；fullText 缺失时降级为空串', async () => {
    fileRow()
    storedContent([])
    state.parseResult = {}
    const out = await reader.getFileFullContent('f1')
    expect(out.content).toBe('')
    expect(out.truncated).toBe(false)
  })

  it('内容超过 2000 万字符时截断并置 truncated=true', async () => {
    fileRow()
    storedContent(['x'.repeat(20_000_001)])
    const out = await reader.getFileFullContent('f1')
    expect(out.truncated).toBe(true)
    expect(out.content.length).toBe(20_000_000)
  })

  it('解析失败时原样抛出异常', async () => {
    fileRow()
    storedContent([])
    state.parseError = new Error('cold parse failed')
    await expect(reader.getFileFullContent('f1')).rejects.toThrow('cold parse failed')
  })
})
