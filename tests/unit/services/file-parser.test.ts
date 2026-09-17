/**
 * 文件解析服务单测（OCR 打桩，Excel 走真实 SheetJS）：
 * - getFileType 扩展名分发（大小写、无扩展名、多段扩展名、未支持类型）
 * - parseFilePath 路由与错误路径（不支持类型、AbortSignal 已中止）
 * - 纯文本类解析（txt/md/html）与 splitIntoSections 的分节/降级规则
 * - 图片走 OCR（打桩）与元数据透传
 * - Excel 解析的 !ref 预截断（行/列上限）、单元格总量上限、CSV 支持
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as XLSX from 'xlsx'

const mockState = vi.hoisted(() => ({
  ocrText: 'OCR 识别文本',
  ocrError: null as Error | null,
  ocrCalls: [] as string[],
}))

vi.mock('../../../electron/main/services/ocr.service', () => ({
  default: {
    getInstance: () => ({
      initialize: async () => undefined,
      recognize: async (filePath: string) => {
        mockState.ocrCalls.push(filePath)
        if (mockState.ocrError) throw mockState.ocrError
        return {
          text: mockState.ocrText,
          engine: 'paddleocr-mock',
          confidence: 0.98,
          blocks: [{ text: '块1' }],
        }
      },
    }),
  },
}))

import FileParserService from '../../../electron/main/services/file-parser.service'

const service = FileParserService.getInstance()
const priv = service as any

let root = ''

function tmpFile(name: string, content: string | Buffer): string {
  const p = path.join(root, name)
  fs.writeFileSync(p, content as any)
  return p
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-parser-test-'))
  mockState.ocrText = 'OCR 识别文本'
  mockState.ocrError = null
  mockState.ocrCalls.length = 0
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('file-parser / getFileType', () => {
  it('按扩展名分发且大小写不敏感', () => {
    expect(priv.getFileType('/a/b.PDF')).toBe('pdf')
    expect(priv.getFileType('/a/b.DocX')).toBe('docx')
    expect(priv.getFileType('c:\\x\\y.MD')).toBe('md')
    expect(priv.getFileType('photo.JPEG')).toBe('jpeg')
  })

  it('未支持或缺失扩展名 → unknown', () => {
    expect(priv.getFileType('file.zip')).toBe('unknown')
    expect(priv.getFileType('noext')).toBe('unknown')
    expect(priv.getFileType('')).toBe('unknown')
    expect(priv.getFileType('trailing.')).toBe('unknown')
  })

  it('多段扩展名只取最后一段', () => {
    expect(priv.getFileType('archive.tar.gz')).toBe('unknown')
    expect(priv.getFileType('data.backup.csv')).toBe('csv')
  })
})

describe('file-parser / parseFilePath 路由与错误', () => {
  it('未支持类型抛错并带类型名', async () => {
    const p = tmpFile('a.zip', 'x')
    await expect(service.parseFilePath(p)).rejects.toThrow('Unsupported file type: unknown')
  })

  it('已中止的 AbortSignal → AbortError', async () => {
    const p = tmpFile('a.txt', 'hello')
    const controller = new AbortController()
    controller.abort()
    await expect(service.parseFilePath(p, controller.signal)).rejects.toThrow(/Parse cancelled/)
  })

  it('txt 解析：全文与分节', async () => {
    const content = '# 标题\n正文一行\n正文二行\n正文三行'
    const p = tmpFile('a.txt', content)
    const r = await service.parseFilePath(p)
    expect(r.type).toBe('txt')
    expect(r.fullText).toBe(content)
    expect(r.sections).toEqual([
      { title: '# 标题', content: '正文一行\n正文二行\n正文三行\n', level: 1 },
    ])
    expect(r.tables).toEqual([])
  })

  it('md / html 解析复用纯文本通道', async () => {
    const md = await service.parseFilePath(tmpFile('a.md', '## H\nb1\nb2\nb3'))
    expect(md.type).toBe('md')
    expect(md.sections[0]).toMatchObject({ title: '## H', level: 2 })

    const html = await service.parseFilePath(tmpFile('a.html', '<p>hi</p>'))
    expect(html.type).toBe('html')
    expect(html.fullText).toBe('<p>hi</p>')
  })

  it('空文本文件返回空 sections', async () => {
    const r = await service.parseFilePath(tmpFile('empty.txt', '   \n\n'))
    expect(r.fullText).toBe('   \n\n')
    expect(r.sections).toEqual([])
  })
})

describe('file-parser / 图片走 OCR', () => {
  it('识别结果与元数据透传', async () => {
    const p = tmpFile('a.png', 'fake-image')
    const r = await service.parseFilePath(p)
    expect(mockState.ocrCalls).toEqual([p])
    expect(r.type).toBe('image')
    expect(r.fullText).toBe('OCR 识别文本')
    expect(r.metadata).toMatchObject({ ocrEngine: 'paddleocr-mock', confidence: 0.98 })
    expect((r.metadata as any).blocks).toHaveLength(1)
  })

  it('OCR 抛错时向上抛出（不吞错）', async () => {
    mockState.ocrError = new Error('ocr down')
    const p = tmpFile('b.jpg', 'fake')
    await expect(service.parseFilePath(p)).rejects.toThrow('ocr down')
  })

  it('webp/tiff/bmp 也路由到 OCR', async () => {
    for (const ext of ['webp', 'tiff', 'bmp', 'jpeg']) {
      const r = await service.parseFilePath(tmpFile(`c.${ext}`, 'x'))
      expect(r.type).toBe('image')
    }
  })
})

describe('file-parser / splitIntoSections', () => {
  it('空文本与纯空白返回空数组', () => {
    expect(priv.splitIntoSections('')).toEqual([])
    expect(priv.splitIntoSections('  \n\n \t')).toEqual([])
  })

  it('无标题文本降级为单个全文节', () => {
    const r = priv.splitIntoSections('第一行\n第二行')
    expect(r).toEqual([{ title: '全文', content: '第一行\n第二行', level: 1 }])
  })

  it('标题密度过高（>30%）时降级为全文，避免误切碎', () => {
    const text = ['# a', '# b', '# c', '普通内容'].join('\n')
    expect(priv.splitIntoSections(text)).toEqual([{ title: '全文', content: text, level: 1 }])
  })

  it('按标题分节并保留正文（含换行）', () => {
    const text = '# 一\n甲1\n甲2\n甲3\n## 二\n乙1\n乙2\n乙3'
    expect(priv.splitIntoSections(text)).toEqual([
      { title: '# 一', content: '甲1\n甲2\n甲3\n', level: 1 },
      { title: '## 二', content: '乙1\n乙2\n乙3\n', level: 2 },
    ])
  })

  it('中文章节标题识别为 level 1', () => {
    const r = priv.splitIntoSections('第一章 概述\n内容1\n内容2\n内容3')
    expect(r[0]).toMatchObject({ title: '第一章 概述', level: 1 })
  })

  it('编号型标题（1.1 / 1.）默认 level 2', () => {
    const r = priv.splitIntoSections('1.1 小节\n内容1\n内容2\n内容3')
    expect(r[0].level).toBe(2)
    const r2 = priv.splitIntoSections('1. 条目\n内容1\n内容2\n内容3')
    expect(r2[0].level).toBe(2)
  })

  it('超长（≥100 字）标题不被识别，整篇降级为全文', () => {
    const longHeading = `# ${'x'.repeat(120)}`
    const r = priv.splitIntoSections(`${longHeading}\n正文`)
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('全文')
  })

  it('首个标题之前的内容作为「前言」分节保留', () => {
    const r = priv.splitIntoSections('前言内容\n# 标题\n正文1\n正文2')
    expect(r).toEqual([
      { title: '前言', content: '前言内容\n', level: 1 },
      { title: '# 标题', content: '正文1\n正文2\n', level: 1 },
    ])
  })

  it('无前言时不会产生多余分节', () => {
    const r = priv.splitIntoSections('# 标题\n正文1\n正文2\n正文3')
    expect(r).toEqual([{ title: '# 标题', content: '正文1\n正文2\n正文3\n', level: 1 }])
  })
})

describe('file-parser / Excel 解析保护与结果', () => {
  it('普通表格：fullText 按 Sheet 分段、每行以 Tab 连接，tables 含表头', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([
      ['姓名', '年龄'],
      ['张三', 30],
      ['李四', 25],
    ])
    XLSX.utils.book_append_sheet(wb, ws, '人员')
    const p = path.join(root, 'data.xlsx')
    XLSX.writeFile(wb, p)

    const r = await service.parseFilePath(p)
    expect(r.type).toBe('excel')
    expect(r.fullText).toContain('--- Sheet: 人员 ---')
    expect(r.fullText).toContain('姓名\t年龄')
    expect(r.sections).toEqual([])
    expect(r.tables).toHaveLength(1)
    expect(r.tables[0].headers).toEqual(['姓名', '年龄'])
    expect(r.tables[0].rows).toEqual([['张三', '30'], ['李四', '25']])
    expect((r.metadata as any).sheetNames).toEqual(['人员'])
    expect((r.metadata as any).parser).toBe('sheetjs')
  })

  it('!ref 行数超上限时截断到 10000 行（防止高位行号内存爆炸）', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['h1', 'h2'], ['a', 'b']])
    ws['!ref'] = 'A1:B20001'
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const p = path.join(root, 'huge-rows.xlsx')
    XLSX.writeFile(wb, p)

    const r = await service.parseFilePath(p)
    expect(r.tables[0].headers).toEqual(['h1', 'h2'])
    expect(r.tables[0].rows.length).toBeLessThanOrEqual(9999)
  })

  it('!ref 列数超上限时按 256 列截断（防止 XFD 巨列展开）', async () => {
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([['a', 'b']])
    ws['!ref'] = 'A1:ZZ5'
    XLSX.utils.book_append_sheet(wb, ws, 'Wide')
    const p = path.join(root, 'wide-cols.xlsx')
    XLSX.writeFile(wb, p)

    const r = await service.parseFilePath(p)
    expect(r.tables[0].headers).toHaveLength(256)
  })

  it('空表：fullText 为空且无 tables', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Empty')
    const p = path.join(root, 'empty.xlsx')
    XLSX.writeFile(wb, p)

    const r = await service.parseFilePath(p)
    expect(r.fullText).toBe('')
    expect(r.tables).toEqual([])
  })

  it('多 Sheet：各自成段并进入 tables', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['A1'], ['A2']]), 'SheetA')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['B1']]), 'SheetB')
    const p = path.join(root, 'multi.xlsx')
    XLSX.writeFile(wb, p)

    const r = await service.parseFilePath(p)
    expect(r.tables.map(t => t.context)).toEqual(['Sheet: SheetA', 'Sheet: SheetB'])
    expect(r.fullText).toContain('--- Sheet: SheetA ---')
    expect(r.fullText).toContain('--- Sheet: SheetB ---')
  })

  it('csv 走同一 Excel 通道', async () => {
    const p = tmpFile('data.csv', 'a,b\n1,2\n')
    const r = await service.parseFilePath(p)
    expect(r.type).toBe('excel')
    expect(r.tables[0].headers).toEqual(['a', 'b'])
    expect(r.tables[0].rows).toEqual([['1', '2']])
  })
})
