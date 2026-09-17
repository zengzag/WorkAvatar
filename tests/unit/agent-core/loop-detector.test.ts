import { describe, it, expect } from 'vitest'
import { detectLoop, TextLoopDetector, LOOP_DETECT_CONSTANTS } from '../../../electron/main/services/agent/core/loop-detector'

const { MIN_SPAN, TAIL_LEN, MIN_OCCURRENCES, MAX_PERIOD } = LOOP_DETECT_CONSTANTS

/** 生成各不相同的文本段（防止自身成为周期内容） */
function distinctText(count: number): string {
  return Array.from({ length: count }, (_, i) => `第${i}行，内容编号${i}，各不相同。`).join('')
}

describe('detectLoop 纯函数', () => {
  it('短周期死循环（ab 重复）命中，周期为尾窗长度', () => {
    const acc = 'ab'.repeat(600)
    const hit = detectLoop(acc)
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(32)
    expect(hit!.unit).toBe('ab'.repeat(16))
  })

  it('中文死循环命中', () => {
    const hit = detectLoop('好的没问题'.repeat(400))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBeGreaterThan(0)
    // 重复单元必为原文子串且可整除周期
    expect(hit!.unit.length).toBe(hit!.period)
  })

  it('工具参数 JSON 死循环命中', () => {
    const acc = 'a","'.repeat(600)
    expect(detectLoop(acc)).not.toBeNull()
  })

  it('大周期（句子级）重复命中，次数阈值主导', () => {
    const seg = 'X'.repeat(199) + '|'
    // 7 次重复：出现次数不足 10 → 不报
    expect(detectLoop(seg.repeat(7))).toBeNull()
    // 10 次重复：次数、间隔、跨度全部满足 → 命中，周期 200
    const hit = detectLoop(seg.repeat(10))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(200)
  })

  it('有界分隔线不误报（出现次数够但跨度不足）', () => {
    const acc = distinctText(100) + '-'.repeat(320)
    // 320 字符分隔线：尾窗出现 10 次、间隔相等，但跨度 320 < 1024
    expect(detectLoop(acc)).toBeNull()
  })

  it('有界重复行不误报', () => {
    const line = '同样的内容重复哦啦啦。\n'
    const acc = distinctText(80) + line.repeat(20)
    expect(detectLoop(acc)).toBeNull()
  })

  it('漂移循环不误报（等长段但内容递增，逐字符验证失败）', () => {
    const acc = Array.from({ length: 40 }, (_, i) =>
      `item-${String(i).padStart(4, '0')}:` + 'x'.repeat(40),
    ).join('')
    // 段等距出现 ≥10 次、间隔相等、跨度超阈值，但段内容递增 → 验证不通过
    expect(detectLoop(acc)).toBeNull()
  })

  it('结构化正常文本不误报', () => {
    const acc = Array.from({ length: 100 }, (_, i) =>
      `用户提出了问题${i}，我们分析原因${i}并给出解答${i}。`,
    ).join('')
    expect(detectLoop(acc)).toBeNull()
  })

  it('周期超上限不判定', () => {
    const seg = 'Y'.repeat(MAX_PERIOD) + '|' // 周期 1025 > 1024
    expect(detectLoop(seg.repeat(20))).toBeNull()
  })

  it('长度不足直接跳过', () => {
    expect(detectLoop('ab'.repeat(500))).toBeNull() // 1000 < MIN_SPAN+TAIL_LEN
    expect(detectLoop('x'.repeat(MIN_SPAN + TAIL_LEN - 1))).toBeNull()
  })
})

describe('TextLoopDetector 增量检测', () => {
  it('小块喂入死循环，在 MIN_SPAN 量级即命中', () => {
    const det = new TextLoopDetector()
    const text = 'ab'.repeat(1200)
    let hit = null
    let consumed = 0
    for (let i = 0; i < text.length; i += 7) {
      consumed = Math.min(i + 7, text.length)
      hit = det.push(text.slice(i, consumed))
      if (hit) break
    }
    expect(hit).not.toBeNull()
    // 命中时消耗的字符量应远小于全文（快速识别）
    expect(consumed).toBeLessThan(MIN_SPAN + 256)
    expect(hit!.period).toBe(32)
  })

  it('喂入量未达检测线前不触发', () => {
    const det = new TextLoopDetector()
    expect(det.push('ab'.repeat(500))).toBeNull() // 1000 < 1056
    expect(det.push('ab'.repeat(28))).not.toBeNull() // 1056 达标即命中
  })

  it('正常增量文本全程不触发', () => {
    const det = new TextLoopDetector()
    const text = distinctText(150)
    for (let i = 0; i < text.length; i += 5) {
      expect(det.push(text.slice(i, Math.min(i + 5, text.length)))).toBeNull()
    }
  })

  it('空增量直接返回 null', () => {
    const det = new TextLoopDetector()
    expect(det.push('')).toBeNull()
  })
})

describe('检测参数一致性', () => {
  it('次数阈值边界：出现次数不足不报（即使跨度足够）', () => {
    // 周期 200、5 个完整周期 = 跨度 1032 ≥ 1024，但出现仅 6 次 < 10
    const seg = 'X'.repeat(199) + '|'
    const acc = distinctText(50) + seg.repeat(6)
    expect(detectLoop(acc)).toBeNull()
  })

  it('MIN_SPAN 与 MIN_OCCURRENCES 取值符合设计', () => {
    expect(MIN_SPAN).toBe(1024)
    expect(MIN_OCCURRENCES).toBe(10)
    expect(TAIL_LEN).toBe(32)
  })
})
