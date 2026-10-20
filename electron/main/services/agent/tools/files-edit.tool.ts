import type { ToolDefinition } from './types'
import * as fs from 'fs'
import * as path from 'path'
import { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'
import FilePermissionService from '../../file-permission.service'
import { MAX_SNAPSHOT_FILE_BYTES } from '../../file-snapshot.service'
import { buildUnifiedDiff } from './text-diff'
import { diffSuffix, readEditableText, readFileState, recordSnapshot, resolveToolPath } from './fs-shared'
import type { DiffDisclosure } from '../../../../shared/types'

const MAX_CHANGES = 50

const filePermission = FilePermissionService.getInstance()

interface PatchPlan {
  /** 用户传入的原始路径（用于错误与结果展示） */
  filePath: string
  resolved: string
  before: string
  after: string
  existed: boolean
}

/**
 * 文件精确修改（单个或多个）：全部改动先在内存中计算完成，合并成一次授权确认（弹窗展示合并 diff），
 * 授权通过后才逐个落盘。任一改动无法应用（未匹配/不唯一/二进制）时整体拒绝，不产生半成品。
 */
export const filesEditTool: ToolDefinition = {
  id: 'files_edit',
  name: 'files_edit',
  title: '修改文件',
  summary: '精确修改一个或多个文件（替换或整文件写入），合并为一次确认，失败则整体不落盘。',
  description: `Edit existing files in place with exact text replacements, or write whole file contents, in one atomic call.

Use this for targeted changes instead of rewriting a file with file_write. All changes are planned and shown as one combined diff behind a single confirmation; if any change cannot be applied, nothing is written.

Each item in changes[] is one file:
- { path, edits: [{ old_string, new_string, replace_all? }] }: exact replacements applied in order. old_string must match the file exactly (including indentation and newlines) and be unique unless replace_all=true. To insert, include an anchor line in old_string and repeat it plus the new content in new_string. To delete text, set new_string to "".
- { path, content }: write the whole file (create or overwrite); parent directories are created.

Constraints:
- edits require an existing file; to create one use content or file_write.
- Binary or non-UTF-8 files are refused (writing back would corrupt them).
- At most ${MAX_CHANGES} files per call; files outside the workspace need confirmation.
- Deleting files is not supported — use file_delete.`,
  parameters: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: `Files to modify (at most ${MAX_CHANGES}); each item provides either edits or content`,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute, or relative to the workspace)' },
            edits: {
              type: 'array',
              description: 'Exact replacements applied in order (the file must already exist)',
              items: {
                type: 'object',
                properties: {
                  old_string: { type: 'string', description: 'Exact text to find (including indentation and newlines)' },
                  new_string: { type: 'string', description: 'Replacement text; empty string deletes the match' },
                  replace_all: { type: 'boolean', description: 'Replace every occurrence (default false, unique match only)' },
                },
                required: ['old_string', 'new_string'],
              },
            },
            content: { type: 'string', description: 'Whole-file content (create or overwrite); mutually exclusive with edits' },
          },
          required: ['path'],
        },
      },
    },
    required: ['changes'],
  },
  handler: async (args: any) => {
    try {
      return await applyPatch(args)
    } catch (error: any) {
      return { success: false, error: `批量修改失败: ${error?.message || error}` }
    }
  },
  source: 'builtin',
  permission: 'requires_confirmation',
  selfAuthorized: true,
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
  onDemand: false,
}

async function applyPatch(args: any) {
  const rawChanges: any[] = Array.isArray(args?.changes) ? args.changes : []
  if (rawChanges.length === 0) return { success: false, error: 'changes 不能为空' }
  if (rawChanges.length > MAX_CHANGES) {
    return { success: false, error: `一次最多修改 ${MAX_CHANGES} 个文件（当前 ${rawChanges.length}）` }
  }

  const seen = new Set<string>()
  const plans: PatchPlan[] = []

  for (const item of rawChanges) {
    const filePath = String(item?.path || '').trim()
    if (!filePath) return { success: false, error: 'changes 中存在缺少 path 的项' }

    const resolved = resolveToolPath(filePath)
    const dedupeKey = process.platform === 'win32' ? resolved.toLowerCase() : resolved
    if (seen.has(dedupeKey)) {
      return { success: false, error: `同一文件在 changes 中出现多次: ${filePath}（请合并为一个 edits 数组）` }
    }
    seen.add(dedupeKey)

    const hasEdits = Array.isArray(item?.edits) && item.edits.length > 0
    const hasContent = typeof item?.content === 'string'
    if (hasEdits && hasContent) return { success: false, error: `${filePath}: edits 与 content 只能二选一` }
    if (!hasEdits && !hasContent) return { success: false, error: `${filePath}: 必须提供 edits 或 content` }

    if (hasEdits) {
      if (!fs.existsSync(resolved)) {
        return { success: false, error: `${filePath}: 文件不存在（新建文件请用 content，或改用 file_write）` }
      }
      const read = readEditableText(filePath, resolved)
      if (!read.ok) return { success: false, error: read.error }
      const applied = applyEdits(filePath, read.content, item.edits)
      if (!applied.ok) return { success: false, error: applied.error }
      if (applied.content === read.content) return { success: false, error: `${filePath}: edits 未产生任何改动` }
      plans.push({ filePath, resolved, before: read.content, after: applied.content, existed: true })
    } else {
      const state = readFileState(resolved)
      if (state.exists && !state.restorable) {
        return { success: false, error: `${filePath}: 现有文件为二进制或超过快照上限，无法安全覆盖（请改用 file_write）` }
      }
      const after = String(item.content)
      if (state.exists && state.content === after) return { success: false, error: `${filePath}: content 与现有内容相同，未产生改动` }
      plans.push({ filePath, resolved, before: state.content, after, existed: state.exists })
    }
  }

  const { diff, truncated } = buildCombinedDiff(plans)
  // 授权发生在全部改动计算完成之后，使确认弹窗能展示完整的合并 diff；一次授权覆盖全部文件
  const confirm = await filePermission.authorizeFileOperation('修改', plans.map(p => p.resolved), { diff })
  if (!confirm.allowed) return { success: false, error: confirm.error || '修改操作已取消' }

  const done: string[] = []
  const failed: string[] = []
  for (const p of plans) {
    try {
      const dir = path.dirname(p.resolved)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(p.resolved, p.after, 'utf-8')
      const restorable = Buffer.byteLength(p.before, 'utf-8') <= MAX_SNAPSHOT_FILE_BYTES
      recordSnapshot('files_edit', p.existed ? 'edit' : 'write', p.resolved, {
        exists: p.existed,
        content: restorable ? p.before : '',
        restorable,
      })
      done.push(`✓ ${p.filePath}`)
    } catch (error: any) {
      failed.push(`✗ ${p.filePath}: ${error?.message || error}`)
    }
  }

  const parts = [`共 ${plans.length} 个文件，已写入 ${done.length} 个${truncated ? '（diff 预览已截断）' : ''}`]
  parts.push(...done)
  if (failed.length > 0) parts.push(...failed)

  return { success: failed.length === 0, output: parts.join('\n') + diffSuffix(diff) }
}

/** 按顺序对内存中的文本应用精确替换；任一步失败即整体失败 */
function applyEdits(
  filePath: string,
  content: string,
  edits: any[],
): { ok: true; content: string } | { ok: false; error: string } {
  let current = content
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] || {}
    const oldString = String(edit.old_string ?? '')
    const newString = String(edit.new_string ?? '')
    if (!oldString) return { ok: false, error: `${filePath}: 第 ${i + 1} 个 edit 的 old_string 不能为空` }
    if (oldString === newString) return { ok: false, error: `${filePath}: 第 ${i + 1} 个 edit 的 old_string 与 new_string 相同` }

    const occurrences = current.split(oldString).length - 1
    if (occurrences === 0) {
      return { ok: false, error: `${filePath}: 第 ${i + 1} 个 edit 未找到匹配文本（old_string 需与文件内容精确一致，含缩进与换行）` }
    }
    if (edit.replace_all !== true && occurrences > 1) {
      return { ok: false, error: `${filePath}: 第 ${i + 1} 个 edit 的 old_string 匹配 ${occurrences} 处，不唯一；请补充上下文或设 replace_all=true` }
    }

    // split/join 与 slice 避免 String.replace 对 $& 等替换模式的解释
    if (edit.replace_all === true) {
      current = current.split(oldString).join(newString)
    } else {
      const idx = current.indexOf(oldString)
      current = current.slice(0, idx) + newString + current.slice(idx + oldString.length)
    }
  }
  return { ok: true, content: current }
}

/** 合并各文件 diff，并补上 buildUnifiedDiff 不产出的文件头 */
function buildCombinedDiff(plans: PatchPlan[]): { diff: DiffDisclosure; truncated: boolean } {
  const parts: string[] = []
  let truncated = false
  for (const p of plans) {
    const single = buildUnifiedDiff(p.before, p.after)
    if (!single.content) continue
    parts.push(`--- ${p.filePath}`, `+++ ${p.filePath}`, single.content)
    if (single.truncated) truncated = true
  }
  return { diff: { content: parts.join('\n'), truncated }, truncated }
}
