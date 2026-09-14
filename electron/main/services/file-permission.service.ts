import os from 'os'
import { normalizePath, isWithinPath, commonParentDir } from './path-normalize'
import UnifiedInteractionService, { interactionContext } from './unified-interaction.service'
import PathService from './path.service'

/**
 * 文件权限管理服务（统一门面）：
 * - 工作区边界判定（路径规范化后前缀匹配，兼容大小写/斜杠/符号链接/8.3 短名）
 * - 会话级授权缓存：目录级（"始终允许此文件夹"，含子树）+ 精确路径级（仅本次确认）
 * - 批量确认：多个区外路径按公共父目录归并，单次弹窗完成授权
 * - 任务级高权限（"本轮任务不再提醒"，登记在 UnifiedInteractionService）：本轮任务后续区外操作直接放行
 *
 * 所有需要文件权限判定的工具（file_write/file_edit/shell_exec/javascript_exec）
 * 统一通过 authorizeFileOperation 走本服务，不再各自实现边界判定与弹窗。
 */

export interface AuthorizationResult {
  allowed: boolean
  error?: string
}

/** 弹窗展示的路径数上限，超出折叠 */
const MAX_DISPLAY_PATHS = 15

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

  /** "始终允许此文件夹"范围是否过宽（覆盖应用数据根 / 用户主目录），过宽则不提供该选项 */
  private isDirScopeTooBroad(dirScope: string): boolean {
    // PathService 依赖 electron.app，测试/无 electron 环境下跳过 dataDir 判定
    try {
      const dataDirNorm = normalizePath(PathService.getInstance().getDataDir())
      if (dataDirNorm && isWithinPath(dataDirNorm, dirScope)) return true
    } catch { /* ignore */ }
    const homeNorm = normalizePath(os.homedir())
    if (homeNorm && isWithinPath(homeNorm, dirScope)) return true
    return false
  }

  /**
   * 核心入口：校验一组目标路径的文件操作权限。
   * - 工作区内 / 已授权路径自动通过（高权限模式同样直接通过）
   * - 区外未授权路径合并为一次弹窗批量确认；用户可选"始终允许此文件夹"（授权公共父目录子树）
   * - options.scopeDir：显式指定"始终允许此文件夹"的授权目录（用于目标本身就是目录的场景，
   *   如 cwd 在区外时授权 cwd 自身；不传则取目标路径的公共父目录）
   * - 无交互上下文（后台任务）时默认拒绝，防止绕过工作区边界
   */
  async authorizeFileOperation(
    operation: string,
    targetPaths: string[],
    options?: { scopeDir?: string },
  ): Promise<AuthorizationResult> {
    const root = this.getWorkspacePath()
    const rootNorm = root ? normalizePath(root) : null

    const outside: string[] = []
    for (const p of targetPaths) {
      const norm = normalizePath(p)
      if (!norm) continue
      if (rootNorm && isWithinPath(norm, rootNorm)) continue
      if (this.isPathAuthorized(norm)) continue
      outside.push(norm)
    }
    if (outside.length === 0) return { allowed: true }

    const ctx = interactionContext.getStore()
    if (!ctx) {
      return { allowed: false, error: `${operation}工作区外文件需要交互确认，但当前无交互上下文（可能是后台任务），已拒绝` }
    }
    // 高权限模式：单条消息级（ctx.highPermission）或本轮任务级（用户在确认弹窗选择"本轮任务不再提醒"）
    if (ctx.highPermission || UnifiedInteractionService.getInstance().isTaskHighPermission()) return { allowed: true }

    // "始终允许此文件夹"的授权范围：显式 scopeDir 优先（目标本身是目录），否则取公共父目录
    let dirScope = (options?.scopeDir ? normalizePath(options.scopeDir) : null)
      || commonParentDir(outside)
      || undefined
    // 防过宽授权：agent 一次请求互不相关路径时公共父目录可能收敛到盘根/用户主目录，
    // 此时"始终允许"等于静默授权整盘。此类过宽范围不提供该选项（仅一次性确认）。
    if (dirScope && this.isDirScopeTooBroad(dirScope)) {
      dirScope = undefined
    }
    const message = this.buildConfirmMessage(operation, outside)

    try {
      const response = await UnifiedInteractionService.getInstance().request({
        type: 'confirm',
        title: `确认${operation}工作区外文件`,
        message,
        danger: true,
        source: `security:fs_outside_workspace:${operation}`,
        dirScope,
      })

      if (response.cancelled || response.confirmed !== true) {
        const reason = response.timedOut
          ? `用户在5分钟内未响应${operation}确认，可能不在电脑旁，操作已取消`
          : `用户取消了${operation}工作区外文件的操作`
        return { allowed: false, error: reason }
      }

      if (response.allowAlwaysDir && dirScope) {
        this.allowDir(dirScope)
      } else {
        // 仅本次确认：缓存精确路径，同路径后续操作自动通过（防止重复弹窗）
        for (const p of outside) this.cacheAuthorizedPath(p)
      }
      return { allowed: true }
    } catch {
      return { allowed: false, error: `${operation}确认失败，操作已取消` }
    }
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

  private buildConfirmMessage(operation: string, paths: string[]): string {
    const shown = paths.slice(0, MAX_DISPLAY_PATHS)
    const lines = shown.map((p) => `- ${p}`)
    if (paths.length > shown.length) {
      lines.push(`- ...（共 ${paths.length} 个路径）`)
    }
    return `即将${operation}工作区外的路径（共 ${paths.length} 个）：\n\n${lines.join('\n')}\n\n是否允许？可选择"始终允许此文件夹"授权以上路径所在目录的全部后续操作。`
  }
}

export default FilePermissionService
