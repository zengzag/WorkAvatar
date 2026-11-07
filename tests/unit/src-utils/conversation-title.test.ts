import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * src/utils/conversation-title：任务自动命名
 * - quick 场景模型优先，缺失时回退首个供应商
 * - 标题清理引号、按中英文长度截断并写回会话
 * - 无模型/调用失败/空标题/异常均返回 null，保留默认标题
 */

const getSceneDefaultModel = vi.fn()

vi.mock('../../../src/utils/default-model', () => ({ getSceneDefaultModel }))
vi.mock('../../../src/i18n', () => ({
  default: {
    t: (key: string) => key === 'workbench.titleGenSystemPrompt'
      ? 'You are a conversation title generator.'
      : 'New Task',
  },
}))

const chat = vi.fn()
const getProviders = vi.fn()
const update = vi.fn()

vi.stubGlobal('window', {
  electronAPI: {
    llm: { chat, getProviders },
    conversation: { update },
  },
})

const { defaultConversationTitle, generateConversationTitle } = await import('../../../src/utils/conversation-title')

beforeEach(() => {
  getSceneDefaultModel.mockReset().mockResolvedValue({ provider_id: 'p1', model_id: 'm1' })
  chat.mockReset().mockResolvedValue({ success: true, content: '自动标题' })
  getProviders.mockReset().mockResolvedValue([])
  update.mockReset().mockResolvedValue(undefined)
})

describe('conversation-title / defaultConversationTitle', () => {
  it('使用默认标题文案', () => {
    expect(defaultConversationTitle()).toBe('New Task')
  })
})

describe('conversation-title / generateConversationTitle', () => {
  it('使用 quick 场景模型并把清理后的标题写回会话', async () => {
    chat.mockResolvedValue({ success: true, content: '"自动生成的标题"' })

    const title = await generateConversationTitle('conv1', '帮我整理季度报告')

    expect(title).toBe('自动生成的标题')
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider_id: 'p1',
      model_id: 'm1',
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '帮我整理季度报告' },
      ]),
    }))
    expect(update).toHaveBeenCalledWith({ id: 'conv1', title: '自动生成的标题' })
  })

  it('quick 模型缺失时回退首个供应商', async () => {
    getSceneDefaultModel.mockResolvedValue(null)
    getProviders.mockResolvedValue([{ id: 'fallback' }])

    const title = await generateConversationTitle('conv1', '你好')

    expect(title).toBe('自动标题')
    expect(chat.mock.calls[0][0]).toMatchObject({ provider_id: 'fallback' })
  })

  it('无可用供应商时返回 null 且不发起请求', async () => {
    getSceneDefaultModel.mockResolvedValue(null)
    getProviders.mockResolvedValue([])

    expect(await generateConversationTitle('conv1', '你好')).toBeNull()
    expect(chat).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('模型调用失败或返回空内容时返回 null', async () => {
    chat.mockResolvedValueOnce({ success: false, error: 'boom' })
    expect(await generateConversationTitle('conv1', '你好')).toBeNull()

    chat.mockResolvedValueOnce({ success: true, content: '   ' })
    expect(await generateConversationTitle('conv1', '你好')).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('中文标题截断到 20 字，英文标题截断到 60 字符', async () => {
    chat.mockResolvedValueOnce({ success: true, content: '一'.repeat(30) })
    expect(await generateConversationTitle('conv1', '中文')).toBe('一'.repeat(20))

    chat.mockResolvedValueOnce({ success: true, content: 'a'.repeat(80) })
    expect(await generateConversationTitle('conv2', 'english')).toBe('a'.repeat(60))
  })

  it('IPC 抛错时返回 null', async () => {
    chat.mockRejectedValue(new Error('ipc down'))
    expect(await generateConversationTitle('conv1', '你好')).toBeNull()
  })
})
