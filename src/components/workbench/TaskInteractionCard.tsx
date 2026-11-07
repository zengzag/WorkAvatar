import { useMemo } from 'react'
import { Button, Dropdown, Tag, Tooltip, theme } from 'antd'
import type { MenuProps } from 'antd'
import { WarningFilled, RightOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { InteractionRequest, InteractionResponse } from '../../stores/interaction.store'
import {
  HighPermissionConfirm,
  InteractionActions,
  InteractionContent,
  InteractionTitleIcon,
  useInteractionResponder,
} from '../common/interaction-parts'

/**
 * 任务对话内的确认卡：
 * - 固定展示当前任务的第一个待处理请求，响应后自动切换到下一个
 * - 与输入框同宽、位于输入框上方，不遮挡消息区，也不打断其他任务的对话
 */
export const TaskInteractionCard: React.FC<{
  requests: InteractionRequest[]
  respondById: (id: string, response: InteractionResponse) => void
}> = ({ requests, respondById }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const request = requests[0] ?? null

  const {
    inputValue,
    setInputValue,
    selectedValue,
    setSelectedValue,
    highPermissionPrompt,
    confirmDisabled,
    handleConfirm,
    handleAllowAlways,
    handleAllowAlwaysDir,
    handleRequestHighPermission,
    handleConfirmHighPermission,
    cancelHighPermissionPrompt,
    handleCancel,
  } = useInteractionResponder(request, respondById)

  if (!request) return null

  const isSecurity = !!request.source?.startsWith('security:')
  const accent = isSecurity ? token.colorError : request.danger ? token.colorWarning : token.colorPrimary
  const borderColor = isSecurity
    ? token.colorErrorBorder
    : request.danger ? token.colorWarningBorder : token.colorPrimaryBorder
  const queueCount = requests.length - 1

  return (
    <div
      className="wa-inline-approval"
      data-testid="task-interaction-card"
      style={{
        border: `1px solid ${borderColor}`,
        background: 'var(--wa-panel)',
      }}
    >
      <div style={{
        width: 3,
        flexShrink: 0,
        alignSelf: 'stretch',
        background: accent,
        opacity: 0.85,
      }} />
      <div style={{ flex: 1, minWidth: 0, padding: '10px 12px 10px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <InteractionTitleIcon request={request} />
          <span style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: token.colorText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {request.title || t('interaction.defaultTitle')}
          </span>
          {queueCount > 0 && (
            <Tooltip title={t('interaction.pendingQueueHint')}>
              <Tag style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 6px' }}>
                {t('interaction.pendingQueue', { count: queueCount })}
              </Tag>
            </Tooltip>
          )}
        </div>

        <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
          <InteractionContent
            request={request}
            selectedValue={selectedValue}
            onSelect={setSelectedValue}
            inputValue={inputValue}
            onInputChange={setInputValue}
            onInputSubmit={handleConfirm}
            diffCollapsible
            diffDefaultOpen
          />
          {highPermissionPrompt && (
            <HighPermissionConfirm
              description={t('interaction.taskHighPermissionDesc')}
              onConfirm={handleConfirmHighPermission}
              onCancel={cancelHighPermissionPrompt}
            />
          )}
        </div>

        {!highPermissionPrompt && (
          <div style={{ marginTop: 10 }}>
            <InteractionActions
              request={request}
              confirmDisabled={confirmDisabled}
              onCancel={handleCancel}
              onConfirm={handleConfirm}
              onAllowAlways={handleAllowAlways}
              onAllowAlwaysDir={handleAllowAlwaysDir}
              onRequestHighPermission={handleRequestHighPermission}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export interface PendingApprovalItem {
  conversationId: string
  title: string
  count: number
}

/** 其他任务待确认提示：非弹窗、可一键切到对应任务 */
export const PendingApprovalsBar: React.FC<{
  items: PendingApprovalItem[]
  onSelect: (conversationId: string) => void
}> = ({ items, onSelect }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const menuItems = useMemo<MenuProps['items']>(() => items.map((item) => ({
    key: item.conversationId,
    label: (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 220, maxWidth: 360 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
          {item.title}
        </span>
        <Tag color="warning" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>
          {item.count}
        </Tag>
      </div>
    ),
  })), [items])

  if (items.length === 0) return null

  const total = items.reduce((sum, item) => sum + item.count, 0)

  return (
    <div className="wa-pending-approvals" style={{ borderColor: token.colorWarningBorder }}>
      <WarningFilled style={{ fontSize: 12, color: token.colorWarning }} />
      <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
        {t('interaction.otherTasksPending', { count: items.length })}
      </span>
      {items.length === 1 ? (
        <Button
          type="link"
          size="small"
          onClick={() => onSelect(items[0].conversationId)}
          style={{ padding: 0, height: 18, fontSize: 12 }}
        >
          {t('interaction.goReview')}
          <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      ) : (
        <Dropdown
          menu={{ items: menuItems, onClick: ({ key }) => onSelect(String(key)) }}
          trigger={['click']}
          placement="bottomLeft"
        >
          <Button type="link" size="small" style={{ padding: 0, height: 18, fontSize: 12 }}>
            {t('interaction.viewTasks', { count: total })}
            <RightOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      )}
    </div>
  )
}
