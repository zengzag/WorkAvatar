import type { ToolDefinition, ToolCallResult, ToolHandlerContext, ToolPermission } from './types'
import UnifiedInteractionService from '../../unified-interaction.service'
import mainUiI18n from '../../ui-i18n.service'
import { createLogger } from '../../logger'

const logger = createLogger('ToolPermission')

/**
 * 工具权限策略（单一事实来源）：
 * - 声明级别：工具通过 `permission` 声明 safe / requires_confirmation / dangerous，未声明按 safe 处理
 *   （内置工具默认安全；插件/技能等外部来源未声明时打警告，但不改变既有行为，避免插件工具每次调用都弹窗）
 * - 自授权工具（selfAuthorized）：handler 内部已统一经 FilePermissionService 判定（区内放行、
 *   区外/敏感路径弹窗、删除强制确认），前置门不再重复弹窗，避免双重确认
 * - 不可逆工具：确认不可被"本次任务始终允许 / 本轮任务不再提醒"绕过
 *
 * 执行路径有两条，但都源自本文件的策略：
 *   1) 前置门 ToolPermissionGate（挂在 ToolDispatcher，先于所有中间件，含插件中间件，不可绕过）
 *      —— 负责工具级确认（如 run_skill_script）
 *   2) FilePermissionService —— 负责路径/脚本级确认，消费 isIrreversibleTool 强制语义
 */

/** 不可逆操作：删除后无法在应用内还原（回收站可找回，但不在授权缓存/高权限放行范围内） */
const IRREVERSIBLE_TOOLS: ReadonlySet<string> = new Set(['file_delete'])

/** 未声明 permission 时的来源默认级别 */
function defaultPermissionBySource(_source: ToolDefinition['source']): ToolPermission {
  return 'safe'
}

export function resolveToolPermission(tool: ToolDefinition): ToolPermission {
  return tool.permission ?? defaultPermissionBySource(tool.source)
}

export function isIrreversibleTool(toolName: string): boolean {
  return IRREVERSIBLE_TOOLS.has(toolName)
}

/** 注册时校验：外部来源（插件/技能）未声明 permission 时提示，属声明缺失而非运行时错误 */
export function warnUndeclaredPermission(tool: ToolDefinition): void {
  if (tool.permission) return
  if (tool.source === 'plugin' || tool.source === 'skill' || tool.source === 'dynamic') {
    logger.warn(`工具 "${tool.name}"（来源 ${tool.source}）未声明 permission，按 safe 处理；涉及副作用请显式声明`)
  }
}

/**
 * 前置权限门：在 ToolDispatcher.dispatch 中先于中间件链执行，
 * 返回非 null 即短路本次调用（拒绝）。返回 null 表示放行。
 */
export interface ToolPermissionGate {
  check(tool: ToolDefinition, args: Record<string, any>, context?: ToolHandlerContext): Promise<ToolCallResult | null>
}

export function createToolPermissionGate(): ToolPermissionGate {
  return {
    async check(tool) {
      const level = resolveToolPermission(tool)
      if (level === 'safe' || tool.selfAuthorized) return null

      const irreversible = isIrreversibleTool(tool.name)
      let response
      try {
        response = await UnifiedInteractionService.getInstance().request({
          type: 'confirm',
          title: mainUiI18n.t('toolConfirmTitle'),
          message: mainUiI18n.t('toolConfirmMessage', { name: tool.title || tool.name }),
          danger: true,
          source: `security:tool:${tool.name}`,
          forced: irreversible,
        })
      } catch {
        return { success: false, error: `工具 "${tool.name}" 的授权确认失败，调用已取消`, toolName: tool.name }
      }

      if (response.cancelled || response.confirmed !== true) {
        return {
          success: false,
          error: `用户未授权执行工具 "${tool.name}"${response.timedOut ? '（等待确认超时）' : ''}，调用已取消`,
          toolName: tool.name,
        }
      }
      return null
    },
  }
}
