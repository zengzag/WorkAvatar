import { Typography, Button, Input, theme, Dropdown, Checkbox, App } from 'antd'
import {
  PlusOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckSquareOutlined,
  SelectOutlined,
} from '@ant-design/icons'
import { memo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../../types'

const { Text } = Typography

const ConversationItem = memo(({
  conv,
  isActive,
  isEditing,
  editingTitle,
  isStreaming,
  onSelect,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onEditKeyDown,
  onDelete,
  isSelectMode,
  isSelected,
  onToggleSelect,
}: {
  conv: Conversation
  isActive: boolean
  isEditing: boolean
  editingTitle: string
  isStreaming: boolean
  onSelect: (id: string) => void
  onStartEdit: (conv: Conversation, e: React.MouseEvent) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onEditTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onDelete: (id: string, e?: React.MouseEvent) => void
  isSelectMode: boolean
  isSelected: boolean
  onToggleSelect: (id: string) => void
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const contextMenuItems = [
    {
      key: 'edit',
      label: t('common.edit'),
      icon: <EditOutlined />,
      onClick: (e: any) => onStartEdit(conv, e.domEvent),
    },
    {
      key: 'delete',
      label: t('common.delete'),
      icon: <DeleteOutlined />,
      danger: true,
      onClick: (e: any) => onDelete(conv.id, e.domEvent),
    },
  ]

  return (
    <Dropdown
      menu={{ items: contextMenuItems }}
      trigger={['contextMenu']}
    >
      <div
        onClick={() => {
          if (isSelectMode) {
            onToggleSelect(conv.id)
          } else if (!isEditing) {
            onSelect(conv.id)
          }
        }}
        style={{
          padding: '10px 14px',
          cursor: isEditing ? 'default' : 'pointer',
          borderLeft: isActive ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
          background: isActive ? token.colorPrimaryBg : 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          transition: 'background 0.2s',
        }}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = token.colorBgTextHover
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        {isSelectMode && (
          <Checkbox checked={isSelected} style={{ flexShrink: 0 }} />
        )}
        {isStreaming && !isSelectMode && (
          <div style={{
            width: 6, height: 6, borderRadius: '50%',
            background: token.colorPrimary,
            flexShrink: 0,
            animation: 'pulse 1.5s ease-in-out infinite',
          }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          {isEditing ? (
            <Input
              value={editingTitle}
              onChange={onEditTitleChange}
              onKeyDown={onEditKeyDown}
              autoFocus
              style={{ fontSize: 13 }}
              size="small"
              suffix={
                <span style={{ display: 'flex', gap: 2 }}>
                  <CheckOutlined style={{ color: '#52c41a', cursor: 'pointer', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onSaveEdit() }} />
                  <CloseOutlined style={{ cursor: 'pointer', fontSize: 12 }} onClick={(e) => { e.stopPropagation(); onCancelEdit() }} />
                </span>
              }
            />
          ) : (
            <Text style={{ fontSize: 13 }} ellipsis>
              {conv.title || t('workbench.defaultConvTitle', { date: '' }).replace(' ', '')}
            </Text>
          )}
        </div>
      </div>
    </Dropdown>
  )
})

const ConversationSidebar: React.FC<{
  conversations: Conversation[]
  allConversations: Conversation[]
  activeConversationId: string | null
  editingConversationId: string | null
  editingTitle: string
  onSelect: (id: string) => void
  onStartEdit: (conv: Conversation, e: React.MouseEvent) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onEditTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onDelete: (id: string, e?: React.MouseEvent) => void
  onDeleteSelected: (ids: string[]) => void
  onNewConversation: () => void
  onLoadMore: () => void
  onListScroll: (e: React.UIEvent<HTMLDivElement>) => void
  isConversationStreaming: (convId: string) => boolean
}> = ({
  conversations,
  allConversations,
  activeConversationId,
  editingConversationId,
  editingTitle,
  onSelect,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onEditKeyDown,
  onDelete,
  onDeleteSelected,
  onNewConversation,
  onLoadMore,
  onListScroll,
  isConversationStreaming,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { modal } = App.useApp()

  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(conversations.map(c => c.id)))
  }, [conversations])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    modal.confirm({
      title: t('workbench.confirmDeleteSelected', { count: selectedIds.size }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await onDeleteSelected(Array.from(selectedIds))
        exitSelectMode()
      },
    })
  }, [selectedIds, onDeleteSelected, exitSelectMode, modal, t])

  return (
    <div style={{
      width: 260,
      flexShrink: 0,
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      display: 'flex',
      flexDirection: 'column',
      background: token.colorBgLayout,
    }}>
      <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
        {selectMode ? (
          <>
            <Button
              icon={<SelectOutlined />}
              size="small"
              onClick={selectAll}
              style={{ flex: 1 }}
            >
              {t('common.selectAll')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              size="small"
              disabled={selectedIds.size === 0}
              onClick={handleDeleteSelected}
            >
              {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
            </Button>
            <Button
              icon={<CloseOutlined />}
              size="small"
              onClick={exitSelectMode}
            />
          </>
        ) : (
          <>
            <Button type="primary" style={{ flex: 1 }} icon={<PlusOutlined />}
              onClick={onNewConversation}>{t('workbench.newConv')}</Button>
            {conversations.length > 0 && (
              <Button
                icon={<CheckSquareOutlined />}
                size="small"
                onClick={() => setSelectMode(true)}
                title={t('workbench.multiSelect')}
              />
            )}
          </>
        )}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }} onScroll={onListScroll}>
        {conversations.map((conv) => (
          <ConversationItem
            key={conv.id}
            conv={conv}
            isActive={activeConversationId === conv.id}
            isEditing={editingConversationId === conv.id}
            editingTitle={editingTitle}
            isStreaming={isConversationStreaming(conv.id)}
            onSelect={onSelect}
            onStartEdit={onStartEdit}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            onEditTitleChange={onEditTitleChange}
            onEditKeyDown={onEditKeyDown}
            onDelete={onDelete}
            isSelectMode={selectMode}
            isSelected={selectedIds.has(conv.id)}
            onToggleSelect={toggleSelect}
          />
        ))}

        {conversations.length < allConversations.length && (
          <div style={{ padding: '12px', textAlign: 'center' }}>
            <Button
              type="dashed"
              block
              onClick={onLoadMore}
            >
              {t('workbench.loadMore', { current: conversations.length, total: allConversations.length })}
            </Button>
          </div>
        )}

        {conversations.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24, color: token.colorTextSecondary, fontSize: 13 }}>{t('workbench.noConv')}</div>
        )}
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}

export default ConversationSidebar
