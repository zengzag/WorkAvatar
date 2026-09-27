import os from 'os'
import { normalizePath, isWithinPath, commonParentDir, isFsRoot } from './path-normalize'
import UnifiedInteractionService, { interactionContext } from './unified-interaction.service'
import PathService from './path.service'
import mainUiI18n from './ui-i18n.service'
import type { ScriptDisclosure, DiffDisclosure } from '../../shared/types'

/**
 * 文件权限管理服务（统一门面）：
 * - 工作区边界判定（路径规范化后前缀匹配，兼容大小写/斜杠/符号链接/8.3 短名）
 * - 会话级授权缓存：目录级（"始终允许此文件夹"，含子树）+ 精确路径级（仅本次确认）
 * - 批量确认：多个区外路径按公共父目录归并，单次弹窗完成授权
 * - 任务级高权限（"本轮任务不再提醒"，登记在 UnifiedInteractionService）：本轮任务后续区外操作直接放行
 *
 * 所有需要文件权限判定的工具（file_write/file_edit/file_delete/shell_exec/javascript_exec）
 * 统一通过 authorizeFileOperation 走本服务，不再各自实现边界判定与弹窗。
 * shell_exec / javascript_exec 属于"脚本触发"，传入 options.script 后按脚本视角构造文案
 * （不再按单个文件/文件夹措辞），并把脚本原文交给渲染端以代码块展示。
 */

export interface AuthorizationResult {
  allowed: boolean
  error?: string
}

/** 弹窗展示的路径数上限，超出折叠 */
const MAX_DISPLAY_PATHS = 15

/** 脚本原文在弹窗代码块中的展示上限，超出截断并提示查看工具调用参数 */
const MAX_SCRIPT_DISCLOSURE_CHARS = 20000

/** 脚本触发的确认弹窗标题（文件工具仍按 `确认${operation}工作区外文件`） */
export const SCRIPT_CONFIRM_TITLE = '确认执行脚本'

/** 敏感目录段（凭据/版本库/云凭证等）：位于工作区内也需确认 */
const SENSITIVE_DIR_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker'])

/** 敏感文件名（凭据/密钥/环境变量等），模板类 .env.example/.sample 等不视为敏感 */
const SENSITIVE_FILE_RE = /^(\.env(\..+)?|\.git-credentials|\.npmrc|\.netrc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore|jks))$/i
const ENV_TEMPLATE_RE = /\.(example|sample|template|dist)$/i

/** 调用方传入的脚本信息（服务内统一按上限截断） */
export interface ScriptConfirmInput {
  /** 脚本语言标识（powershell / bash / javascript），仅用于代码块标注 */
  language: string
  /** 原始脚本内容 */
  content: string
}

/** 按展示上限截断脚本原文，得到下发给渲染端的展示对象 */
export function toScriptDisclosure(input: ScriptConfirmInput): ScriptDisclosure {
  const text = input.content.trim()
  if (text.length <= MAX_SCRIPT_DISCLOSURE_CHARS) {
    return { language: input.language, content: text, truncated: false }
  }
  return {
    language: input.language,
    content: text.slice(0, MAX_SCRIPT_DISCLOSURE_CHARS),
    truncated: true,
  }
}

/**
 * 脚本触发的确认文案：以"即将执行脚本"为视角，疑似受影响的路径列在正文，
 * 脚本原文由渲染端在正文下方以代码块（可滚动）展示。
 * paths 为空表示目标含变量引用等无法静态解析，无法判定是否在工作区内。
 */
export function buildScriptConfirmMessage(paths: string[], dirScope?: string): string {
  const scope = paths.length > 0
    ? `工作区外的以下路径（共 ${paths.length} 个）：\n\n${formatPathList(paths)}`
    : '文件，但目标路径含变量引用或无法静态解析，无法判定是否位于工作区内'
  const tail = dirScope
    ? '是否允许执行？选择"始终允许此文件夹"可一并授权以上路径所在目录的全部后续操作。'
    : '是否允许执行？此操作不可撤销，请确认脚本内容后决定。'
  // 末尾一行是渲染端代码块的引导语（脚本原文由 interaction.script 字段单独下发）
  return `即将执行脚本，疑似会修改或删除${scope}\n\n${tail}\n\n原始脚本内容如下：`
}

/** 路径列表文本（超出展示上限时折叠为一行统计），文件工具与脚本触发共用 */
function formatPathList(paths: string[]): string {
  const shown = paths.slice(0, MAX_DISPLAY_PATHS)
  const lines = shown.map((p) => `- ${p}`)
  if (paths.length > shown.length) {
    lines.push(`- ...（共 ${paths.length} 个路径）`)
  }
  return lines.join('\n')
}

class FilePermissionService {
  private static instance: FilePermissionService
  /** 目录级授权缓存：allowKey(conversationId|sessionId) → 规范化目录集合（授权含全部子树） */
  private allowedDirsByKey: Map<string, Set<string>> = new Map()
  /** 精确路径级缓存：用户仅"确认"（非始终允许文件夹）过的规范化路径 */
  private allowedPathsByKey: Map<string, Set<string>> = new Map()

  private constructor() {}

  static getInstance(): FilePermissionService {
    if (!FilePermissionService.instance) {
      FilePermissionService.instance = new FilePermissionService()
    }
    return FilePermissionService.instance
  }

  /** 当前会话的有效工作区目录：优先任务工作区，其次注入工作区，最后回退员工工作区；失败返回 null */
  getWorkspacePath(): string | null {
    try {
      const ctx = interactionContext.getStore()
      if (!ctx || !ctx.employeeId) return null
      if (ctx.conversationId) {
        try {
          const db = require('./database.service').default.getInstance().getDb()
          const conv = db.prepare('SELECT workspace_path FROM conversations WHERE id = ?').get(ctx.conversationId) as { workspace_path?: string } | undefined
          if (conv?.workspace_path) return conv.workspace_path
        } catch { /* DB 不可用时回退到注入工作区 */ }
      }
      if (ctx.workspacePath) return ctx.workspacePath
      try {
        const db = require('./database.service').default.getInstance().getDb()
        const employee = db.prepare('SELECT workspace_path FROM employees WHERE id = ?').get(ctx.employeeId) as { workspace_path: string | null } | undefined
        return employee?.workspace_path || null
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  /** 路径是否位于当前任务工作区内（规范化边界判定） */
  isPathInWorkspace(filePath: string): boolean {
    const root = this.getWorkspacePath()
    if (!root) return false
    return isWithinPath(normalizePath(filePath), normalizePath(root))
  }

  /** 路径是否已获授权：工作区内 / 精确路径缓存命中 / 目录子树缓存命中 */
  isPathAuthorized(filePath: string): boolean {
    const norm = normalizePath(filePath)
    if (!norm) return false
    if (this.isPathInWorkspace(norm)) return true
    const allowKey = this.currentAllowKey()
    if (!allowKey) return false
    if (this.allowedPathsByKey.get(allowKey)?.has(norm)) return true
    const dirs = this.allowedDirsByKey.get(allowKey)
    if (dirs) {
      for (const dir of dirs) {
        if (isWithinPath(norm, dir)) return true
      }
    }
    return false
  }

  /** 授权一个目录子树（"始终允许此文件夹"） */
  allowDir(dir: string): void {
    const allowKey = this.currentAllowKey()
    if (!allowKey) return
    const norm = normalizePath(dir)
    if (!norm) return
    let set = this.allowedDirsByKey.get(allowKey)
    if (!set) {
      set = new Set()
      this.allowedDirsByKey.set(allowKey, set)
    }
    set.add(norm)
  }

  /** 清理指定会话的授权缓存（conversation 删除时调用，防内存泄漏与授权残留） */
  clearAuthorizations(allowKey: string): void {
    this.allowedDirsByKey.delete(allowKey)
    this.allowedPathsByKey.delete(allowKey)
  }

  /** "始终允许此文件夹"范围是否过宽（盘根/文件系统根、应用数据根、用户主目录），过宽则不提供该选项 */
  private isDirScopeTooBroad(dirScope: string): boolean {
    const scope = normalizePath(dirScope)
    // 盘根（C:\、/）：授权它等于静默授权整盘。必须按路径形状判定，
    // 不能只比对 dataDir/home —— 二者都在 C 盘时，D:\ 之类的盘根会被漏判
    if (isFsRoot(scope)) return true
    // PathService 依赖 electron.app，测试/无 electron 环境下跳过 dataDir 判定
    try {
      const dataDirNorm = normalizePath(PathService.getInstance().getDataDir())
      if (dataDirNorm && isWithinPath(dataDirNorm, scope)) return true
    } catch { /* ignore */ }
    const homeNorm = normalizePath(os.homedir())
    return !!homeNorm && isWithinPath(homeNorm, scope)
  }

  /**
   * 核心入口：校验一组目标路径的文件操作权限。
   * - 工作区内 / 已授权路径自动通过（高权限模式同样直接通过）
   * - 敏感路径（.git/.ssh/.env/密钥等）即使在工作区内也需确认
   * - 区外未授权路径合并为一次弹窗批量确认；用户可选"始终允许此文件夹"（授权公共父目录子树）
   * - options.scopeDir：显式指定"始终允许此文件夹"的授权目录（用于目标本身就是目录的场景，
   *   如 cwd 在区外时授权 cwd 自身；不传则取目标路径的公共父目录）
   * - options.script：脚本触发（shell_exec/javascript_exec）的调用方传入，弹窗改按脚本视角
   *   措辞并展示脚本原文；不传则按文件工具视角输出
   * - options.irreversible：不可逆操作（如 file_delete）传入，确认不可被"始终允许/本轮不再提醒"绕过
   * - options.diff：文件改动预览（unified diff），随确认弹窗下发
   * - 无交互上下文（后台任务）时默认拒绝，防止绕过工作区边界
   */
  async authorizeFileOperation(
    operation: string,
    targetPaths: string[],
    options?: { scopeDir?: string; script?: ScriptConfirmInput; irreversible?: boolean; diff?: DiffDisclosure },
  ): Promise<AuthorizationResult> {
    const root = this.getWorkspacePath()
    const rootNorm = root ? normalizePath(root) : null
    const script = options?.script

    const outside: string[] = []
    const sensitive: string[] = []
    for (const p of targetPaths) {
      const norm = normalizePath(p)
      if (!norm) continue
      if (rootNorm && isWithinPath(norm, rootNorm)) {
        if (this.isSensitivePath(norm)) sensitive.push(norm)
        continue
      }
      if (this.isPathAuthorized(norm)) continue
      outside.push(norm)
    }
    if (outside.length === 0 && sensitive.length === 0) return { allowed: true }

    // 不可逆操作与敏感路径：不接受"始终允许 / 本轮不再提醒"预授权，必须每次显式确认
    const forced = options?.irreversible === true || sensitive.length > 0

    const ctx = interactionContext.getStore()
    if (!ctx) {
      const what = script
        ? (sensitive.length > 0 ? '脚本修改敏感文件' : '脚本写入工作区外文件')
        : (sensitive.length > 0 ? `${operation}敏感文件` : `${operation}工作区外文件`)
      return { allowed: false, error: `${what}需要交互确认，但当前无交互上下文（可能是后台任务），已拒绝` }
    }
    // 高权限模式：单条消息级（ctx.highPermission）或本轮任务级（用户在确认弹窗选择"本轮任务不再提醒"）。
    // forced（不可逆 / 敏感）请求不受其影响，仍需逐次确认。
    if (!forced && (ctx.highPermission || UnifiedInteractionService.getInstance().isTaskHighPermission())) {
      return { allowed: true }
    }

    // "始终允许此文件夹"的授权范围：显式 scopeDir 优先（目标本身是目录），否则取公共父目录。
    // forced 请求不提供目录级授权，避免一次授权覆盖敏感目录子树或后续删除。
    let dirScope = forced
      ? undefined
      : ((options?.scopeDir ? normalizePath(options.scopeDir) : null) || commonParentDir(outside) || undefined)
    // 防过宽授权：agent 一次请求互不相关路径时公共父目录可能收敛到盘根/用户主目录，
    // 此时"始终允许"等于静默授权整盘。此类过宽范围不提供该选项（仅一次性确认）。
    if (dirScope && this.isDirScopeTooBroad(dirScope)) {
      dirScope = undefined
    }
    const message = this.buildConfirmMessage(operation, outside, sensitive, script, dirScope)
    const title = script
      ? SCRIPT_CONFIRM_TITLE
      : (outside.length > 0 ? `确认${operation}工作区外文件` : mainUiI18n.t('sensitiveFileTitle'))

    try {
      const response = await UnifiedInteractionService.getInstance().request({
        type: 'confirm',
        title,
        message,
        danger: true,
        source: `security:fs_outside_workspace:${operation}`,
        dirScope,
        forced,
        script: script ? toScriptDisclosure(script) : undefined,
        diff: options?.diff,
      })

      if (response.cancelled || response.confirmed !== true) {
        const subject = script
          ? '脚本的执行'
          : (outside.length > 0 ? `${operation}工作区外文件的操作` : `${operation}敏感文件的操作`)
        const reason = response.timedOut
          ? `用户在5分钟内未响应确认，可能不在电脑旁，${subject}已取消`
          : `用户取消了${subject}`
        return { allowed: false, error: reason }
      }

      if (response.allowAlwaysDir && dirScope) {
        this.allowDir(dirScope)
      } else if (!forced) {
        // 仅本次确认：缓存精确路径，同路径后续操作自动通过（防止重复弹窗）
        for (const p of outside) this.cacheAuthorizedPath(p)
      }
      return { allowed: true }
    } catch {
      return { allowed: false, error: script ? '脚本执行确认失败，操作已取消' : `${operation}确认失败，操作已取消` }
    }
  }

  /**
   * 是否为敏感路径（凭据 / 密钥 / 版本库内部目录）：命中任一目录段或文件名即视为敏感。
   * 位于工作区内也需确认，且不提供"始终允许"。
   */
  isSensitivePath(filePath: string): boolean {
    const norm = normalizePath(filePath)
    if (!norm) return false
    const segs = norm.split(/[\\/]+/).filter(Boolean)
    for (const seg of segs) {
      if (SENSITIVE_DIR_SEGMENTS.has(seg.toLowerCase())) return true
    }
    const base = segs[segs.length - 1] || ''
    if (!SENSITIVE_FILE_RE.test(base)) return false
    // .env.example / .env.sample 等模板不是敏感文件
    if (/^\.env\./i.test(base) && ENV_TEMPLATE_RE.test(base)) return false
    return true
  }

  private currentAllowKey(): string | null {
    const ctx = interactionContext.getStore()
    if (!ctx) return null
    return ctx.conversationId || ctx.sessionId
  }

  private cacheAuthorizedPath(normPath: string): void {
    const allowKey = this.currentAllowKey()
    if (!allowKey) return
    let set = this.allowedPathsByKey.get(allowKey)
    if (!set) {
      set = new Set()
      this.allowedPathsByKey.set(allowKey, set)
    }
    set.add(normPath)
  }

  private buildConfirmMessage(
    operation: string,
    paths: string[],
    sensitive: string[],
    script?: ScriptConfirmInput,
    dirScope?: string,
  ): string {
    // 脚本触发：沿用脚本视角文案（正文末行为渲染端代码块引导语），敏感路径作为附加段落
    if (script) {
      const intro = paths.length > 0
        ? buildScriptConfirmMessage(paths, dirScope)
        : '即将执行脚本，会写入或修改敏感文件，是否允许？\n\n原始脚本内容如下：'
      return sensitive.length > 0 ? `${intro}\n\n${this.buildSensitiveSection(sensitive)}` : intro
    }

    const parts: string[] = []
    if (paths.length > 0) {
      parts.push(`即将${operation}工作区外的路径（共 ${paths.length} 个）：\n\n${formatPathList(paths)}\n\n是否允许？可选择"始终允许此文件夹"授权以上路径所在目录的全部后续操作。`)
    }
    if (sensitive.length > 0) {
      parts.push(this.buildSensitiveSection(sensitive))
      parts.push(`是否允许？此操作涉及敏感文件，不提供"始终允许"，需逐次确认。`)
    }
    return parts.join('\n\n')
  }

  /** 敏感路径提示段落（弹窗与通知文案共用） */
  private buildSensitiveSection(sensitive: string[]): string {
    if (sensitive.length === 0) return ''
    return `**敏感文件**（凭据 / 密钥 / 版本库内部文件，位于工作区内也需确认，且不提供"始终允许"）：\n\n${formatPathList(sensitive)}`
  }
}

export default FilePermissionService
