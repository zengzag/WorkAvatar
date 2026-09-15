import { describe, it, expect } from 'vitest'
import {
  detectLoop,
  TextLoopDetector,
  LOOP_DETECT_CONSTANTS,
} from '../../../electron/main/services/agent/core/loop-detector'

const { MIN_SPAN, TAIL_LEN, MIN_OCCURRENCES, MIN_INTERVALS, MAX_PERIOD, MAX_BACKTRACK_SPAN, CHECK_INTERVAL } = LOOP_DETECT_CONSTANTS

/** 各不相同的文本段（不构成周期内容） */
function distinctText(count: number): string {
  return Array.from({ length: count }, (_, i) => `第${i}行，内容编号${i}，各不相同。`).join('')
}

/** 生成长度为 len 的非周期内容（片段内数字唯一，避免自身形成小周期） */
function aperiodicUnit(len: number, seed = 0): string {
  let s = ''
  let i = 0
  while (s.length < len) {
    s += `<${seed}-${i}>`
    i++
  }
  return s.slice(0, len)
}

describe('loop-detector 周期边界', () => {
  it('周期恰好为 MAX_PERIOD(1024) 时判定命中', () => {
    const unit = aperiodicUnit(MAX_PERIOD)
    const hit = detectLoop(unit.repeat(20))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(MAX_PERIOD)
    // unit 可能相对原始段落发生旋转（尾窗起点在段尾前 TAIL_LEN 处），但必为周期内容
    expect(hit!.unit.length).toBe(MAX_PERIOD)
    expect((unit + unit).includes(hit!.unit)).toBe(true)
  })

  it('周期 1025（超上限）不判定', () => {
    const unit = aperiodicUnit(MAX_PERIOD + 1)
    expect(detectLoop(unit.repeat(20))).toBeNull()
    expect(MAX_PERIOD).toBe(1024)
  })

  it('周期 1025 但内容存在更小周期时按小周期命中（周期取最近两次出现的间隔）', () => {
    // 1025 字符段落内部为 5 字符周期 → 尾窗在实际间隔处命中
    const seg = ('abcde'.repeat(205)).slice(0, MAX_PERIOD + 1)
    const hit = detectLoop(seg.repeat(12))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBeLessThanOrEqual(MAX_PERIOD)
  })

  it('出现次数恰好 MIN_OCCURRENCES(10) 命中，9 次不命中', () => {
    const unit = aperiodicUnit(200)
    const acc = distinctText(50)
    // 尾窗为 unit 结尾 32 字符，出现在每个 unit 段的固定偏移处
    expect(detectLoop(acc + unit.repeat(MIN_OCCURRENCES - 1))).toBeNull()
    expect(detectLoop(acc + unit.repeat(MIN_OCCURRENCES))).not.toBeNull()
  })

  it('长度恰好 MIN_SPAN+TAIL_LEN 命中，少 1 字符不命中', () => {
    expect(detectLoop('ab'.repeat((MIN_SPAN + TAIL_LEN) / 2))!.period).toBe(32)
    expect(detectLoop('ab'.repeat((MIN_SPAN + TAIL_LEN) / 2 - 1) + 'a')).toBeNull()
  })
})

describe('loop-detector 间隔链与跨度约束', () => {
  it('等距链被非等距间隔打断（不足 MIN_INTERVALS 个连续间隔）不判定', () => {
    const seg = 'X'.repeat(199) + '|'
    const acc = distinctText(50) + seg.repeat(5) + 'W'.repeat(100) + seg.repeat(5)
    // 尾部 5 段等距（200），与前半段之间间隔 300 → 连续间隔数 4 < MIN_INTERVALS
    expect(detectLoop(acc)).toBeNull()
    expect(MIN_INTERVALS).toBe(5)
  })

  it('周期区域跨度刚好 ≥ MIN_SPAN 时命中（前缀非周期内容不影响验证起点）', () => {
    const acc = distinctText(100) + 'ab'.repeat(600)
    const hit = detectLoop(acc)
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(32)
    expect(hit!.unit).toBe('ab'.repeat(16))
  })

  it('回溯跨度上限 MAX_BACKTRACK_SPAN 约束下仍能命中（≥ MIN_INTERVALS×MAX_PERIOD）', () => {
    expect(MAX_BACKTRACK_SPAN).toBeGreaterThanOrEqual(MIN_INTERVALS * MAX_PERIOD + TAIL_LEN)
    const unit = aperiodicUnit(MAX_PERIOD)
    expect(detectLoop(unit.repeat(30))).not.toBeNull()
  })

  it('尾窗出现位置超过 MAX_POSITIONS(64) 时仍命中（环形裁剪仅保留最近位置）', () => {
    const unit = aperiodicUnit(200)
    const acc = unit.repeat(120) // 120 个出现位置 > 64
    const hit = detectLoop(acc)
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(200)
  })

  it('空串 / 单字符退化输入不抛错且不误报；超长同字符连续被判定为循环', () => {
    expect(detectLoop('')).toBeNull()
    expect(detectLoop('x')).toBeNull()
    // 连续 1056+ 个同一字符（如超长分隔线）满足"周期 + 出现次数 + 跨度"，会被判为循环；
    // 出现位置按 TAIL_LEN 步进非重叠收集 → 报告的周期按 32 对齐（短周期被放大的既有语义）
    const hit = detectLoop(' '.repeat(5000))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(32)
    expect(hit!.unit).toBe(' '.repeat(32))
    expect(detectLoop('-'.repeat(320))).toBeNull() // 有界分隔线（< MIN_SPAN+TAIL_LEN）不误报
  })
})

describe('loop-detector Unicode / 码元计数', () => {
  it('emoji 循环：按 UTF-16 码元计数，周期为码元数', () => {
    const hit = detectLoop('😀'.repeat(700))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(32)
    expect(hit!.unit.length).toBe(32)
    expect(hit!.unit).toBe('😀'.repeat(16))
  })

  it('中文 + emoji 混合循环命中且 unit 长度等于 period', () => {
    const hit = detectLoop('阶段😀完成'.repeat(300))
    expect(hit).not.toBeNull()
    expect(hit!.unit.length).toBe(hit!.period)
  })

  it('尾窗可切断代理对时不抛错（代理对按码元处理）', () => {
    const acc = '😀'.repeat(600) + 'a' // 长度为奇数码元，尾窗切在代理对中间
    expect(() => detectLoop(acc)).not.toThrow()
    const hit = detectLoop('😀'.repeat(700))
    expect(hit!.unit.length).toBe(hit!.period)
  })

  it('超长文本（>100k 码元）性能可接受且结论稳定', () => {
    const acc = distinctText(3000) + 'ab'.repeat(20000)
    const started = Date.now()
    const hit = detectLoop(acc)
    expect(hit).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('TextLoopDetector 检测节奏与状态', () => {
  it('检测频率：达到阈值后 nextCheckpoint = 当前长度 + CHECK_INTERVAL', () => {
    const det = new TextLoopDetector()
    const chunk = distinctText(50)
    expect(det.push(chunk + chunk)).toBeNull() // 跨过阈值 → 触发一次检测（未命中）
    const len1 = (det as any).acc.length
    expect((det as any).nextCheckpoint).toBe(len1 + CHECK_INTERVAL)
    // 未达下一个检查点不再检测
    expect(det.push('Q'.repeat(CHECK_INTERVAL - 1))).toBeNull()
    expect((det as any).nextCheckpoint).toBe(len1 + CHECK_INTERVAL)
    // 恰好达检查点 → 执行检测并把检查点前移一个区间
    expect(det.push('Q')).toBeNull()
    expect((det as any).nextCheckpoint).toBe(len1 + CHECK_INTERVAL + CHECK_INTERVAL)
  })

  it('喂入量未达检测线时内部不触发检测（nextCheckpoint 不变）', () => {
    const det = new TextLoopDetector()
    expect(det.push('ab'.repeat(500))).toBeNull() // 1000 < 1056
    expect((det as any).nextCheckpoint).toBe(MIN_SPAN + TAIL_LEN)
    expect(det.push('ab'.repeat(28))).not.toBeNull() // 恰好 1056 达标即命中
  })

  it('单次超大增量（含完整循环）直接命中', () => {
    const det = new TextLoopDetector()
    const hit = det.push('ab'.repeat(5000))
    expect(hit).not.toBeNull()
    expect(hit!.period).toBe(32)
  })

  it('命中后继续 push 仍返回命中（检测器不自我重置）', () => {
    const det = new TextLoopDetector()
    expect(det.push('ab'.repeat(5000))).not.toBeNull()
    expect(det.push('ab'.repeat(200))).not.toBeNull()
  })

  it('undefined / 空串增量为无操作', () => {
    const det = new TextLoopDetector()
    expect(det.push(undefined as any)).toBeNull()
    expect(det.push('')).toBeNull()
    expect((det as any).acc).toBe('')
  })

  it('多个独立实例互不影响（thinking / 工具参数各自独立检测的前置条件）', () => {
    const a = new TextLoopDetector()
    const b = new TextLoopDetector()
    expect(a.push('ab'.repeat(5000))).not.toBeNull()
    expect(b.push('ab'.repeat(500))).toBeNull()
    expect(a.push('ab'.repeat(100))).not.toBeNull() // 越过下一个检查点仍命中
  })

  it('跨实例隔离：向一个实例追加不影响另一个实例的累积文本', () => {
    const a = new TextLoopDetector()
    const b = new TextLoopDetector()
    a.push(distinctText(60))
    b.push(distinctText(60))
    const beforeB = (b as any).acc
    a.push('EXTRA-ONLY-IN-A')
    expect((a as any).acc).toContain('EXTRA-ONLY-IN-A')
    expect((b as any).acc).toBe(beforeB)
  })
})
