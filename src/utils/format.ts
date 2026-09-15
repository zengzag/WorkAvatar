import { filesize } from 'filesize'

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

export function formatFileSize(bytes: number): string {
  return filesize(bytes) as string
}

export function isColorDark(hex: string): boolean {
  let h = hex.replace('#', '')
  // 展开 3 位 shorthand（#rgb → #rrggbb），否则 #000 会因 g/b 为 NaN 被判成亮色
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance < 0.5
}

/**
 * 格式化消息时间戳，参考主流聊天软件的时间展示规则：
 * - 1分钟内：刚刚
 * - 今天：HH:mm
 * - 昨天：昨天 HH:mm
 * - 今年：M月D日 HH:mm
 * - 更早：YYYY年M月D日 HH:mm
 */
export function formatMessageTime(timestamp: number, t: (key: string, options?: Record<string, any>) => string): string {
  const now = new Date()
  const date = new Date(timestamp)
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const timeStr = `${hours}:${minutes}`

  // 1分钟内显示"刚刚"；仅对已过去的时间生效，未来时间戳（diffMs < 0）按日期展示，避免与刚发出的消息混淆
  if (diffMs >= 0 && diffMin < 1) {
    return t('workbench.justNow')
  }

  const isToday = now.toDateString() === date.toDateString()
  if (isToday) {
    return timeStr
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()

  const month = date.getMonth() + 1
  const day = date.getDate()
  const year = date.getFullYear()

  if (isYesterday) {
    return `${t('workbench.yesterday')} ${timeStr}`
  }

  if (year === now.getFullYear()) {
    return `${t('workbench.monthDay', { month, day })} ${timeStr}`
  }

  return `${t('workbench.yearMonthDay', { year, month, day })} ${timeStr}`
}

/**
 * 判断两条消息之间是否需要显示时间分隔
 * 规则：两条消息间隔超过5分钟时显示
 */
export function shouldShowTimeSeparator(prevTimestamp: number, currentTimestamp: number): boolean {
  return currentTimestamp - prevTimestamp > 5 * 60 * 1000
}

/**
 * 格式化相对时间片段（不含"前/ago"），配合 i18n key kms.knowledgeCards.refreshedAgo 使用
 * @param timestampSec 秒级时间戳
 * @param lang 当前语言代码
 */
export function formatRelativeTimeShort(timestampSec: number, lang: string = 'zh-CN'): string {
  // 非有限值（NaN/Infinity）与 ≤0 的时间戳均视为无效，直接返回占位符，避免输出 1970 前后的日期
  if (!Number.isFinite(timestampSec) || timestampSec <= 0) return '-'
  const now = Math.floor(Date.now() / 1000)
  const diff = now - timestampSec
  if (diff < 0) return '-'
  const isZh = lang.startsWith('zh')
  if (diff < 60) return isZh ? '1分钟' : '1 minute'
  if (diff < 3600) {
    const m = Math.floor(diff / 60)
    return isZh ? `${m}分钟` : `${m} minute${m > 1 ? 's' : ''}`
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600)
    return isZh ? `${h}小时` : `${h} hour${h > 1 ? 's' : ''}`
  }
  if (diff < 86400 * 30) {
    const d = Math.floor(diff / 86400)
    return isZh ? `${d}天` : `${d} day${d > 1 ? 's' : ''}`
  }
  const date = new Date(timestampSec * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
