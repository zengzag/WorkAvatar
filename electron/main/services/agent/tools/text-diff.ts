import type { DiffDisclosure } from '../../../../shared/types'

/** 预览 diff 的行数上限，超出则裁剪（确认弹窗预览用，不是完整补丁） */
const MAX_DIFF_LINES = 400

/** diff 预览中单行长度上限，避免超长行破坏弹窗布局 */
const MAX_LINE_CHARS = 2000

function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n')
}

function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
}

/**
 * 生成用于预览的 unified diff（按行）。
 *
 * 采用"公共前缀/后缀裁剪 + 中间整块替换"的简化算法：结果精确覆盖变化区域，
 * 但不做最小化编辑距离，对大文件是 O(n) 且内存友好。用于权限确认弹窗与工具结果展示。
 */
export function buildUnifiedDiff(before: string, after: string, maxLines: number = MAX_DIFF_LINES): DiffDisclosure {
  const a = splitLines(before)
  const b = splitLines(after)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++

  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)
  if (removed.length === 0 && added.length === 0) return { content: '', truncated: false }

  const lines = [
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...removed.map(l => `-${clipLine(l)}`),
    ...added.map(l => `+${clipLine(l)}`),
  ]

  if (lines.length > maxLines) {
    return {
      content: [...lines.slice(0, maxLines), `…（diff 已截断，共 ${lines.length} 行）`].join('\n'),
      truncated: true,
    }
  }
  return { content: lines.join('\n'), truncated: false }
}
