/**
 * 模板任务运行事件 → 插件宿主广播。
 * 渲染端消费统一走 workflow 插件的 ctx.ipc.broadcast('run-event')（见插件 main），
 * 内核不再持有渲染端直连通道；此处延迟 require 避免与 plugin-host 的循环依赖
 * （plugin-host 反向 require workflow-runtime）。
 */
import type { PluginWorkflowRunEvent } from '../../../plugin-sdk/src'
import { WORKFLOW_EVENT_NAME } from './plugin/plugin-host.service'

export function broadcastWorkflowRunEvent(event: PluginWorkflowRunEvent, conversationId?: string): void {
  try {
    const { default: PluginHostService } = require('./plugin/plugin-host.service')
    PluginHostService.getInstance().notifyKernelEvent(WORKFLOW_EVENT_NAME, { ...event, conversationId: conversationId || '' })
  } catch { /* 插件宿主未就绪时忽略 */ }
}
