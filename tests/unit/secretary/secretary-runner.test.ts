import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 小秘书任务执行器：
 * - 任务结束（完成/失败/中止）都要把「用户任务 + 助手输出」写回会话，不能留空会话
 * - 中止要停主进程运行、任务状态落 failed/aborted
 * - 完成通知的 clickId 必须是 JSON { employeeId, conversationId }（主窗口据此定位会话）
 * - 停用小秘书时要中止所有在跑任务
 */

const posted: any[] = []
vi.mock('../../../src/components/secretary/secretary-bus', () => ({
  postSecretaryMessage: (message: any) => { posted.push(message) },
  subscribeSecretaryBus: () => () => {},
}))
vi.mock('../../../src/i18n', () => ({
  default: { t: (key: string, opts?: any) => (opts?.name ? `${key}:${opts.name}` : key) },
}))
vi.mock('../../../src/components/common/EmployeeAvatar', () => ({
  resolveEmployeeAvatarIcon: (icon?: string | null) => icon || 'robot',
}))
vi.mock('../../../src/utils/tool-display', () => ({
  getToolDisplayName: (name: string) => `tool:${name}`,
}))
vi.mock('../../../src/utils/default-model', () => ({
  getSceneDefaultModel: async () => ({ provider_id: 'p1', model_id: 'm1' }),
}))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, String(value)) },
  removeItem: (key: string) => { storage.delete(key) },
})

const handlers: Record<string, any> = {}
const conversationUpdates: any[] = []
const notifications: any[] = []
const abortChat = vi.fn(async () => ({ success: true }))
let sessionSeq = 0
let runtimeState = { settings: { dnd: true, enabled: true }, panelOpen: false }

vi.stubGlobal('window', {
  electronAPI: {
    llm: {
      onChunk: (fn: any) => { handlers.chunk = fn; return () => {} },
      onToolCall: (fn: any) => { handlers.tool = fn; return () => {} },
      onDone: (fn: any) => { handlers.done = fn; return () => {} },
      onError: (fn: any) => { handlers.error = fn; return () => {} },
      employeeChatStream: async () => ({ success: true, sessionId: `s${++sessionSeq}` }),
      abortChat,
    },
    conversation: {
      create: async () => ({ id: 'conv-1' }),
      update: async (payload: any) => { conversationUpdates.push(payload) },
    },
    secretary: {
      onSettingsChanged: (fn: any) => { handlers.settings = fn; return () => {} },
      getState: async () => runtimeState,
    },
    notification: {
      sendNotification: async (payload: any) => { notifications.push(payload) },
    },
  },
})

const { startSecretaryTask, abortSecretaryTask } = await import('../../../src/components/secretary/secretary-runner')
const { useSecretaryStore } = await import('../../../src/components/secretary/secretary.store')

const employee = {
  id: 'e1',
  name: '员工',
  avatar_icon: 'robot',
  avatar_type: 'icon',
  source: 'builtin',
  avatar_color: '#123456',
} as any

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const currentSession = () => `s${sessionSeq}`
const lastMessages = () => JSON.parse(conversationUpdates[conversationUpdates.length - 1].messages_json)

describe('secretary-runner', () => {
  beforeEach(() => {
    useSecretaryStore.setState({ tasks: [] })
    conversationUpdates.length = 0
    notifications.length = 0
    abortChat.mockClear()
    runtimeState = { settings: { dnd: true, enabled: true }, panelOpen: false }
  })

  it('发起任务：写入初始用户消息，任务进入执行中', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const task = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe('running')
    expect(task?.step).toBe('secretary.thinking')
    expect(task?.conversationId).toBe('conv-1')
    const first = JSON.parse(conversationUpdates[0].messages_json)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ role: 'user', content: '写个报告' })
    // 收尾，避免残留 session 影响后续用例
    handlers.done({ sessionId: currentSession() })
    await flush()
  })

  it('完成：累加流式输出并写回会话，任务标记为待查看', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const sessionId = currentSession()
    handlers.chunk({ sessionId, chunks: ['你好', '世界'] })
    handlers.tool({ sessionId, name: 'file_read' })
    expect(useSecretaryStore.getState().tasks[0].step).toBe('tool:file_read')
    handlers.done({ sessionId })
    await flush()

    const task = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe('done')
    expect(task?.viewed).toBe(false)
    const messages = lastMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '写个报告' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '你好世界' })
  })

  it('完成但无文字输出：写入兜底文案，避免会话出现空白回复', async () => {
    await startSecretaryTask({ employee, prompt: '整理文件', providerId: 'p1', modelId: 'm1' })
    handlers.done({ sessionId: currentSession() })
    await flush()
    expect(lastMessages()[1]).toMatchObject({ role: 'assistant', content: 'secretary.noTextResult' })
  })

  it('失败：保留已有输出并标记失败', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const sessionId = currentSession()
    handlers.chunk({ sessionId, chunks: ['半截'] })
    handlers.error({ sessionId, error: 'network' })
    await flush()
    const task = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('network')
    expect(lastMessages()[1]).toMatchObject({ role: 'assistant', content: '半截' })
  })

  it('完成通知：clickId 携带 employeeId + conversationId，点击可定位会话', async () => {
    runtimeState = { settings: { dnd: false, enabled: true }, panelOpen: false }
    await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    handlers.done({ sessionId: currentSession() })
    await flush()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ clickTarget: 'tasks', source: 'secretary' })
    expect(JSON.parse(notifications[0].clickId)).toEqual({ employeeId: 'e1', conversationId: 'conv-1' })
  })

  it('免打扰或面板打开时不发通知', async () => {
    runtimeState = { settings: { dnd: true, enabled: true }, panelOpen: false }
    await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    handlers.done({ sessionId: currentSession() })
    await flush()
    expect(notifications).toHaveLength(0)

    runtimeState = { settings: { dnd: false, enabled: true }, panelOpen: true }
    await startSecretaryTask({ employee, prompt: '再来一个', providerId: 'p1', modelId: 'm1' })
    handlers.done({ sessionId: currentSession() })
    await flush()
    expect(notifications).toHaveLength(0)
  })

  it('中止：停主进程运行，任务标记为已停止，已有输出落库', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const sessionId = currentSession()
    handlers.chunk({ sessionId, chunks: ['写到一半'] })
    await abortSecretaryTask(taskId)

    const task = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('aborted')
    expect(abortChat).toHaveBeenCalledWith(sessionId)
    expect(lastMessages()[1]).toMatchObject({ role: 'assistant', content: '写到一半' })
  })

  it('停用小秘书：中止所有在跑任务', async () => {
    const a = await startSecretaryTask({ employee, prompt: '任务A', providerId: 'p1', modelId: 'm1' })
    const b = await startSecretaryTask({ employee, prompt: '任务B', providerId: 'p1', modelId: 'm1' })
    handlers.settings({ enabled: false })
    await flush()
    const tasks = useSecretaryStore.getState().tasks
    expect(tasks.find((t) => t.id === a)?.status).toBe('failed')
    expect(tasks.find((t) => t.id === b)?.status).toBe('failed')
    expect(tasks.find((t) => t.id === a)?.error).toBe('aborted')
    expect(abortChat).toHaveBeenCalledTimes(2)
  })
})
