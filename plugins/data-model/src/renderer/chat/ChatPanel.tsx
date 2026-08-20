// 对话面板：复用宿主任务对话 UI（GenericChatView），消息状态由 store 维护（收起/展开不丢失）

import { useEffect } from 'react'
import { App, Select, Button, Tooltip } from 'antd'
import { PlusOutlined, FolderOpenOutlined, DeleteOutlined } from '@ant-design/icons'
import { useDataModelStore } from '../data-model.store'
import { dm, getHostCapabilities, hostT } from '../store'

export function ChatPanel() {
  const messages = useDataModelStore((s) => s.messages)
  const isStreaming = useDataModelStore((s) => s.isStreaming)
  const chatError = useDataModelStore((s) => s.chatError)
  const providers = useDataModelStore((s) => s.providers)
  const conversationId = useDataModelStore((s) => s.conversationId)
  const chats = useDataModelStore((s) => s.chats)
  const workspacePath = useDataModelStore((s) => s.workspacePath)
  const contextStats = useDataModelStore((s) => s.contextStats)
  const { sendMessage, cancelChat, newChat, loadChats, loadChatHistory, deleteChat, openChatDir, deleteMessage, toggleSegment } = useDataModelStore.getState()
  const { modal } = App.useApp()

  const GenericChatView = getHostCapabilities()?.GenericChatView

  // 加载历史对话列表（列表变化时刷新）
  useEffect(() => {
    void loadChats()
    const unsub = dm.onChatsChanged(() => void loadChats())
    return unsub
  }, [])

  const handleOpenTaskDir = () => {
    if (conversationId) void openChatDir(conversationId)
  }

  const handleDeleteChat = (convId: string) => {
    void (async () => {
      const res = await deleteChat(convId)
      // 任务文件夹非空：提示是否同时删除（空文件夹已在主进程直接删除）
      if ('taskDirNonEmpty' in res && res.taskDirNonEmpty && res.taskDir) {
        modal.confirm({
          title: hostT('chat.deleteTaskDir'),
          okText: hostT('chat.deleteWithFiles'),
          cancelText: hostT('chat.deleteOnly'),
          okDanger: true,
          onOk: () => void dm.deleteChatTaskDir(res.taskDir as string)
        })
      }
    })()
  }

  // 顶部自定义区：历史对话切换 + 打开任务文件夹 + 新对话按钮（模型选择已移至设置面板）
  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {chats.length > 0 && (
        <Select
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={hostT('page.chatHistory')}
          value={conversationId ?? undefined}
          onChange={(id) => void loadChatHistory(id)}
          options={chats.map((c) => ({ value: c.conversationId, label: c.title }))}
          allowClear
          onClear={() => newChat()}
          popupRender={(menu) => (
            <>
              {menu}
              {conversationId && (
                <div style={{ padding: 4, borderTop: '1px solid var(--dm-border)' }}>
                  <Button
                    size="small"
                    danger
                    block
                    icon={<DeleteOutlined />}
                    onClick={() => handleDeleteChat(conversationId)}
                  >
                    {hostT('page.delete')}
                  </Button>
                </div>
              )}
            </>
          )}
        />
      )}
      {conversationId && workspacePath && (
        <Tooltip title={hostT('chat.openTaskDir')}>
          <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={handleOpenTaskDir} />
        </Tooltip>
      )}
      <Tooltip title={hostT('chat.newChat')}>
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={newChat} />
      </Tooltip>
    </div>
  )

  if (!GenericChatView) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--dm-muted)' }}>{hostT('chat.unsupported')}</div>
  }

  return (
    <GenericChatView
      messages={messages}
      isStreaming={isStreaming}
      chatError={chatError ? hostT(chatError) : null}
      conversationId={conversationId}
      providers={providers}
      placeholder={hostT('page.chatPlaceholder')}
      header={header}
      contextStats={contextStats}
      onSend={(text, images) => void sendMessage(text, images)}
      onStop={cancelChat}
      onToggleSegment={toggleSegment}
      onDeleteMessage={(msgId) => void deleteMessage(msgId)}
    />
  )
}
