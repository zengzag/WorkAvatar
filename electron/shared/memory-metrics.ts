/**
 * 记忆库容量度量（主进程与渲染进程共用）。
 *
 * 中文单字的信息密度约为英文单字符的 2 倍，若统一按字符计数，英文记忆会过早触发精炼。
 * 因此容量统一按「字符当量」计量：CJK 字符计 1，其余字符计 0.5（即英文 2 字符 = 1 当量）。
 */

/** 记忆库条数上限：仅用于触发整理，不约束写入；常驻注入另有 MEMORY_ALWAYS_ON_MAX_COUNT */
export const MEMORY_MAX_COUNT = 50
/** 记忆库容量上限（字符当量）：仅用于触发整理，注入上限见 MEMORY_ALWAYS_ON_MAX_CHARS */
export const MEMORY_MAX_CHARS = 4000
/** 常驻注入的记忆条数上限（pinned + critical） */
export const MEMORY_ALWAYS_ON_MAX_COUNT = 12
/** 常驻注入的记忆字符上限（pinned 不受该上限约束） */
export const MEMORY_ALWAYS_ON_MAX_CHARS = 1500
/** 单条 content 字符上限（LLM 偶尔会写长句，需在服务层兜底截断） */
export const MEMORY_CONTENT_MAX_CHARS = 160

/** CJK 字符：汉字、假名、谚文、全角符号与中文标点 */
const CJK_CHAR = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/

/** 计算文本的字符当量（CJK 计 1，其余计 0.5） */
export function measureMemoryChars(text: string): number {
  let weight = 0
  for (const ch of text || '') {
    weight += CJK_CHAR.test(ch) ? 1 : 0.5
  }
  return weight
}
