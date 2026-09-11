/**
 * LLM 输出循环检测器。
 *
 * 定期取累积文本末尾 TAIL_LEN 字符为尾窗，统计其在全文的非重叠出现位置；
 * 若末尾呈等距周期分布（最近间隔 d 相等、连续 ≥ MIN_INTERVALS 段、
 * 周期性区域总跨度 ≥ MIN_SPAN），再逐字符验证周期性 S[j] === S[j+d]，
 * 全部通过才判定为循环输出。
 *
 * 「等距 + 段内容一致 + 大跨度」三重约束使有界的合法重复
 * （分隔线、重复行内容等）不会误报；无界死循环则在 ~MIN_SPAN 字符量级触发，
 * 远早于 maxTokens 耗尽。
 */

export interface LoopHit {
  /** 重复单元（可能为最小周期的整数倍） */
  unit: string
  /** 检测到的周期长度（字符） */
  period: number
}

export const LOOP_DETECT_CONSTANTS = {
  /** 尾窗长度 */
  TAIL_LEN: 32,
  /** 检测频率：每累积 64 字符检测一次 */
  CHECK_INTERVAL: 64,
  /** 尾窗最少出现次数 */
  MIN_OCCURRENCES: 10,
  /** 回溯验证的最少连续等距间隔数 */
  MIN_INTERVALS: 5,
  /** 周期性区域最小总跨度 */
  MIN_SPAN: 1024,
  /** 周期上限，超过不判定（交给 maxTokens 兜底） */
  MAX_PERIOD: 1024,
  /** 保留的最近出现位置数（环形缓冲） */
  MAX_POSITIONS: 64,
  /** 回溯跨度上限，约束逐字符验证开销（须 ≥ MIN_INTERVALS×MAX_PERIOD+TAIL_LEN） */
  MAX_BACKTRACK_SPAN: 8192,
} as const

/** 对累积文本执行一次循环检测（纯函数，便于单测） */
export function detectLoop(acc: string): LoopHit | null {
  const len = acc.length
  const {
    TAIL_LEN, MIN_OCCURRENCES, MIN_INTERVALS, MIN_SPAN,
    MAX_PERIOD, MAX_POSITIONS, MAX_BACKTRACK_SPAN,
  } = LOOP_DETECT_CONSTANTS
  if (len < MIN_SPAN + TAIL_LEN) return null

  const tail = acc.slice(len - TAIL_LEN)

  // 非重叠收集出现位置（每次命中后步进 TAIL_LEN），只保留最近 MAX_POSITIONS 个
  const all: number[] = []
  let from = 0
  for (;;) {
    const p = acc.indexOf(tail, from)
    if (p === -1) break
    all.push(p)
    from = p + TAIL_LEN
  }
  if (all.length < MIN_OCCURRENCES) return null
  const positions = all.length > MAX_POSITIONS ? all.slice(all.length - MAX_POSITIONS) : all

  const last = positions.length - 1
  const d = positions[last] - positions[last - 1]
  if (d <= 0 || d > MAX_PERIOD) return null

  // 从末尾回溯连续等距 d 的位置链，得到周期区域起点
  let start = last
  while (start > 0) {
    const prev = positions[start - 1]
    if (positions[start] - prev !== d) break
    if (positions[last] - prev + TAIL_LEN > MAX_BACKTRACK_SPAN) break
    start--
  }
  if (last - start < MIN_INTERVALS) return null

  const runStart = positions[start]
  if (positions[last] - runStart + TAIL_LEN < MIN_SPAN) return null

  // 逐字符验证周期性：[runStart, len) 内 S[j] === S[j+d]，任一不符即非循环
  for (let j = runStart; j < len - d; j++) {
    if (acc.charCodeAt(j) !== acc.charCodeAt(j + d)) return null
  }

  return { unit: acc.slice(runStart, runStart + d), period: d }
}

/** 有状态检测器：按增量喂入，内部控制检测频率 */
export class TextLoopDetector {
  private acc = ''
  private nextCheckpoint = LOOP_DETECT_CONSTANTS.MIN_SPAN + LOOP_DETECT_CONSTANTS.TAIL_LEN

  /** 追加增量文本，检测到循环返回命中信息 */
  push(delta: string): LoopHit | null {
    if (!delta) return null
    this.acc += delta
    if (this.acc.length < this.nextCheckpoint) return null
    this.nextCheckpoint = this.acc.length + LOOP_DETECT_CONSTANTS.CHECK_INTERVAL
    return detectLoop(this.acc)
  }
}
