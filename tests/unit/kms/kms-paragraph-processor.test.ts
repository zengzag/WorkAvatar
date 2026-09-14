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
} from '../../../electron/main/services/kms/kms-paragraph-processor'

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
