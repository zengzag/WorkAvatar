import { safeCalculate, formatDate, generateId } from '../../common-utils'

export { safeCalculate, formatDate }

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function generateUUID(): string {
  return generateId()
}

/**
 * 将时间字符串解析为 unix 秒。支持：
 * - unix 秒/毫秒数字串
 * - ISO / 常见日期格式：2026-07-24、2026-07-24 15:00、2026/07/24 15:30:00、2026-07-24T15:00:00
 * 解析失败返回 null。
 */
export function parseNaturalTime(input: any): number | null {
  if (input == null) return null
  if (typeof input === 'number' && !isNaN(input)) return Math.floor(input)
  const raw = String(input).trim()
  if (!raw) return null

  // unix 秒 / 毫秒
  if (/^\d{10}$/.test(raw)) return parseInt(raw, 10)
  if (/^\d{13}$/.test(raw)) return Math.floor(parseInt(raw, 10) / 1000)

  // 绝对日期（仅日期）—— 本地时区 00:00，避免 ISO date-only 被当作 UTC
  const dateOnly = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/)
  if (dateOnly) {
    const d = new Date(parseInt(dateOnly[1]), parseInt(dateOnly[2]) - 1, parseInt(dateOnly[3]))
    return Math.floor(d.getTime() / 1000)
  }
  // 绝对日期时间 —— 本地时区
  const dateTime = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})[ T](\d{1,2})[:：](\d{1,2})(?:[:：](\d{1,2}))?/)
  if (dateTime) {
    const d = new Date(
      parseInt(dateTime[1]),
      parseInt(dateTime[2]) - 1,
      parseInt(dateTime[3]),
      parseInt(dateTime[4]),
      parseInt(dateTime[5]),
      dateTime[6] ? parseInt(dateTime[6]) : 0
    )
    return Math.floor(d.getTime() / 1000)
  }

  // 兜底：交给 Date 解析
  const fallback = new Date(raw)
  if (!isNaN(fallback.getTime())) {
    return Math.floor(fallback.getTime() / 1000)
  }
  return null
}

