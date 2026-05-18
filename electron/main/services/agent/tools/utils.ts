import { safeCalculate, formatDate, generateId } from '../../common-utils'

export { safeCalculate, formatDate, generateId }

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

export function formatEntityList(entities: any[], separator: string = '\n', prefix: string = '- '): string {
  return entities.map(e => `${prefix}${e.name}(${e.type})`).join(separator)
}

export function validateKbId(kbIds: string[] | undefined | null): string | null {
  if (!kbIds || kbIds.length === 0) return 'knowledge_base_ids为必填字段'
  return null
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function createKbIdValidator(allowedKbIds: string[]) {
  return (kbId: string | undefined): string | null => {
    if (!kbId) return allowedKbIds.length > 0 ? allowedKbIds[0] : null
    if (!allowedKbIds.includes(kbId)) return null
    return kbId
  }
}
