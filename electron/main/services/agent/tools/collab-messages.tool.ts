import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import DatabaseService from '../../database.service'
import { interactionContext } from '../../unified-interaction.service'

/**
 * 多智能体协作基元工具对：
 * - send_message：主管/兄弟 run 向某个运行中的 run 发送一条消息（写入其运行时邮箱）
 * - read_messages：子会话读取自己收到的消息（读取后视为已读）
 *
 * 轻量版"平级协作"：不做常驻会话间通道，消息经 SubAgentRuntime 邮箱中转，
 * 目标子会话在下一轮工具调用中主动读取，事件亦会上报到前端运行面板。
 */
export const sendMessageTool: ToolDefinition = {
  id: 'send_message',
  name: 'send_message',
  title: '发送消息给子任务',
  summary: '向运行中的子任务发送一条消息，对方可用 read_messages 读取',
  description: `向指定的、正在运行的子任务（runId，launch_agents/delegate 返回）发送一条消息，用于补充新要求或调整执行方向。对方子会话在后续执行中可调用 read_messages 查看。
参数：
- run_id: 目标子任务的 runId
- message: 消息内容（数量不限）
限制：仅对运行中/排队中的子任务有效；已结束的 run 无法接收。`,
  parameters: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: '目标子任务的 runId' },
      message: { type: 'string', description: '消息内容' },
    },
    required: ['run_id', 'message'],
  },
  handler: handleSendMessage,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
}

export const readMessagesTool: ToolDefinition = {
  id: 'read_messages',
  name: 'read_messages',
  title: '读取接收到的消息',
  summary: '读取主管或协作方通过 send_message 发来的消息',
  description: `读取本子任务收到的消息（发送方通过 send_message 发送的补充指令/说明）。读取后视为已读，后续再调用只会返回新消息。若任务目标有变化，应先读取再执行。`,
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: handleReadMessages,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
}

async function handleSendMessage(args: Record<string, any>): Promise<any> {
  const runId = args.run_id
  const content = String(args.message || '')
  if (!runId || typeof runId !== 'string') {
    return { success: false, error: '缺少 run_id' }
  }
  if (!content.trim()) {
    return { success: false, error: '消息内容不能为空' }
  }
  const store = interactionContext.getStore()
  let fromName = ''
  try {
    const row = DatabaseService.getInstance().getDb()
      .prepare('SELECT name FROM employees WHERE id = ?').get(store?.employeeId || '') as { name?: string } | undefined
    fromName = row?.name || ''
  } catch { /* ignore */ }

  const res = SubAgentRuntime.getInstance().sendMessage(runId, content, fromName || '主管')
  if (!res.success) {
    return { success: false, error: res.error }
  }
  return { success: true, output: `已向子任务 ${runId} 发送消息。` }
}

async function handleReadMessages(): Promise<any> {
  const store = interactionContext.getStore()
  const runId = store?.delegationId
  if (!runId) {
    return { success: false, error: '当前上下文未关联子任务运行' }
  }
  const messages = SubAgentRuntime.getInstance().readMessages(runId)
  if (messages.length === 0) {
    return { success: true, output: '暂无新消息' }
  }
  const lines = messages.map(m => `[来自 ${m.fromEmployeeName}] ${m.content}`)
  return { success: true, output: `收到 ${messages.length} 条消息：\n${lines.join('\n')}`, messages }
}