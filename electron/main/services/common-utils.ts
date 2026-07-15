import * as crypto from 'crypto'
import * as fs from 'fs'

export function generateId(): string {
  // 12 字节(96bit)：birthday bound ≈ 2^48 ≈ 281 万亿，杜绝大规模段落索引碰撞
  // 原 4 字节(32bit) 在 65k 条记录时碰撞概率达 50%，大库必崩
  return crypto.randomBytes(12).toString('hex')
}

export async function calculateFileHash(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

export function safeCalculate(expression: string): number {
  const sanitized = expression
    .replace(/[^0-9+\-*/().\s%^]/g, '')
    .replace(/\^/g, '**')
    .replace(/%/g, '/100')

  if (!sanitized || sanitized.length === 0) {
    throw new Error('Invalid expression')
  }

  const result = Function(`"use strict"; return (${sanitized})`)()
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error('Calculation error')
  }
  return result
}

export function formatDate(date: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return format
    .replace('YYYY', String(date.getFullYear()))
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
    .replace('HH', pad(date.getHours()))
    .replace('mm', pad(date.getMinutes()))
    .replace('ss', pad(date.getSeconds()))
}

export function getDefaultProviderId(db: { getDb(): any }): string | null {
  const row = db.getDb().prepare('SELECT id FROM llm_providers WHERE is_default = 1 LIMIT 1').get()
  return row ? row.id : null
}

export function extractMessagePreview(messagesJson: string): string {
  try {
    const messages = JSON.parse(messagesJson || '[]')
    if (!Array.isArray(messages)) return ''
    const userContents = messages
      .filter((m: any) => m.role === 'user' && typeof m.content === 'string')
      .map((m: any) => m.content)
    const preview = userContents.join(' ')
    return preview.length > 1000 ? preview.substring(0, 1000) : preview
  } catch {
    return ''
  }
}
