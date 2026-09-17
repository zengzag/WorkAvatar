import { describe, it, expect } from 'vitest'
import {
  countWords,
  splitParagraphs,
  MAX_PARAGRAPH_CHARS,
  MIN_CONTENT_WORDS,
  needsTocRestoration,
  addLineNumbers,
  deduplicateTocEntries,
  validateTocEntries,
  buildTocContext,
  buildTocWithPath,
  identifyParagraphsFromLLMToc,
  filterTocByContentVolume,
  parseJSON,
  generateFileToc,
} from '../../../electron/main/services/kms/kms-paragraph-processor'
import type KMSSearchEngineService from '../../../electron/main/services/kms/kms-search-engine.service'

describe('kms-paragraph-processor / countWords', () => {
  it('空文本返回 0', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   \n  ')).toBe(0)
  })

  it('CJK 按字符计数', () => {
    expect(countWords('知识库系统')).toBe(5)
  })

  it('英文按词计数', () => {
    expect(countWords('hello world foo')).toBe(3)
  })

  it('中英混合', () => {
    expect(countWords('知识库 knowledge base 系统')).toBe(5 + 2)
  })

  it('数字与标点按词', () => {
    expect(countWords('v1.2, v1.3')).toBe(2)
  })
})

describe('kms-paragraph-processor / splitParagraphs', () => {
  it('无标题文本走固定分块，paragraphIndex 连续', () => {
    const text = Array.from({ length: 40 }, (_, i) => `这是无标题的第 ${i} 行内容，用于填充段落。`).join('\n')
    const paras = splitParagraphs(text, 'plain.txt')
    expect(paras.length).toBeGreaterThanOrEqual(1)
    expect(paras[0].title).toContain('段落')
    paras.forEach((p, i) => expect(p.paragraphIndex).toBe(i))
  })

  it('Markdown 标题切分并维护层级路径', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `正文内容第 ${i} 句，包含足够的字词来通过最小词数检查。`).join('\n')
    const text = `# 总览\n${body(6)}\n## 子节 A\n${body(6)}\n## 子节 B\n${body(6)}\n`
    const paras = splitParagraphs(text, 'doc.md')
    expect(paras.map(p => p.title)).toEqual(['总览', '子节 A', '子节 B'])
    expect(paras[1].titlePath).toBe('总览 > 子节 A')
    expect(paras[2].titlePath).toBe('总览 > 子节 B')
    expect(paras[2].level).toBe(2)
  })

  it('同级标题弹栈：新章节不携带旧子节路径', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `段落正文 ${i}，足够多的内容词通过阈值检查。`).join('\n')
    const text = `# 第一篇\n${body(6)}\n## 节 1\n${body(6)}\n# 第二篇\n${body(6)}\n`
    const paras = splitParagraphs(text, 'doc.md')
    expect(paras.map(p => p.title)).toEqual(['第一篇', '节 1', '第二篇'])
    expect(paras[2].titlePath).toBe('第二篇')
  })

  it('首个标题前的前言（词数足够时保留）', () => {
    const body = Array.from({ length: 8 }, (_, i) => `前言部分内容 ${i}，这里有足够的词汇量通过最小词数要求。`).join('\n')
    const text = `${body}\n# 正文标题\n${Array.from({ length: 6 }, (_, i) => `正文章节 ${i} 的内容行。`).join('\n')}\n`
    const paras = splitParagraphs(text, 'doc.md')
    expect(paras[0].title).toBe('前言')
    expect(paras[1].title).toBe('正文标题')
  })

  it('中文标题（第X章/一、/（一））被识别', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `章节内容行 ${i}，确保词数达到下限要求。`).join('\n')
    const text = `第一章 总则\n${body(6)}\n一、细则\n${body(6)}\n（一）附则\n${body(6)}\n`
    const paras = splitParagraphs(text, 'doc.txt')
    expect(paras[0].title).toBe('第一章 总则')
    expect(paras[0].level).toBe(1)
    expect(paras[1].title).toBe('一、细则')
    expect(paras[2].title).toBe('（一）附则')
    expect(paras[2].level).toBe(2)
  })

  it('含句末标点的行不误判为标题', () => {
    const text = `3. 这是一个列表项，含句号。\n第二行也是普通正文内容而已。`
    const paras = splitParagraphs(text, 'doc.txt')
    // 无标题 → 分块
    expect(paras[0].title).toContain('段落')
  })

  it('标题比例过高降级为分块', () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i++) {
      lines.push(`# 标题${i}`)
      lines.push(`少量内容 ${i}`)
    }
    const paras = splitParagraphs(lines.join('\n'), 'doc.md')
    expect(paras[0].title).toContain('段落')
  })

  it('全部段落词数不足时兜底为单一段落', () => {
    // 标题占比需低于 25%，否则降级分块
    const text = ['# 标题', ...Array.from({ length: 6 }, (_, i) => `短${i}`)].join('\n')
    const paras = splitParagraphs(text, 'tiny.md')
    expect(paras).toHaveLength(1)
    expect(paras[0].title).toBe('tiny.md')
  })

  it('段落偏移量与原文对齐', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `对齐测试正文 ${i}，词数需要足够多才行。`).join('\n')
    const text = `# A\n${body(6)}\n# B\n${body(6)}\n`
    const paras = splitParagraphs(text, 'doc.md')
    for (const p of paras) {
      expect(text.substring(p.startOffset, p.startOffset + p.content.length).trim()).not.toBe('')
    }
  })

  it('超长段落被二次切分且带重叠', () => {
    const longLine = '字'.repeat(MAX_PARAGRAPH_CHARS + 2000)
    const text = `# 长段落\n${longLine}\n`
    const paras = splitParagraphs(text, 'big.md')
    expect(paras.length).toBeGreaterThan(1)
    expect(paras[0].content.length).toBeLessThanOrEqual(MAX_PARAGRAPH_CHARS)
  })
})

describe('kms-paragraph-processor / needsTocRestoration', () => {
  it('无标题返回 true', () => {
    expect(needsTocRestoration('没有任何标题的普通文本\n第二行')).toBe(true)
  })

  it('标题密度足够返回 false', () => {
    const text = '# A\n' + 'x'.repeat(100) + '\n# B\n' + 'y'.repeat(100)
    expect(needsTocRestoration(text)).toBe(false)
  })

  it('单个标题承载过长内容返回 true', () => {
    const text = '# A\n' + 'z'.repeat(9000)
    expect(needsTocRestoration(text)).toBe(true)
  })
})

describe('kms-paragraph-processor / addLineNumbers', () => {
  it('添加 [Ln] 前缀且起始行号可配', () => {
    expect(addLineNumbers('a\nb')).toBe('[L1] a\n[L2] b')
    expect(addLineNumbers('a\nb', 10)).toBe('[L10] a\n[L11] b')
  })

  it('空文本返回空', () => {
    expect(addLineNumbers('')).toBe('[L1] ')
  })
})

describe('kms-paragraph-processor / deduplicateTocEntries', () => {
  it('行号相近且标题相似的去重', () => {
    const out = deduplicateTocEntries([
      { title: '第一章 总览', level: 1, lineNumber: 1 },
      { title: '第一章总览', level: 1, lineNumber: 3 },
      { title: '第二章 方法', level: 1, lineNumber: 100 },
    ])
    expect(out).toHaveLength(2)
    expect(out[0].lineNumber).toBe(1)
  })

  it('行号相距超过 3 不去重', () => {
    const out = deduplicateTocEntries([
      { title: '标题', level: 1, lineNumber: 1 },
      { title: '标题', level: 1, lineNumber: 10 },
    ])
    expect(out).toHaveLength(2)
  })

  it('空数组', () => {
    expect(deduplicateTocEntries([])).toEqual([])
  })
})

describe('kms-paragraph-processor / validateTocEntries', () => {
  const text = `前言内容\n第一章 标题甲\n正文行\n第二章 标题乙\n`

  it('精确行号命中并计算偏移', () => {
    const out = validateTocEntries(text, [{ title: '标题甲', level: 1, lineNumber: 2 }])
    expect(out).toHaveLength(1)
    expect(out[0].lineNumber).toBe(2)
    expect(out[0].offset).toBe(5) // '前言内容\n' 长度
  })

  it('行号漂移在 ±5 行内可纠正', () => {
    // '总览' 在全文无匹配 → 目标行 2（'第一章 标题甲'，≤10 字符）触发短行容忍
    const out = validateTocEntries(text, [{ title: '总览', level: 1, lineNumber: 2 }])
    expect(out[0].lineNumber).toBe(2)
    const out2 = validateTocEntries(text, [{ title: '标题乙', level: 1, lineNumber: 2 }])
    expect(out2[0].lineNumber).toBe(2) // 命中第 2 行（模糊匹配 2/3 重合）
  })

  it('字符重合度 ≥0.6 的不同标题会误命中（已知模糊匹配限制）', () => {
    // '标题甲' 与 '标题乙' 共享 '标题' 两字 → 2/3 ≥ 0.6 判为相似
    const out = validateTocEntries(text, [{ title: '标题乙', level: 1, lineNumber: 2 }])
    expect(out[0].lineNumber).toBe(2)
  })

  it('level 越界被过滤', () => {
    const out = validateTocEntries(text, [{ title: '标题甲', level: 5, lineNumber: 2 }])
    expect(out).toHaveLength(0)
  })

  it('完全找不到时：目标行为短行（≤10 字符）则容忍原行号', () => {
    const out = validateTocEntries(text, [{ title: '不存在的标题', level: 1, lineNumber: 3 }])
    expect(out[0].lineNumber).toBe(3)
  })

  it('空 title 条目被过滤', () => {
    expect(validateTocEntries(text, [{ title: '', level: 1, lineNumber: 1 }])).toHaveLength(0)
  })
})

describe('kms-paragraph-processor / buildTocContext', () => {
  it('空数组返回空串', () => {
    expect(buildTocContext([])).toBe('')
  })

  it('取最近 5 条并按层级缩进，[Ln] 前缀为行号', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ title: `T${i}`, level: (i % 3) + 1, lineNumber: i + 1 }))
    const ctx = buildTocContext(entries)
    expect(ctx).toContain('[L6] T5') // T5 行号 6
    expect(ctx).toContain('[L7] T6')
    expect(ctx).not.toContain('T0')
    expect(ctx).not.toContain('T1')
  })
})

describe('kms-paragraph-processor / identifyParagraphsFromLLMToc', () => {
  it('空条目返回空数组', () => {
    expect(identifyParagraphsFromLLMToc('text', [])).toEqual([])
  })

  it('按偏移切分并维护路径', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `TOC 切分正文 ${i}，保证词数超过下限。`).join('\n')
    const text = `# 章 A\n${body(6)}\n## 节 A1\n${body(6)}\n`
    const entries = [
      { title: '章 A', level: 1, lineNumber: 1, offset: 0 },
      { title: '节 A1', level: 2, lineNumber: 8, offset: text.indexOf('## 节 A1') },
    ]
    const paras = identifyParagraphsFromLLMToc(text, entries)
    expect(paras.map(p => p.title)).toEqual(['章 A', '节 A1'])
    expect(paras[1].titlePath).toBe('章 A > 节 A1')
  })
})

describe('kms-paragraph-processor / filterTocByContentVolume', () => {
  it('移除正文不足的条目', () => {
    const body = Array.from({ length: 10 }, (_, i) => `内容充足的一行 ${i}，词数足够。`).join('\n')
    const text = `# 满足\n${body}\n# 空洞\n短\n`
    const entries = [
      { title: '满足', level: 1, lineNumber: 1, offset: 0 },
      { title: '空洞', level: 1, lineNumber: 13, offset: text.indexOf('# 空洞') },
    ]
    const out = filterTocByContentVolume(text, entries)
    expect(out.map(e => e.title)).toEqual(['满足'])
  })

  it('空条目原样返回', () => {
    expect(filterTocByContentVolume('text', [])).toEqual([])
  })
})

describe('kms-paragraph-processor / buildTocWithPath', () => {
  it('构建层级路径', () => {
    const out = buildTocWithPath([
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
      { title: 'B', level: 2, lineNumber: 2, offset: 10 },
      { title: 'C', level: 1, lineNumber: 3, offset: 20 },
    ])
    expect(out.map(o => o.path)).toEqual(['A', 'A > B', 'C'])
  })
})

describe('kms-paragraph-processor / parseJSON', () => {
  it('裸 JSON', () => {
    expect(parseJSON('{"a":1}', null)).toEqual({ a: 1 })
  })

  it('```json 代码块包裹', () => {
    expect(parseJSON('```json\n{"a":1}\n```', null)).toEqual({ a: 1 })
  })

  it('前后混杂文本提取 {}', () => {
    expect(parseJSON('结果如下：{"a":1} 请查收', null)).toEqual({ a: 1 })
  })

  it('字符串内换行的非法 JSON 被修复', () => {
    const bad = '{"a":"line1\nline2"}'
    expect(parseJSON(bad, null)).toEqual({ a: 'line1\nline2' })
  })

  it('彻底非法返回 fallback', () => {
    expect(parseJSON('not json at all', { fb: true })).toEqual({ fb: true })
  })

  it('数组顶层 JSON（无 {} 时）原样解析', () => {
    expect(parseJSON('[1,2,3]', null)).toEqual([1, 2, 3])
  })
})

describe('kms-paragraph-processor / countWords 边界补充', () => {
  it('emoji 等非 CJK 字符按空白分组计 1 个词', () => {
    expect(countWords('😀😀')).toBe(1)
    expect(countWords('😀 知识')).toBe(3) // emoji(1) + 知(1) + 识(1)
  })

  it('连字符、下划线不断词', () => {
    expect(countWords('a-b_c')).toBe(1)
  })

  it('全角空格可被 trim', () => {
    expect(countWords('\u3000知识\u3000')).toBe(2)
  })

  it('null/undefined 抛错（无防御）', () => {
    expect(() => countWords(undefined as unknown as string)).toThrow(TypeError)
  })
})

describe('kms-paragraph-processor / splitParagraphs 边界补充', () => {
  it('空文本走分块并返回单条空内容段落', () => {
    const paras = splitParagraphs('', 'empty.md')
    expect(paras).toHaveLength(1)
    expect(paras[0].title).toBe('段落 1')
    expect(paras[0].content).toBe('')
    expect(paras[0].startOffset).toBe(0)
  })

  it('超长（≥100 字符）的行不被识别为标题', () => {
    const longLine = '# ' + 'x'.repeat(120)
    const paras = splitParagraphs(`${longLine}\n正文行`, 'long.md')
    expect(paras[0].title).toBe('段落 1')
  })

  it('含句末分号的行不被识别为标题', () => {
    const paras = splitParagraphs('# 标题；\n正文行', 'semi.md')
    expect(paras[0].title).toBe('段落 1')
  })

  it('标题占比恰好 25% 时保留标题切分', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `正文内容第 ${i} 行，用于凑足最小词数阈值。`).join('\n')
    // 4 非空行中 1 个标题 → ratio = 0.25，不触发降级（需 > 0.25）
    const text = `# A\n${body(3)}`
    const paras = splitParagraphs(text, 'ratio.md')
    expect(paras.map(p => p.title)).toEqual(['A'])
  })

  it('标题占比超过 25% 时降级为分块', () => {
    const short = Array.from({ length: 4 }, (_, i) => `第 ${i} 行正文，词数足够。`).join('\n')
    const text = `# A\n# B\n# C\n${short}`
    const paras = splitParagraphs(text, 'over.md')
    expect(paras[0].title).toBe('段落 1')
  })

  it('重叠分块的偏移量在重复内容下仍准确（按切分过程累积，不用 indexOf 反查）', () => {
    const body = (n: number) => '字'.repeat(n)
    const text = `# 长段落\n${body(2000)}\n${body(2000)}\n${body(2000)}`
    const paras = splitParagraphs(text, 'repeat.md')
    expect(paras).toHaveLength(2)
    // 第二块起点 = 标题行 offset 0 + 窗口 4500（重叠 500 字符）
    expect(paras[1].startOffset).toBe(4500)
    // 偏移必须与内容自洽：按偏移切原文即得该块内容
    expect(text.slice(paras[1].startOffset, paras[1].endOffset).trim()).toBe(paras[1].content)
  })

  it('重叠分块的偏移量在无标题重复内容下同样准确', () => {
    const text = 'A'.repeat(6005)
    const paras = splitParagraphs(text, 'repeat2.txt')
    expect(paras).toHaveLength(2)
    expect(paras[1].startOffset).toBe(4500)
  })

  it('超长前言被二次切分并按序号命名', () => {
    const preface = ['前'.repeat(2000), '前'.repeat(2000), '前'.repeat(2000)].join('\n')
    const text = `${preface}\n# 标题\n正文`
    const paras = splitParagraphs(text, 'preface.md')
    expect(paras[0].title).toBe('前言 (1)')
    expect(paras[1].title).toBe('前言 (2)')
  })
})

describe('kms-paragraph-processor / needsTocRestoration 边界补充', () => {
  it('空文本返回 true', () => {
    expect(needsTocRestoration('')).toBe(true)
  })

  it('密度恰好等于阈值（8000）时不触发恢复', () => {
    const text = `# A\n${'x'.repeat(8000 - 4)}`
    expect(text.length).toBe(8000)
    expect(needsTocRestoration(text)).toBe(false)
  })

  it('密度超过阈值 1 个字符即触发恢复', () => {
    const text = `# A\n${'x'.repeat(8001 - 4)}`
    expect(text.length).toBe(8001)
    expect(needsTocRestoration(text)).toBe(true)
  })
})

describe('kms-paragraph-processor / generateFileToc', () => {
  it('过滤前言与空标题并无正文内容写入，仅保存标题结构', () => {
    const saved: Array<{ fileId: string; json: string }> = []
    generateFileToc('f1', [
      { title: '前言', titlePath: '前言', level: 1, paragraphIndex: 0, startOffset: 0, endOffset: 10 },
      { title: '', titlePath: '', level: 1, paragraphIndex: 1, startOffset: 10, endOffset: 20 },
      { title: '章 A', titlePath: '章 A', level: 1, paragraphIndex: 2, startOffset: 20, endOffset: 30 },
      { title: '节 A1', titlePath: '章 A > 节 A1', level: 2, paragraphIndex: 3, startOffset: 30, endOffset: 40 },
    ], {
      saveFileToc: (fileId: string, json: string) => saved.push({ fileId, json }),
    } as unknown as KMSSearchEngineService)

    expect(saved).toHaveLength(1)
    expect(saved[0].fileId).toBe('f1')
    const toc = JSON.parse(saved[0].json)
    expect(toc).toEqual([
      { id: 2, title: '章 A', titlePath: '章 A', level: 1, paragraphIndex: 2, startOffset: 20, endOffset: 30 },
      { id: 3, title: '节 A1', titlePath: '章 A > 节 A1', level: 2, paragraphIndex: 3, startOffset: 30, endOffset: 40 },
    ])
  })

  it('全部条目被过滤时仍写入空数组', () => {
    let json = ''
    generateFileToc('f1', [
      { title: '前言', titlePath: '前言', level: 1, paragraphIndex: 0, startOffset: 0, endOffset: 1 },
    ], {
      saveFileToc: (_fileId: string, j: string) => { json = j },
    } as unknown as KMSSearchEngineService)
    expect(json).toBe('[]')
  })
})

describe('kms-paragraph-processor / deduplicateTocEntries 边界补充', () => {
  it('乱序输入先按行号排序', () => {
    const out = deduplicateTocEntries([
      { title: '第三章', level: 1, lineNumber: 300 },
      { title: '第一章', level: 1, lineNumber: 1 },
      { title: '第二章', level: 1, lineNumber: 200 },
    ])
    expect(out.map(e => e.lineNumber)).toEqual([1, 200, 300])
  })

  it('同行号同标题完全重复只保留一条', () => {
    const out = deduplicateTocEntries([
      { title: '标题', level: 1, lineNumber: 5 },
      { title: '标题', level: 1, lineNumber: 5 },
    ])
    expect(out).toHaveLength(1)
  })

  it('同行号但标题不相似时都保留', () => {
    const out = deduplicateTocEntries([
      { title: '完全不同的甲', level: 1, lineNumber: 5 },
      { title: '毫无关联的乙', level: 1, lineNumber: 5 },
    ])
    expect(out).toHaveLength(2)
  })

  it('空标题条目不被视为重复（当前行为）', () => {
    const out = deduplicateTocEntries([
      { title: '', level: 1, lineNumber: 1 },
      { title: '', level: 1, lineNumber: 2 },
    ])
    expect(out).toHaveLength(2)
  })
})

describe('kms-paragraph-processor / validateTocEntries 边界补充', () => {
  const text = ['第 1 行内容', '# 目标标题', '第 3 行内容'].join('\n')

  it('level 为 0 的条目被过滤', () => {
    expect(validateTocEntries(text, [{ title: '目标标题', level: 0, lineNumber: 2 }])).toHaveLength(0)
  })

  it('lineNumber 为 0 时退化为全文搜索仍可命中', () => {
    const out = validateTocEntries(text, [{ title: '目标标题', level: 1, lineNumber: 0 }])
    expect(out).toHaveLength(1)
    expect(out[0].lineNumber).toBe(2)
  })

  it('lineNumber 超出总行数且全文无匹配时返回空', () => {
    expect(validateTocEntries(text, [{ title: '不存在的标题甲', level: 1, lineNumber: 999 }])).toHaveLength(0)
  })

  it('纯空白标题不是有效条目', () => {
    expect(validateTocEntries(text, [{ title: '   ', level: 1, lineNumber: 1 }])).toHaveLength(0)
  })

  it('同一标题多次出现时行号漂移可能命中更早的出现位置（当前行为）', () => {
    const dup = ['# 重复标题', '中间内容行', '# 重复标题', '尾部内容'].join('\n')
    // 目标第 4 行与标题无关，但 ±5 漂移从 delta=-5 起搜索 → 命中第 1 行而非第 3 行
    const out = validateTocEntries(dup, [{ title: '重复标题', level: 1, lineNumber: 4 }])
    expect(out[0].lineNumber).toBe(1)
  })
})

describe('kms-paragraph-processor / buildTocContext 边界补充', () => {
  it('level 为 0 或负数不产生负缩进', () => {
    const ctx = buildTocContext([{ title: 'T', level: 0, lineNumber: 1 }])
    expect(ctx).toBe('[L1] T')
  })

  it('level=3 缩进 4 个空格', () => {
    const ctx = buildTocContext([{ title: 'T', level: 3, lineNumber: 9 }])
    expect(ctx).toBe('    [L9] T')
  })
})

describe('kms-paragraph-processor / identifyParagraphsFromLLMToc 边界补充', () => {
  it('乱序条目按 offset 排序后切分', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `正文内容第 ${i} 行，词数需要足够多。`).join('\n')
    const a = `# A\n${body(6)}`
    const text = `${a}\n# B\n${body(6)}`
    const offsetB = text.indexOf('# B')
    const paras = identifyParagraphsFromLLMToc(text, [
      { title: 'B', level: 1, lineNumber: 9, offset: offsetB },
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
    ])
    expect(paras.map(p => p.title)).toEqual(['A', 'B'])
  })

  it('首条 offset 之前的正文作为前言', () => {
    const body = (n: number) => Array.from({ length: n }, (_, i) => `前言正文第 ${i} 行，词数足够。`).join('\n')
    const preface = body(8)
    const text = `${preface}\n# 章 A\n${body(8)}`
    const paras = identifyParagraphsFromLLMToc(text, [
      { title: '章 A', level: 1, lineNumber: 9, offset: text.indexOf('# 章 A') },
    ])
    expect(paras[0].title).toBe('前言')
    expect(paras[1].title).toBe('章 A')
  })

  it('所有段落内容不足最小词数时返回空数组', () => {
    const text = 'A\nB\nC'
    const paras = identifyParagraphsFromLLMToc(text, [
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
      { title: 'B', level: 1, lineNumber: 2, offset: 2 },
    ])
    expect(paras).toEqual([])
  })

  it('两条条目 offset 相同：前一条内容为空被跳过，仅保留后一条', () => {
    const body = Array.from({ length: 10 }, (_, i) => `重复偏移正文 ${i}，词数足够。`).join('\n')
    const text = `# A\n${body}`
    const paras = identifyParagraphsFromLLMToc(text, [
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
      { title: 'B', level: 1, lineNumber: 1, offset: 0 },
    ])
    expect(paras).toHaveLength(1)
    // A 的切片区间为 [0, 0) → 内容为空被丢弃；B 独占全文 → 保留
    expect(paras[0].title).toBe('B')
  })

  it('超长段落按最大长度二次切分', () => {
    const text = `# 长\n${'字'.repeat(MAX_PARAGRAPH_CHARS + 2000)}`
    const paras = identifyParagraphsFromLLMToc(text, [
      { title: '长', level: 1, lineNumber: 1, offset: 0 },
    ])
    expect(paras.length).toBeGreaterThan(1)
    expect(paras[0].content.length).toBeLessThanOrEqual(MAX_PARAGRAPH_CHARS)
  })
})

describe('kms-paragraph-processor / filterTocByContentVolume 边界补充', () => {
  it('乱序条目按 offset 排序后再按内容量过滤', () => {
    const body = Array.from({ length: 10 }, (_, i) => `内容充足的一行 ${i}，词数足够。`).join('\n')
    const text = `# 满足\n${body}\n# 空洞\n短`
    const entries = [
      { title: '空洞', level: 1, lineNumber: 13, offset: text.indexOf('# 空洞') },
      { title: '满足', level: 1, lineNumber: 1, offset: 0 },
    ]
    const out = filterTocByContentVolume(text, entries)
    expect(out.map(e => e.title)).toEqual(['满足'])
  })

  it('末条目内容范围延伸到文末', () => {
    const text = `# A\n${'字'.repeat(MIN_CONTENT_WORDS)}`
    const out = filterTocByContentVolume(text, [{ title: 'A', level: 1, lineNumber: 1, offset: 0 }])
    expect(out).toHaveLength(1)
  })
})

describe('kms-paragraph-processor / buildTocWithPath 边界补充', () => {
  it('空数组返回空', () => {
    expect(buildTocWithPath([])).toEqual([])
  })

  it('乱序输入按 offset 排序', () => {
    const out = buildTocWithPath([
      { title: 'B', level: 1, lineNumber: 2, offset: 100 },
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
    ])
    expect(out.map(o => o.path)).toEqual(['A', 'B'])
  })

  it('层级跳跃（1→3→2）时路径正确回退', () => {
    const out = buildTocWithPath([
      { title: 'A', level: 1, lineNumber: 1, offset: 0 },
      { title: 'C', level: 3, lineNumber: 2, offset: 10 },
      { title: 'D', level: 2, lineNumber: 3, offset: 20 },
    ])
    expect(out.map(o => o.path)).toEqual(['A', 'A > C', 'A > D'])
  })
})

describe('kms-paragraph-processor / parseJSON 边界补充', () => {
  it('空字符串返回 fallback', () => {
    expect(parseJSON('', { fb: 1 })).toEqual({ fb: 1 })
  })

  it('无语言标记的代码块', () => {
    expect(parseJSON('```\n{"a":1}\n```', null)).toEqual({ a: 1 })
  })

  it('代码块前有说明文本（多行匹配）', () => {
    expect(parseJSON('分析结果：\n```json\n{"a":1}\n```\n以上', null)).toEqual({ a: 1 })
  })

  it('只有右花括号时解析失败返回 fallback', () => {
    expect(parseJSON('}', { fb: true })).toEqual({ fb: true })
  })

  it('顶层数字与 null 可解析', () => {
    expect(parseJSON('123', null)).toBe(123)
    expect(parseJSON('null', { fb: true })).toBeNull()
  })

  it('字符串值内部含花括号不影响提取', () => {
    expect(parseJSON('{"a":"}"}', null)).toEqual({ a: '}' })
  })

  it('嵌套对象保留完整结构', () => {
    expect(parseJSON('{"a":{"b":[1,{"c":2}]}}', null)).toEqual({ a: { b: [1, { c: 2 }] } })
  })

  it('制表符/回车在字符串内被修复', () => {
    expect(parseJSON('{"a":"x\ty"}', null)).toEqual({ a: 'x\ty' })
    expect(parseJSON('{"a":"x\ry"}', null)).toEqual({ a: 'x\ry' })
  })

  it('已转义的反斜杠不被二次转义', () => {
    const raw = '{"a":"C:\\\\path\\\\n"}'
    expect(parseJSON(raw, null)).toEqual({ a: 'C:\\path\\n' })
  })

  it('fallback 可为 null / 0 / 空数组', () => {
    expect(parseJSON('bad', null)).toBeNull()
    expect(parseJSON('bad', 0)).toBe(0)
    expect(parseJSON('bad', [])).toEqual([])
  })
})
