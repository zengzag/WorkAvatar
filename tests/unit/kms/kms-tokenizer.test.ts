import { describe, it, expect } from 'vitest'
import kmsTokenizer, { kmsTokenizer as namedTokenizer } from '../../../electron/main/services/kms/kms-tokenizer.service'

describe('kms-tokenizer / 导出实例', () => {
  it('默认导出与命名导出是同一个单例', () => {
    expect(kmsTokenizer).toBe(namedTokenizer)
  })
})

describe('kms-tokenizer / segment（索引侧精确模式）', () => {
  it('空串返回空串', () => {
    expect(kmsTokenizer.segment('')).toBe('')
  })

  it('纯空白返回空串（空白 token 被 trim 过滤）', () => {
    expect(kmsTokenizer.segment('   ')).toBe('')
    expect(kmsTokenizer.segment('\n\t ')).toBe('')
  })

  it('中文按词切分并以单空格连接', () => {
    expect(kmsTokenizer.segment('知识库管理系统设计文档')).toBe('知识库 管理系统 设计 文档')
  })

  it('英文大小写保持原样（索引侧不做小写化）', () => {
    expect(kmsTokenizer.segment('Hello World')).toBe('Hello World')
  })

  it('中英混合不产生重复空格', () => {
    expect(kmsTokenizer.segment('API 接口设计规范')).toBe('API 接口 设计规范')
  })

  it('emoji 作为独立 token 保留（仅过滤空白）', () => {
    expect(kmsTokenizer.segment('😀 知识')).toBe('😀 知识')
  })

  it('对已分词文本幂等', () => {
    const once = kmsTokenizer.segment('知识库管理系统设计文档')
    expect(kmsTokenizer.segment(once)).toBe(once)
  })

  it('超长文本不抛错且保持词序列', () => {
    const text = '知识库检索测试。'.repeat(20_000)
    const out = kmsTokenizer.segment(text)
    expect(out.length).toBeGreaterThan(0)
    expect(out.startsWith('知识库')).toBe(true)
    expect(out).not.toContain('  ')
  })
})

describe('kms-tokenizer / segmentForSearch（查询侧搜索引擎模式）', () => {
  it('空串/空白返回空数组', () => {
    expect(kmsTokenizer.segmentForSearch('')).toEqual([])
    expect(kmsTokenizer.segmentForSearch('   ')).toEqual([])
  })

  it('长词拆分子词提升召回', () => {
    expect(kmsTokenizer.segmentForSearch('知识库管理系统设计')).toEqual([
      '知识', '知识库', '管理', '系统', '管理系', '管理系统', '设计',
    ])
  })

  it('结果全部小写', () => {
    expect(kmsTokenizer.segmentForSearch('RAG')).toEqual(['rag'])
    expect(kmsTokenizer.segmentForSearch('API 接口')).toEqual(['api', '接口'])
  })

  it('过滤停用词（中英文）', () => {
    expect(kmsTokenizer.segmentForSearch('的')).toEqual([])
    expect(kmsTokenizer.segmentForSearch('the a an')).toEqual([])
    expect(kmsTokenizer.segmentForSearch('HOW to 使用')).toEqual(['使用'])
    expect(kmsTokenizer.segmentForSearch('如何做')).toEqual(['做']) // '如何' 为停用词
  })

  it('过滤纯标点/符号', () => {
    expect(kmsTokenizer.segmentForSearch('!!!')).toEqual([])
    expect(kmsTokenizer.segmentForSearch('...，。')).toEqual([])
  })

  it('过滤单字符英文但保留单字符中文', () => {
    expect(kmsTokenizer.segmentForSearch('a b c')).toEqual([])
    expect(kmsTokenizer.segmentForSearch('中')).toEqual(['中'])
  })

  it('过滤 emoji（无中英文数字）', () => {
    expect(kmsTokenizer.segmentForSearch('😀 知识')).toEqual(['知识'])
  })

  it('结果去重且保持出现顺序', () => {
    expect(kmsTokenizer.segmentForSearch('知识库 知识库')).toEqual(['知识', '知识库'])
  })

  it('数字与含数字 token 保留', () => {
    expect(kmsTokenizer.segmentForSearch('GPT4 3.5')).toEqual(['gpt4', '3.5'])
  })

  it('停用词表中没有的词（如“使用/方法”）仍保留，用于召回', () => {
    expect(kmsTokenizer.segmentForSearch('关于 如何 使用 的 方法')).toEqual(['使用', '方法'])
  })
})

describe('kms-tokenizer / segmentForPhrase（短语精确匹配）', () => {
  it('空串/空白返回空数组', () => {
    expect(kmsTokenizer.segmentForPhrase('')).toEqual([])
    expect(kmsTokenizer.segmentForPhrase('   ')).toEqual([])
  })

  it('保留停用词与原始大小写（与索引侧 token 序列一致）', () => {
    expect(kmsTokenizer.segmentForPhrase('the a an')).toEqual(['the', 'a', 'an'])
    expect(kmsTokenizer.segmentForPhrase('Hello World')).toEqual(['Hello', 'World'])
  })

  it('保留重复词以维持短语连续性', () => {
    expect(kmsTokenizer.segmentForPhrase('设计规范设计规范')).toEqual(['设计规范', '设计规范'])
  })

  it('不拆分长词（与 segmentForSearch 的差异）', () => {
    expect(kmsTokenizer.segmentForPhrase('知识库管理系统设计文档')).toEqual(['知识库', '管理系统', '设计', '文档'])
  })

  it('emoji 保留（与 segment 行为一致）', () => {
    expect(kmsTokenizer.segmentForPhrase('😀 知识')).toEqual(['😀', '知识'])
  })

  it('与 segment 的结果在非空白 token 上一致', () => {
    const text = 'API 接口设计规范 与 知识库'
    expect(kmsTokenizer.segmentForPhrase(text).join(' ')).toBe(kmsTokenizer.segment(text))
  })
})
