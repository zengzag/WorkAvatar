import { describe, it, expect } from 'vitest'
import {
  generateId,
  generateShortId,
  calculateFileHash,
  safeCalculate,
  formatDate,
  extractMessagePreview,
} from '../../../electron/main/services/common-utils'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

describe('common-utils / generateId', () => {
  it('返回 24 位 hex 字符串（12 字节）', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]{24}$/)
  })

  it('多次调用不碰撞', () => {
    const ids = new Set(Array.from({ length: 10000 }, () => generateId()))
    expect(ids.size).toBe(10000)
  })
})

describe('common-utils / generateShortId', () => {
  it('返回 8 位 hex 字符串（4 字节）', () => {
    const id = generateShortId()
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('common-utils / calculateFileHash', () => {
  it('对相同内容返回相同 hash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hash-'))
    const file = path.join(dir, 'a.txt')
    fs.writeFileSync(file, 'hello workavatar')
    try {
      const h1 = await calculateFileHash(file)
      const h2 = await calculateFileHash(file)
      expect(h1).toBe(h2)
      expect(h1).toBe(crypto.createHash('sha256').update('hello workavatar').digest('hex'))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('对不存在文件抛错', async () => {
    await expect(calculateFileHash(path.join(os.tmpdir(), 'not-exist-' + Date.now() + '.tmp')))
      .rejects.toThrow()
  })

  it('空文件返回 sha256 空内容哈希', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hash-'))
    const file = path.join(dir, 'empty.txt')
    fs.writeFileSync(file, '')
    try {
      const h = await calculateFileHash(file)
      expect(h).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('common-utils / safeCalculate', () => {
  it('四则运算', () => {
    expect(safeCalculate('1 + 2 * 3')).toBe(7)
    expect(safeCalculate('(1+2)*3')).toBe(9)
    expect(safeCalculate('10 / 4')).toBe(2.5)
    expect(safeCalculate('7-3')).toBe(4)
  })

  it('幂运算 ^ 与百分号', () => {
    expect(safeCalculate('2^10')).toBe(1024)
    expect(safeCalculate('50%')).toBe(0.5)
  })

  it('过滤非法字符后计算', () => {
    // 字母/特殊符号被剥离，仅保留算术字符
    expect(safeCalculate('abc 1+2 def')).toBe(3)
  })

  it('空表达式抛错', () => {
    expect(() => safeCalculate('')).toThrow('Invalid expression')
    expect(() => safeCalculate('abc')).toThrow('Invalid expression')
  })

  it('空白-only 表达式抛 SyntaxError', () => {
    expect(() => safeCalculate('   ')).toThrow()
  })

  it('语法错误的残留表达式由 Function 抛出', () => {
    expect(() => safeCalculate('2+')).toThrow()
  })

  it('除零结果非有限数抛错', () => {
    expect(() => safeCalculate('1/0')).toThrow('Calculation error')
  })

  it('结果非有限数抛错（幂运算溢出）', () => {
    // 字符 e 被过滤，'1e400' 会变成 1400 —— 科学计数法不支持，用幂运算制造 Infinity
    expect(() => safeCalculate('9^9^9^9')).toThrow('Calculation error')
  })
})

describe('common-utils / formatDate', () => {
  const d = new Date(2026, 0, 2, 3, 4, 5)

  it('标准格式', () => {
    expect(formatDate(d, 'YYYY-MM-DD HH:mm:ss')).toBe('2026-01-02 03:04:05')
  })

  it('单位数月/日/时补零', () => {
    expect(formatDate(d, 'MM/DD')).toBe('01/02')
    expect(formatDate(d, 'HH:mm')).toBe('03:04')
  })
})

describe('common-utils / extractMessagePreview', () => {
  it('提取 user 与 assistant 文本', () => {
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ]
    expect(extractMessagePreview(JSON.stringify(messages))).toBe('你好 你好！')
  })

  it('assistant segments 中的 answer 段被提取', () => {
    const messages = [
      { role: 'assistant', content: '', segments: [{ type: 'answer', content: '分段回答' }] },
    ]
    expect(extractMessagePreview(JSON.stringify(messages))).toBe('分段回答')
  })

  it('跳过 tool/空消息', () => {
    const messages = [
      { role: 'tool', content: 'tool result' },
      { role: 'user', content: '' },
      { role: 'assistant', content: '   ' },
    ]
    const preview = extractMessagePreview(JSON.stringify(messages))
    expect(preview).not.toContain('tool result')
  })

  it('非法 JSON 返回空串', () => {
    expect(extractMessagePreview('not json')).toBe('')
  })

  it('非数组 JSON 返回空串', () => {
    expect(extractMessagePreview('{"a":1}')).toBe('')
  })

  it('空串/null 输入返回空串', () => {
    expect(extractMessagePreview('')).toBe('')
    expect(extractMessagePreview(null as any)).toBe('')
  })

  it('超长预览截断到 4000 字符', () => {
    const messages = [{ role: 'user', content: 'a'.repeat(5000) }]
    expect(extractMessagePreview(JSON.stringify(messages)).length).toBe(4000)
  })
})
