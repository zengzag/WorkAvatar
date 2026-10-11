/**
 * LLM 输出 JSON 的容错解析（供 KMS、记忆提取/精炼等模块共用）。
 * 支持 ```json 代码块与裸 JSON 提取；非法 JSON 时尝试修复字符串内的换行/制表符。
 */
export function parseJSON<T>(raw: string, fallback: T): T {
  const jsonStr = extractJSON(raw)
  try {
    return JSON.parse(jsonStr) as T
  } catch {
    try {
      return JSON.parse(repairJSON(jsonStr)) as T
    } catch {
      return fallback
    }
  }
}

/** 从 LLM 输出中提取 JSON 主体：优先 ```json 代码块，其次首尾花括号区间 */
function extractJSON(raw: string): string {
  const trimmed = raw.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m)
  if (fenceMatch) return fenceMatch[1].trim()
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1)
  }
  return trimmed
}

/** 修复 LLM 输出的非法 JSON（转义字符串内的换行/制表符） */
function repairJSON(raw: string): string {
  let result = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (escaped) { result += ch; escaped = false; continue }
    if (ch === '\\') { result += ch; escaped = true; continue }
    if (ch === '"') { inString = !inString; result += ch; continue }
    if (inString) {
      if (ch === '\n') result += '\\n'
      else if (ch === '\r') result += '\\r'
      else if (ch === '\t') result += '\\t'
      else result += ch
    } else {
      result += ch
    }
  }
  return result
}
