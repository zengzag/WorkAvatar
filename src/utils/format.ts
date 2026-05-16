import { filesize } from 'filesize'

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10)
}

export function formatFileSize(bytes: number): string {
  return filesize(bytes) as string
}
