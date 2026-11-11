/**
 * 当前工作台激活会话（仅本渲染进程内有效）。
 * 大任务会话的委托子过程改为按需拉取后，委托卡片需要知道所属会话 id；
 * 通过模块级登记避免把 conversationId 逐层透传到所有消息/段组件。
 */
let activeConversationId: string | null = null

export const setActiveWorkbenchConversation = (id: string | null): void => {
  activeConversationId = id
}

export const getActiveWorkbenchConversation = (): string | null => activeConversationId
