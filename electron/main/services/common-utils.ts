import * as crypto from 'crypto'
import * as fs from 'fs'

/**
 * 将文件/文件夹移至操作系统回收站（可找回），回收站不可用时回退到永久删除。
 * 仅在主进程可用（内部 lazy require electron.shell）。
 */
export async function moveToTrash(filePath: string): Promise<void> {
  const { shell } = require('electron')
  try {
    await shell.trashItem(filePath)
  } catch {
    // 回收站不可用（如某些 Linux 环境）时回退到永久删除
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true })
    }
  }
}

export function generateId(): string {
  // 12 字节(96bit)：birthday bound ≈ 2^48 ≈ 281 万亿，杜绝大规模段落索引碰撞
  // 原 4 字节(32bit) 在 65k 条记录时碰撞概率达 50%，大库必崩
  return crypto.randomBytes(12).toString('hex')
}

export function generateShortId(): string {
  // 4 字节(32bit) → 8 hex 字符：用于员工工作区目录名等数量有限、需可读的场景
  // 调用方应自行处理极小概率的目录名碰撞
  return crypto.randomBytes(4).toString('hex')
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
    const parts: string[] = []
    for (const m of messages) {
      if (m.role === 'user' && typeof m.content === 'string') {
        parts.push(m.content)
      } else if (m.role === 'assistant') {
        // assistant content 可能是纯文本，也可能拆分到 segments
        if (typeof m.content === 'string' && m.content.trim()) {
          parts.push(m.content)
        }
        if (Array.isArray(m.segments)) {
          for (const seg of m.segments) {
            if (seg.type === 'answer' && typeof seg.content === 'string' && seg.content.trim()) {
              parts.push(seg.content)
            }
          }
        }
      }
    }
    const preview = parts.join(' ')
    return preview.length > 4000 ? preview.substring(0, 4000) : preview
  } catch {
    return ''
  }
}
