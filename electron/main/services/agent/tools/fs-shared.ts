import * as fs from 'fs'
import * as path from 'path'
import FilePermissionService from '../../file-permission.service'
import FileSnapshotService, { MAX_SNAPSHOT_FILE_BYTES, type FileChangeKind } from '../../file-snapshot.service'
import type { DiffDisclosure } from '../../../../shared/types'

/**
 * 文件工具共用的路径解析、改动快照与 diff 展示。
 * 独立成模块避免 fs-tools ↔ files-edit 循环依赖（files-edit 只依赖这里）。
 */

const filePermission = FilePermissionService.getInstance()
const fileSnapshot = FileSnapshotService.getInstance()

/** 当前任务的有效工作区目录：优先任务独立目录，旧对话（无任务目录）回退到员工工作区 */
export function getWorkspacePath(): string | null {
  return filePermission.getWorkspacePath()
}

/** 解析工具入参路径：绝对路径原样；相对路径按工作区解析（无工作区时回退主进程 cwd），不落到应用目录 */
export function resolveToolPath(raw: string): string {
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(getWorkspacePath() || process.cwd(), raw)
}

/** 读取文件改动前状态：内容超上限/二进制/非 UTF-8 时只登记存在性（不可还原），避免回滚损坏原文件 */
export function readFileState(filePath: string): { exists: boolean; content: string; restorable: boolean } {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { exists: true, content: '', restorable: false }
    if (stat.size > MAX_SNAPSHOT_FILE_BYTES) return { exists: true, content: '', restorable: false }
    const buf = fs.readFileSync(filePath)
    // NUL 字节 → 二进制文件；无效 UTF-8（如 GBK）→ 无法无损还原，均不做快照内容记录
    if (buf.includes(0)) return { exists: true, content: '', restorable: false }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { exists: true, content: text, restorable: true }
    } catch {
      return { exists: true, content: '', restorable: false }
    }
  } catch {
    return { exists: false, content: '', restorable: true }
  }
}

/** 授权通过后登记快照（被拒绝的操作不产生回滚记录） */
export function recordSnapshot(
  toolName: string,
  changeKind: FileChangeKind,
  filePath: string,
  before: { exists: boolean; content: string; restorable: boolean },
): void {
  fileSnapshot.recordChange({
    toolName,
    changeKind,
    path: filePath,
    existed: before.exists,
    beforeContent: before.restorable ? before.content : null,
    restorable: before.restorable,
  })
}

/** 工具结果中的 diff 展示块（无改动时返回空串；截断提示由 buildUnifiedDiff 内嵌，不重复追加） */
export function diffSuffix(diff: DiffDisclosure): string {
  if (!diff.content) return ''
  return `\n\n\`\`\`diff\n${diff.content}\n\`\`\``
}

/**
 * 读取可编辑的 UTF-8 文本文件（files_edit 共用）。
 * 二进制与非 UTF-8（如 GBK）显式拒绝——写回会静默损坏原文件。
 */
export function readEditableText(
  filePath: string,
  resolved: string,
): { ok: true; content: string } | { ok: false; error: string } {
  if (!fs.existsSync(resolved)) return { ok: false, error: `文件不存在: ${filePath}` }
  if (!fs.statSync(resolved).isFile()) return { ok: false, error: `路径不是文件: ${filePath}` }
  const buf = fs.readFileSync(resolved)
  if (buf.includes(0)) return { ok: false, error: `文件是二进制文件，无法进行文本编辑: ${filePath}` }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return { ok: true, content: text.replace(/\r\n/g, '\n') }
  } catch {
    return { ok: false, error: `文件不是有效的 UTF-8 文本，无法进行文本编辑（请用 shell 命令处理编码转换后重试）: ${filePath}` }
  }
}
