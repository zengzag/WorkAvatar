// 对话面板

import { useEffect, useRef, useState } from 'react'
import { Button, Input, Select, Empty, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, ClearOutlined, CloseOutlined } from '@ant-design/icons'
import { useDataModelStore, type ChatMessage } from '../data-model.store'
import { dm, hostT } from '../store'

function ToolCallCard({ tc }: { tc: NonNullable<ChatMessage['toolCalls']>[number] }) {
  const name = tc.name ?? ''
  const icon = name.startsWith('list_') || name.startsWith('get_') ? '🔍'
    : name.startsWith('create_') ? '➕'
    : name.startsWith('update_') ? '✏️'
    : name.startsWith('delete_') ? '🗑'
    : name === 'create_relationship' ? '🔗'
    : name === 'import_dbml' ? '📥'
    : name === 'clear_model' ? '🧹'
    : '🛠'
  return (
    <div style={{ border: '1px solid var(--dm-border)', borderRadius: 8, padding: '6px 10px', fontSize: 12, margin: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{icon}</span>
        <span style={{ fontWeight: 600 }}>{name}</span>
        <span style={{ marginLeft: 'auto', color: tc.status === 'error' ? '#ef4444' : tc.status === 'done' ? '#10b981' : 'var(--dm-muted)' }}>
          {tc.status === 'running' ? '…' : tc.status === 'done' ? '✓' : tc.status === 'error' ? '✗' : ''}
        </span>
      </div>
      {tc.output && <div style={{ color: 'var(--dm-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{tc.output}</div>}
    </div>
  )
}

function MessageRow({ msg }: { msg: ChatMessage }) {
  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
        <div style={{ background: 'var(--dm-primary)', color: '#fff', borderRadius: 12, padding: '8px 12px', maxWidth: '85%', fontSize: 13, whiteSpace: 'pre-wrap' }}>
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '6px 0' }}>
      <div style={{ maxWidth: '90%', width: '100%' }}>
        {msg.reasoning && (
          <details style={{ border: '1px solid var(--dm-border)', borderRadius: 8, padding: '6px 10px', marginBottom: 4, fontSize: 12, color: 'var(--dm-muted)' }}>
            <summary>{hostT('page.thinking')}</summary>
            <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{msg.reasoning}</div>
          </details>
        )}
        {msg.toolCalls && msg.toolCalls.length > 0 && msg.toolCalls.map((tc, i) => <ToolCallCard key={i} tc={tc} />)}
        <div style={{ background: 'var(--dm-bg-soft)', borderRadius: 12, padding: '8px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
          {msg.content}
          {msg.streaming && <span style={{ display: 'inline-block', width: 8, height: 14, background: 'var(--dm-primary)', marginLeft: 2, animation: 'dm-blink 1s infinite' }} />}
        </div>
      </div>
    </div>
  )
}

export function ChatPanel({ onClose }: { onClose?: () => void }) {
  const messages = useDataModelStore((s) => s.messages)
  const isStreaming = useDataModelStore((s) => s.isStreaming)
  const chatError = useDataModelStore((s) => s.chatError)
  const employees = useDataModelStore((s) => s.employees)
  const providers = useDataModelStore((s) => s.providers)
  const selectedEmployeeId = useDataModelStore((s) => s.selectedEmployeeId)
  const selectedProviderId = useDataModelStore((s) => s.selectedProviderId)
  const selectedModelId = useDataModelStore((s) => s.selectedModelId)
  const conversationId = useDataModelStore((s) => s.conversationId)
  const chats = useDataModelStore((s) => s.chats)
  const { sendMessage, cancelChat, newChat, setSelectedEmployee, setSelectedProvider, setSelectedModel, loadChats, loadChatHistory, deleteChat } = useDataModelStore.getState()

  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  const selectedProvider = providers.find((p) => p.id === selectedProviderId)
  const models = selectedProvider?.models_json
    ? (() => {
        try { return JSON.parse(selectedProvider.models_json) as Array<{ id: string; model: string; name?: string }> } catch { return [] }
      })()
    : []

  // 加载历史对话列表（员工变化 / 列表变化时刷新）
  useEffect(() => {
    void loadChats()
    const unsub = dm.onChatsChanged(() => void loadChats())
    return unsub
  }, [selectedEmployeeId])

  // 订阅 chat 事件
  useEffect(() => {
    const unsub = dm.onChatEvent((payload: any) => {
      const s = useDataModelStore.getState()
      const msgs = [...s.messages]
      const last = msgs[msgs.length - 1]
      if (!last || last.role !== 'assistant') return
      switch (payload.type) {
        case 'chunk':
          last.content += payload.text ?? ''
          break
        case 'thought':
          last.reasoning = (last.reasoning ?? '') + (payload.thought ?? '')
          break
        case 'tool-call': {
          last.toolCalls = last.toolCalls ?? []
          const tc = payload.toolCall
          const existing = last.toolCalls.find((t) => t.id && t.id === tc.id)
          if (existing) existing.status = 'running'
          else last.toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, status: 'running' })
          break
        }
        case 'done':
          last.streaming = false
          useDataModelStore.setState({ isStreaming: false })
          break
        case 'error':
          last.streaming = false
          useDataModelStore.setState({ isStreaming: false, chatError: payload.error })
          break
      }
      useDataModelStore.setState({ messages: msgs })
    })
    return unsub
  }, [])

  // 自动滚动
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])

  const handleSend = () => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput('')
    void sendMessage(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--dm-border)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Select
            size="small"
            style={{ flex: 1 }}
            placeholder={hostT('page.selectEmployee')}
            value={selectedEmployeeId ?? undefined}
            onChange={setSelectedEmployee}
            options={employees.map((e) => ({ value: e.id, label: e.name }))}
          />
          <Tooltip title={hostT('page.newChat')}>
            <Button size="small" icon={<ClearOutlined />} onClick={newChat} />
          </Tooltip>
          {onClose && (
            <Tooltip title={hostT('page.close')}>
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
            </Tooltip>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Select
            size="small"
            style={{ flex: 1 }}
            placeholder={hostT('settings.selectProvider')}
            value={selectedProviderId ?? undefined}
            onChange={setSelectedProvider}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
            allowClear
          />
          {selectedProvider && (
            <Select
              size="small"
              style={{ flex: 1 }}
              placeholder={hostT('settings.selectModel')}
              value={selectedModelId ?? undefined}
              onChange={setSelectedModel}
              options={models.map((m) => ({ value: m.id, label: m.name ?? m.model }))}
              allowClear
            />
          )}
        </div>
        {chats.length > 0 && (
          <Select
            size="small"
            style={{ width: '100%' }}
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
                      onClick={() => conversationId && void deleteChat(conversationId)}
                    >
                      {hostT('page.delete')}
                    </Button>
                  </div>
                )}
              </>
            )}
          />
        )}
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {messages.length === 0 && (
          <Empty description={hostT('page.chatEmpty')} style={{ marginTop: 40 }} />
        )}
        {messages.map((m) => <MessageRow key={m.id} msg={m} />)}
        {chatError && <div style={{ color: '#ef4444', fontSize: 12, marginTop: 8 }}>{hostT(chatError)}</div>}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--dm-border)', display: 'flex', gap: 8 }}>
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hostT('page.chatPlaceholder')}
          autoSize={{ minRows: 1, maxRows: 4 }}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); handleSend() } }}
          disabled={isStreaming}
        />
        {isStreaming ? (
          <Button icon={<StopOutlined />} onClick={cancelChat} />
        ) : (
          <Button type="primary" icon={<SendOutlined />} onClick={handleSend} />
        )}
      </div>
    </div>
  )
}
