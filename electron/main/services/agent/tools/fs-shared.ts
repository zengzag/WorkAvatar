import * as fs from 'fs'
import * as path from 'path'
import FilePermissionService from '../../file-permission.service'

/**
 * 文件工具共用的路径解析、文本状态与可编辑文本读取。
 * 独立成模块避免 fs-tools ↔ files-edit 循环依赖（files-edit 只依赖这里）。
 */

const filePermission = FilePermissionService.getInstance()

/** 按文本读取的大小上限：超过则不读取原内容（diff/追加仅按空内容处理） */
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024

/** 当前任务的有效工作区目录：优先任务独立目录，旧对话（无任务目录）回退到员工工作区 */
export function getWorkspacePath(): string | null {
  return filePermission.getWorkspacePath()
}

/** 解析工具入参路径：绝对路径原样；相对路径按工作区解析（无工作区时回退主进程 cwd），不落到应用目录 */
export function resolveToolPath(raw: string): string {
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(getWorkspacePath() || process.cwd(), raw)
}

/** 读取文件当前文本状态：超上限/二进制/非 UTF-8 时 content 为空且 isText=false */
export function readFileState(filePath: string): { exists: boolean; content: string; isText: boolean } {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { exists: true, content: '', isText: false }
    if (stat.size > MAX_TEXT_FILE_BYTES) return { exists: true, content: '', isText: false }
    const buf = fs.readFileSync(filePath)
    // NUL 字节 → 二进制文件；无效 UTF-8（如 GBK）→ 不可按文本处理
    if (buf.includes(0)) return { exists: true, content: '', isText: false }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { exists: true, content: text, isText: true }
    } catch {
      return { exists: true, content: '', isText: false }
    }
  } catch {
    return { exists: false, content: '', isText: true }
  }
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
