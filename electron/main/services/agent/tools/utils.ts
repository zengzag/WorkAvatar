export function safeCalculate(expression: string): number {
  const sanitized = expression
    .replace(/[^0-9+\-*/().\s%^]/g, '')
    .replace(/\^/g, '**')
    .replace(/%/g, '/100')

  if (!sanitized || sanitized.length === 0) {
    throw new Error('Invalid expression')
  }

  const result = Function('"use strict"; return (' + sanitized + ')')()
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

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export function formatBytes(bytes: number): string {
  return formatFileSize(bytes)
}

export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}