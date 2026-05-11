import { Typography, Button, Space, Popconfirm, Input, theme } from 'antd'
import {
  PlusOutlined,
  ClearOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { memo } from 'react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '../../types'

const { Text } = Typography

const ConversationItem = memo(({
  conv,
  isActive,
  isEditing,
  editingTitle,
  onSelect,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onEditTitleChange,
  onEditKeyDown,
  onDelete,
}: {
  conv: Conversation
  isActive: boolean
  isEditing: boolean
  editingTitle: string
  onSelect: (id: string) => void
  onStartEdit: (conv: Conversation, e: React.MouseEvent) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onEditTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onEditKeyDown: (e: React.KeyboardEvent) => void
  onDelete: (id: string, e: React.MouseEvent) => void
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  return (
    <div
      onClick={() => !isEditing && onSelect(conv.id)}
      style={{
        padding: '10px 14px',
        cursor: isEditing ? 'default' : 'pointer',
        borderLeft: isActive ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
        background: isActive ? token.colorPrimaryBg : 'transparent',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        {isEditing ? (
          <Input
            value={editingTitle}
            onChange={onEditTitleChange}
            onKeyDown={onEditKeyDown}
            autoFocus
            style={{ fontSize: 13, flex: 1, marginRight: 8 }}
            size="small"
          />
        ) : (
          <Text style={{ fontSize: 13, maxWidth: 150 }} ellipsis>
            {conv.title || t('workbench.defaultConvTitle', { date: dayjs(conv.created_at * 1000).format('MM/DD HH:mm') })}
          </Text>
        )}
        <Space size={2}>
          {isEditing ? (
            <>
              <Button type="text" size="small" icon={<CheckOutlined />}
                onClick={onSaveEdit} style={{ color: '#52c41a' }} />
              <Button type="text" size="small" icon={<CloseOutlined />}
                onClick={onCancelEdit} />
            </>
          ) : (
            <>
              <Button type="text" size="small" icon={<EditOutlined />}
                onClick={(e) => onStartEdit(conv, e)} />
              <Popconfirm title={t('workbench.confirmDelete')} onConfirm={(e) => onDelete(conv.id, e!)}
                okText={t('common.confirm')} cancelText={t('common.cancel')}>
                <Button type="text" size="small" danger icon={<DeleteOutlined />}
                  onClick={(ev) => ev.stopPropagation()} />
              </Popconfirm>
            </>
          )}
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {t('common.messages', { count: conv.message_count || 0 })} · {dayjs(conv.created_at * 1000).format('MM-DD HH:mm')}
      </Text>
    </div>
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
  onDelete: (id: string, e: React.MouseEvent) => void
  onDeleteAll: () => void
  onNewConversation: () => void
  onLoadMore: () => void
  onListScroll: (e: React.UIEvent<HTMLDivElement>) => void
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
  onDeleteAll,
  onNewConversation,
  onLoadMore,
  onListScroll,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  return (
    <div style={{
      width: 280,
      flexShrink: 0,
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      display: 'flex',
      flexDirection: 'column',
      background: token.colorBgLayout,
    }}>
      <div style={{ padding: '12px', display: 'flex', gap: '8px' }}>
        <Button type="primary" style={{ flex: 1 }} icon={<PlusOutlined />}
          onClick={onNewConversation}>{t('workbench.newConv')}</Button>
        {conversations.length > 0 && (
          <Popconfirm
            title={t('workbench.confirmClearAll')}
            description={t('workbench.clearAllDesc')}
            onConfirm={onDeleteAll}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button danger icon={<ClearOutlined />} />
          </Popconfirm>
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
            onSelect={onSelect}
            onStartEdit={onStartEdit}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            onEditTitleChange={onEditTitleChange}
            onEditKeyDown={onEditKeyDown}
            onDelete={onDelete}
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
    </div>
  )
}

export default ConversationSidebar
