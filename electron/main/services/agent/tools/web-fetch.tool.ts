import type { ToolDefinition } from './types'

/** 拒绝访问内网/本机地址（SSRF 防护）：loopback、私网段、链路本地、云 metadata 端点等 */
export function isPrivateOrLocalTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }
  // 非标准 IPv4 字面量归一化（inet_aton 语义）：`127.1`（3 段）、`2130706433`（纯整数）、
  // `0x7f000001`（十六进制）等都会被网络栈解析为 loopback，不能因不匹配点分四段而放行
  const numeric = (() => {
    if (/^0x[0-9a-f]+$/i.test(host)) return parseInt(host.slice(2), 16)
    if (/^\d+$/.test(host)) return parseInt(host, 10)
    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 2 && parts.every(p => /^\d+$/.test(p))) {
      // inet_aton：末段可为 24/16/8 位组合，这里按通用规则 a.b.c.d / a.b.c / a.b
      // 注意 32 位有符号溢出（如 172<<24 为负），必须 >>> 0 无符号化；
      // 非法段返回 NaN
      const [a, b, c, d] = [Number(parts[0]), Number(parts[1]), Number(parts[2]) ?? 0, Number(parts[3]) ?? 0]
      if (parts.length === 4) {
        if ([a, b, c, d].some(v => v > 255)) return NaN
        return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
      }
      if (parts.length === 3) {
        if (b > 255) return NaN
        return ((a << 24) | (b << 16) | c) >>> 0
      }
      if (parts.length === 2) {
        return ((a << 24) | b) >>> 0
      }
    }
    return null
  })()
  if (numeric !== null && !Number.isNaN(numeric)) {
    const a = (numeric >>> 24) & 255
    const b = (numeric >>> 16) & 255
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  // IPv4 字面量
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }
  // IPv6 字面量（括号已由 URL 解析剥除）
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '')
    if (h === '::' || h === '::1') return true
    const lower = h.toLowerCase()
    // mapped/兼容形式（含非点分的十六进制 mapped，如 ::ffff:7f00:1）
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice(7)
      if (mapped.includes('.')) return isPrivateOrLocalTarget(mapped)
      // 纯十六进制 mapped（如 ::ffff:7f00:1 = 127.0.0.1）：末 32 位两组各补零 4 位拼为 8 位 hex
      const groups = mapped.split(':')
      if (groups.length >= 2) {
        const last = groups.slice(-2).map(g => g.padStart(4, '0')).join('')
        if (/^[0-9a-f]{8}$/.test(last)) {
          const a = parseInt(last.slice(0, 2), 16)
          const b = parseInt(last.slice(2, 4), 16)
          if (a === 127 || a === 10 || a === 0 || a === 169 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true
        }
      }
      return false
    }
    return false
  }
  return false
}

const MAX_FETCH_BYTES = 2 * 1024 * 1024

/** 流式读取响应体，超过上限即停止，避免大文件拉爆内存 */
async function readBodyLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let text = ''
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total <= MAX_FETCH_BYTES) {
      text += decoder.decode(value, { stream: true })
    }
    if (total >= MAX_FETCH_BYTES) {
      reader.cancel().catch(() => { /* ignore */ })
      break
    }
  }
  return text
}

export const webFetchTool: ToolDefinition = {
  id: 'web_fetch',
  name: 'web_fetch',
  title: '网页获取',
  description: '获取指定URL的网页内容，提取为纯文本。支持限制最大字符数。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要获取的网页URL' },
      max_chars: { type: 'number', description: '最大字符数（默认10000）', minimum: 100, maximum: 50000 }
    },
    required: ['url']
  },
  handler: async (args: any) => {
    try {
      const url = String(args.url || '').trim()
      if (!url) return { success: false, error: 'URL不能为空' }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return { success: false, error: 'URL必须以 http:// 或 https:// 开头' }
      }

      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { success: false, error: 'URL格式无效' }
      }
      if (isPrivateOrLocalTarget(parsed.hostname)) {
        return { success: false, error: '拒绝访问内网/本机地址' }
      }

      const maxChars = Math.min(Math.max(args.max_chars || 10000, 100), 50000)

      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      })

      if (!response.ok) return { success: false, error: `请求失败: ${response.status} ${response.statusText}` }

      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('application/json')) {
        const data = await readBodyLimited(response)
        let text = data
        try { text = JSON.stringify(JSON.parse(data), null, 2) } catch { /* 非 JSON 按原文返回 */ }
        return { success: true, output: text.length > maxChars ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text, contentType: 'json' }
      }

      const html = await readBodyLimited(response)
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()

      const truncated = text.length > maxChars
      const output = truncated ? text.substring(0, maxChars) + '\n\n(内容已截断)' : text
      return { success: true, output, truncated, contentType: 'html' }
    } catch (error: any) {
      return { success: false, error: `获取网页失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
