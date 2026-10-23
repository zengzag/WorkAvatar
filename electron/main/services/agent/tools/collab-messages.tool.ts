import type { ToolDefinition } from './types'
import SubAgentRuntime from '../../agent-runtime/runtime'
import DatabaseService from '../../database.service'
import { interactionContext } from '../../unified-interaction.service'

/**
 * 多智能体协作基元工具对：
 * - send_message：主管/兄弟 run 向某个运行中或排队中的 run 发送一条消息（写入其运行时邮箱）
 * - read_messages：子会话读取自己收到的消息（读取后视为已读）
 *
 * 轻量版"平级协作"：不做常驻会话间通道，消息经 SubAgentRuntime 邮箱中转，
 * 目标子会话在下一轮工具调用中主动读取，事件亦会上报到前端运行面板。
 */
export const sendMessageTool: ToolDefinition = {
  id: 'send_message',
  name: 'send_message',
  title: '发送消息给子任务',
  summary: 'Send one message to a running sub-task; the sub-task reads it with read_messages.',
  description: `Send one message to a running sub-task (runId from launch_agents / delegate_to_employee), e.g. to add a requirement or redirect its work. The sub-task reads it with read_messages.

Only running or queued sub-tasks can receive messages; a finished run cannot.`,
  parameters: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'runId of the target sub-task' },
      message: { type: 'string', description: 'Message content' },
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
  summary: 'Read messages sent by the parent or a peer via send_message.',
  description: 'Read the messages this sub-task received. Reading marks them as read, so later calls return only new ones. Check for messages before acting when the task objective may have changed.',
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