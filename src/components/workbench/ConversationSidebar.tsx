import { Typography, Button, Input, theme, Dropdown, Checkbox, Popconfirm, App } from 'antd'
import {
  PlusOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckSquareOutlined,
  SelectOutlined,
  ThunderboltOutlined,
  ExportOutlined,
  BulbOutlined,
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
  onGenerateTitle,
  onExport,
  onExtractMemory,
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
  onGenerateTitle: (conv: Conversation) => void
  onExport: (convId: string) => void
  onExtractMemory: (conv: Conversation) => void
  isSelectMode: boolean
  isSelected: boolean
  onToggleSelect: (id: string) => void
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [showDelete, setShowDelete] = useState(false)

  const contextMenuItems = [
    {
      key: 'generate',
      label: t('common.generateTitle'),
      icon: <ThunderboltOutlined />,
      onClick: () => onGenerateTitle(conv),
    },
    {
      key: 'edit',
      label: t('common.editConversationName'),
      icon: <EditOutlined />,
      onClick: (e: any) => onStartEdit(conv, e.domEvent),
    },
    {
      key: 'export',
      label: t('workbench.exportConversation'),
      icon: <ExportOutlined />,
      onClick: () => onExport(conv.id),
    },
    { type: 'divider' as const },
    {
      key: 'extractMemory',
      label: t('common.extractMemory'),
      icon: <BulbOutlined />,
      onClick: () => onExtractMemory(conv),
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
          margin: '0 10px 2px',
          padding: '8px 12px',
          cursor: isEditing ? 'default' : 'pointer',
          borderRadius: 8,
          background: isActive ? token.colorFillSecondary : 'transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = token.colorFillTertiary
          setShowDelete(true)
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
          setShowDelete(false)
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
            <Text style={{ fontSize: 14, fontWeight: isActive ? 500 : 400, color: isActive ? token.colorText : token.colorTextSecondary }} ellipsis>
              {conv.title || t('workbench.untitledConv')}
            </Text>
          )}
        </div>
        {!isEditing && !isSelectMode && (
          <Popconfirm
            title={t('workbench.confirmDelete')}
            onConfirm={(e) => { e?.stopPropagation(); onDelete(conv.id) }}
            onCancel={(e) => e?.stopPropagation()}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true, size: 'small' }}
            cancelButtonProps={{ size: 'small' }}
            placement="left"
          >
            <DeleteOutlined
              onClick={(e) => e.stopPropagation()}
              style={{
                fontSize: 13,
                color: token.colorTextQuaternary,
                cursor: 'pointer',
                opacity: showDelete ? 1 : 0,
                transition: 'opacity 0.2s',
                flexShrink: 0,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = token.colorError
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = token.colorTextQuaternary
              }}
            />
          </Popconfirm>
        )}
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
  onGenerateTitle: (conv: Conversation) => void
  onExport: (convId: string) => void
  onExtractMemory: (conv: Conversation) => void
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
  onGenerateTitle,
  onExport,
  onExtractMemory,
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
      width: 280,
      flexShrink: 0,
      borderRight: `1px solid ${token.colorBorderSecondary}`,
      display: 'flex',
      flexDirection: 'column',
      background: token.colorBgLayout,
    }}>
      <div style={{ padding: '10px', display: 'flex', gap: '6px', alignItems: 'center' }}>
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
            <Button
              style={{
                flex: 1,
                borderRadius: 8,
                background: token.colorFillSecondary,
                border: `1px solid ${token.colorBorderSecondary}`,
                color: token.colorText,
                fontWeight: 500,
              }}
              icon={<PlusOutlined />}
              onClick={onNewConversation}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = token.colorFillTertiary
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = token.colorFillSecondary
              }}
            >
              {t('workbench.newConv')}
            </Button>
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
            onGenerateTitle={onGenerateTitle}
            onExport={onExport}
            onExtractMemory={onExtractMemory}
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
              style={{ borderRadius: 8 }}
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
