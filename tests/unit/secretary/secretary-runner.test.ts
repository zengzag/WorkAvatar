import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 小秘书任务执行器：
 * - 任务结束（完成/失败/中止）都要把「用户任务 + 助手输出」写回会话，不能留空会话
 * - 中止要停主进程运行、任务状态落 failed/aborted
 * - 完成/等待确认只走挂件提醒，不再发系统通知
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
const abortChat = vi.fn(async () => ({ success: true }))
let sessionSeq = 0
let lastStreamParams: any = null
/** 自动命名用的 quick 模型返回，默认失败以保留日期标题 */
let chatResult: any = { success: false }
let lastCreatedTitle = ''

vi.stubGlobal('window', {
  electronAPI: {
    llm: {
      onChunk: (fn: any) => { handlers.chunk = fn; return () => {} },
      onThought: (fn: any) => { handlers.thought = fn; return () => {} },
      onToolCall: (fn: any) => { handlers.tool = fn; return () => {} },
      onToolResult: (fn: any) => { handlers.toolResult = fn; return () => {} },
      onDone: (fn: any) => { handlers.done = fn; return () => {} },
      onError: (fn: any) => { handlers.error = fn; return () => {} },
      chat: async () => chatResult,
      employeeChatStream: async (params: any) => {
        lastStreamParams = params
        return { success: true, sessionId: `s${++sessionSeq}` }
      },
      isSessionAttached: async () => false,
      abortChat,
    },
    conversation: {
      create: async (params: any) => {
        lastCreatedTitle = params?.title
        return { id: 'conv-1' }
      },
      // 返回最近一次写入的消息，续接对话时要基于真实历史追加
      get: async () => ({
        id: 'conv-1',
        default_model_json: JSON.stringify({ providerId: 'p1', modelId: 'm1' }),
        messages_json: conversationUpdates.length
          ? conversationUpdates[conversationUpdates.length - 1].messages_json
          : '[]',
      }),
      update: async (payload: any) => { conversationUpdates.push(payload) },
    },
    secretary: {
      onSettingsChanged: (fn: any) => { handlers.settings = fn; return () => {} },
    },
  },
})

const { startSecretaryTask, continueSecretaryTask, abortSecretaryTask } = await import('../../../src/components/secretary/secretary-runner')
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
    chatResult = { success: false }
    abortChat.mockClear()
  })

  it('发起任务：写入初始用户消息，任务进入执行中', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const task = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(task?.status).toBe('running')
    expect(task?.step).toBe('secretary.thinking')
    expect(task?.conversationId).toBe('conv-1')
    // 标题与普通任务一致：先用日期标题
    expect(lastCreatedTitle).toBe('workbench.defaultConvTitle')
    expect(task?.title).toBe('workbench.defaultConvTitle')
    const first = JSON.parse(conversationUpdates[0].messages_json)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ role: 'user', content: '写个报告' })
    // 收尾，避免残留 session 影响后续用例
    handlers.done({ sessionId: currentSession() })
    await flush()
  })

  it('标题自动命名成功：替换会话标题与面板任务标题', async () => {
    chatResult = { success: true, content: '周报汇总' }
    const taskId = await startSecretaryTask({ employee, prompt: '把这周的日报汇总成周报', providerId: 'p1', modelId: 'm1' })
    await flush()

    expect(useSecretaryStore.getState().tasks.find((t) => t.id === taskId)?.title).toBe('周报汇总')
    expect(conversationUpdates.some((u) => u.title === '周报汇总')).toBe(true)

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

  it('完成：思考、工具调用与用量一并落库（主窗口未打开时不丢过程）', async () => {
    await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    const sessionId = currentSession()
    handlers.thought({ sessionId, thought: '先想一下' })
    handlers.tool({ sessionId, id: 't1', name: 'file_read', args: { path: 'a.md' } })
    handlers.toolResult({ sessionId, name: 'file_read', result: '内容' })
    handlers.chunk({ sessionId, chunks: ['好了'] })
    handlers.done({
      sessionId,
      metadata: { tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } },
    })
    await flush()

    const assistant = lastMessages()[1]
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: '好了',
      thought: '先想一下',
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    })
    // 段按真实发生顺序落库：思考 → 工具调用 → 正文
    expect(assistant.segments.map((s: any) => s.type)).toEqual(['thinking', 'tool_call', 'answer'])
    expect(assistant.segments[1]).toMatchObject({ toolName: 'file_read', toolResult: '内容', isToolComplete: true })
  })

  it('工具产物落库：generatedFiles 记到工具段（面板对话窗据此展示文件名）', async () => {
    await startSecretaryTask({ employee, prompt: '导出报告', providerId: 'p1', modelId: 'm1' })
    const sessionId = currentSession()
    const file = { path: '/tmp/报告.md', name: '报告.md', ext: 'md', size: 128 }
    handlers.tool({ sessionId, id: 't1', name: 'report_generated_files', args: {} })
    handlers.toolResult({ sessionId, name: 'report_generated_files', result: 'ok', generatedFiles: [file] })
    handlers.chunk({ sessionId, chunks: ['已生成'] })
    handlers.done({ sessionId })
    await flush()

    expect(lastMessages()[1].segments[0].generatedFiles).toEqual([file])
  })

  it('节流落库不拆段：跨多次落库后思考仍合并为一段', async () => {
    vi.useFakeTimers()
    try {
      await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
      const sessionId = currentSession()
      handlers.thought({ sessionId, thought: '先想' })
      await vi.advanceTimersByTimeAsync(600)
      handlers.thought({ sessionId, thought: '一下' })
      await vi.advanceTimersByTimeAsync(600)
      handlers.thought({ sessionId, thought: '再说' })
      handlers.done({ sessionId })
      await vi.advanceTimersByTimeAsync(0)

      const assistant = lastMessages()[1]
      expect(assistant.thought).toBe('先想一下再说')
      expect(assistant.segments.filter((s: any) => s.type === 'thinking')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('续接对话：历史 + 新提问一起发给模型，收尾写回完整多轮', async () => {
    const taskId = await startSecretaryTask({ employee, prompt: '写个报告', providerId: 'p1', modelId: 'm1' })
    handlers.chunk({ sessionId: currentSession(), chunks: ['第一版'] })
    handlers.done({ sessionId: currentSession() })
    await flush()

    await continueSecretaryTask({ taskId, prompt: '再补充一点', providerId: 'p1', modelId: 'm1' })
    const running = useSecretaryStore.getState().tasks.find((t) => t.id === taskId)
    expect(running?.status).toBe('running')
    // 发给模型的历史 = 原始任务 + 第一版回答 + 新提问
    expect(lastStreamParams.messages).toHaveLength(3)
    expect(lastStreamParams.messages[2]).toMatchObject({ role: 'user', content: '再补充一点' })

    const sessionId = currentSession()
    handlers.chunk({ sessionId, chunks: ['补充完成'] })
    handlers.done({ sessionId })
    await flush()

    const messages = lastMessages()
    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user', content: '写个报告' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '第一版' })
    expect(messages[2]).toMatchObject({ role: 'user', content: '再补充一点' })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: '补充完成' })
    expect(useSecretaryStore.getState().tasks.find((t) => t.id === taskId)?.status).toBe('done')
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
