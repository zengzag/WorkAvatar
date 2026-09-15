import { safeCalculate, formatDate, generateId } from '../../common-utils'

export { safeCalculate, formatDate }

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function generateUUID(): string {
  return generateId()
}

/**
 * 把本地时区 Date 转为 unix 秒，并校验回读的年月日与输入一致。
 * JS Date 会把越界月/日静默回绕（2026-02-30 → 3/2、2026-13-45 → 2027-…），
 * 回读不一致说明输入非法，返回 null 而非给出错误时间。
 */
function toUnixSeconds(d: Date, year: number, month: number, day: number): number | null {
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null
  return Math.floor(d.getTime() / 1000)
}

/**
 * 将时间字符串解析为 unix 秒。支持：
 * - unix 秒/毫秒数字串
 * - ISO / 常见日期格式：2026-07-24、2026-07-24 15:00、2026/07/24 15:30:00、2026-07-24T15:00:00
 * 解析失败返回 null。
 */
export function parseNaturalTime(input: any): number | null {
  if (input == null) return null
  if (typeof input === 'number') {
    // 非有限值（Infinity/NaN）无法表示真实时间，直接拒绝，避免下游拿到无效时间戳
    if (!Number.isFinite(input)) return null
    // 与 13 位毫秒数字串语义对齐：绝对值 ≥ 1e12 视为毫秒折算为秒，否则视为秒
    return Math.floor(Math.abs(input) >= 1e12 ? input / 1000 : input)
  }
  const raw = String(input).trim()
  if (!raw) return null

  // unix 秒 / 毫秒
  if (/^\d{10}$/.test(raw)) return parseInt(raw, 10)
  if (/^\d{13}$/.test(raw)) return Math.floor(parseInt(raw, 10) / 1000)

  // 绝对日期（仅日期）—— 本地时区 00:00，避免 ISO date-only 被当作 UTC
  const dateOnly = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/)
  if (dateOnly) {
    const [y, m, d] = [parseInt(dateOnly[1]), parseInt(dateOnly[2]), parseInt(dateOnly[3])]
    return toUnixSeconds(new Date(y, m - 1, d), y, m, d)
  }
  // 绝对日期时间 —— 本地时区
  const dateTime = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})[ T](\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/)
  if (dateTime) {
    const [y, m, d] = [parseInt(dateTime[1]), parseInt(dateTime[2]), parseInt(dateTime[3])]
    const dt = new Date(
      y,
      m - 1,
      d,
      parseInt(dateTime[4]),
      parseInt(dateTime[5]),
      dateTime[6] ? parseInt(dateTime[6]) : 0
    )
    return toUnixSeconds(dt, y, m, d)
  }

  // 兜底：交给 Date 解析
  const fallback = new Date(raw)
  if (!isNaN(fallback.getTime())) {
    return Math.floor(fallback.getTime() / 1000)
  }
  return null
}

