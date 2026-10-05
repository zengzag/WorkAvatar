export function tokenizeFileName(fileName: string, filePath: string = ''): string[] {
  const raw = `${fileName} ${filePath}`.toLowerCase()
  const tokens = new Set<string>()
  const latinWords = raw.match(/[a-z0-9][a-z0-9._-]{1,}/g) || []
  for (const word of latinWords) {
    tokens.add(word)
    if (word.length > 4) {
      for (let i = 2; i <= Math.min(word.length, 8); i++) tokens.add(word.slice(0, i))
    }
  }

  const cjkChars = Array.from(raw.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [])
  for (const ch of cjkChars) tokens.add(ch)
  for (let i = 0; i < cjkChars.length - 1; i++) tokens.add(cjkChars[i] + cjkChars[i + 1])

  const compactDigits = raw.match(/\d{2,}/g) || []
  for (const digits of compactDigits) tokens.add(digits)

  return Array.from(tokens).filter(Boolean)
}

export function tokenizeQueryTerm(term: string): string[] {
  const lower = term.toLowerCase()
  if (/[\u3400-\u4dbf\u4e00-\u9fff]/.test(lower)) {
    const chars = Array.from(lower.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || [])
    if (chars.length === 1) return chars
    const out: string[] = []
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1])
    return out.length > 0 ? out : chars
  }
  return [lower]
}
