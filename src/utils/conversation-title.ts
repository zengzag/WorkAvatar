import dayjs from 'dayjs'
import i18n from '../i18n'
import { DEFAULT_TEMPERATURE } from '../hooks/chat-helpers'
import { getSceneDefaultModel } from './default-model'

/** 新任务默认标题：日期时间；自动命名成功后会被替换 */
export function defaultConversationTitle(): string {
  return String(i18n.t('workbench.defaultConvTitle', { date: dayjs().format('MM/DD HH:mm') }))
}

/**
 * 用 quick 场景模型给会话自动命名（普通任务与小秘书共用）：
 * 成功时写回会话标题并返回新标题，失败返回 null（保留默认日期标题）。
 */
export async function generateConversationTitle(
  conversationId: string,
  userContent: string,
): Promise<string | null> {
  try {
    const quickModel = await getSceneDefaultModel('quick')
    let providerId = quickModel?.provider_id || ''
    if (!providerId) {
      // 兜底：第一个 provider
      const providers = await window.electronAPI.llm.getProviders().catch(() => [])
      providerId = (providers as any[])?.[0]?.id || ''
    }
    if (!providerId) return null

    const result = await window.electronAPI.llm.chat({
      provider_id: providerId,
      model_id: quickModel?.model_id || undefined,
      messages: [
        { role: 'system', content: String(i18n.t('workbench.titleGenSystemPrompt')) },
        { role: 'user', content: userContent },
      ],
      options: { temperature: DEFAULT_TEMPERATURE, max_tokens: 10000 },
    })

    if (!result.success || !result.content) return null

    const raw = result.content.trim().replace(/["']/g, '')
    // 中文标题按 20 字截断，英文按 60 字符截断（约 10 个单词）
    const maxLength = /[\u4e00-\u9fa5]/.test(raw) ? 20 : 60
    const title = raw.substring(0, maxLength).trim()
    if (!title) return null

    await window.electronAPI.conversation.update({ id: conversationId, title })
    return title
  } catch (e) {
    console.error('Failed to generate conversation title:', e)
    return null
  }
}
