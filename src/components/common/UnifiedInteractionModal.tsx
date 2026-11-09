import { useEffect } from 'react'
import { Button, Modal, theme } from 'antd'
import { EyeInvisibleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { selectModalRequest, useInteractionStore, type InteractionRequest } from '../../stores/interaction.store'
import {
  HighPermissionConfirm,
  InteractionActions,
  InteractionContent,
  InteractionTitleIcon,
  useInteractionResponder,
} from './interaction-parts'

interface UnifiedInteractionModalProps {
  compact?: boolean
  /** 小秘书面板里确认框的自动收起时长：仅用于展示倒计时进度条 */
  autoHideMs?: number
  /** 面板当前可见时才播放倒计时 */
  active?: boolean
  /** 立即隐藏确认框（请求保留在通知列表） */
  onHide?: () => void
}

const UnifiedInteractionModal: React.FC<UnifiedInteractionModalProps> = ({ compact, autoHideMs, active, onHide }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const currentRequest = useInteractionStore(selectModalRequest)
  const respondById = useInteractionStore((s) => s.respondById)
  const enqueue = useInteractionStore((s) => s.enqueue)
  const dismiss = useInteractionStore((s) => s.dismiss)

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
  } = useInteractionResponder(currentRequest, respondById)

  useEffect(() => {
    const cleanup = window.electronAPI.interaction.onRequest((request: InteractionRequest) => {
      enqueue(request)
    })
    return () => { cleanup() }
  }, [enqueue])

  // 主进程侧请求超时或会话已结束时自动关闭，避免停留在一个无法响应的确认框上
  useEffect(() => {
    const cleanup = window.electronAPI.interaction.onDismiss(({ id }) => {
      dismiss(id)
    })
    return () => { cleanup() }
  }, [dismiss])

  if (!currentRequest) return null

  return (
    <Modal
      open
      rootClassName={compact ? 'wa-approval-modal wa-approval-modal-compact' : 'wa-approval-modal'}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <InteractionTitleIcon request={currentRequest} />
          <span style={{
            flex: 1,
            minWidth: 0,
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {currentRequest.title || t('interaction.defaultTitle')}
          </span>
          {compact && onHide && (
            <Button
              type="text"
              size="small"
              icon={<EyeInvisibleOutlined style={{ fontSize: 12 }} />}
              onClick={onHide}
              style={{
                flexShrink: 0,
                height: 24,
                paddingInline: 6,
                fontSize: 12,
                color: token.colorTextTertiary,
              }}
            >
              {t('interaction.hide')}
            </Button>
          )}
          {/* 倒计时进度条贴弹窗顶边，不占用内容高度；播完自动收起面板，请求保留 */}
          {compact && autoHideMs && active && (
            <div className="wa-countdown-bar is-overlay" style={{ background: token.colorFillSecondary }}>
              <div
                key={`${currentRequest.id}-${active ? 'on' : 'off'}`}
                className="wa-countdown-bar-fill"
                style={{ background: token.colorPrimary, animationDuration: `${autoHideMs}ms` }}
              />
            </div>
          )}
        </div>
      }
      closable={false}
      // 小秘书面板窗打开弹窗时面板整体让位，窗口就是弹窗本身，不需要遮罩
      mask={compact ? false : { closable: false }}
      centered={compact || undefined}
      width={compact ? 'calc(100vw - 16px)' : 520}
      styles={{
        container: {
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
          ...(compact ? { position: 'relative', display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 16px)' } : {}),
        },
        header: { margin: 0, padding: '14px 20px', flex: '0 0 auto' },
        // 小窗高度固定：正文占满剩余高度并内部滚动，超高也不会被窗口裁掉
        body: compact
          ? { padding: '14px 20px', flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }
          : { padding: '14px 20px', maxHeight: '60vh', overflowY: 'auto' },
        footer: { margin: 0, padding: '12px 20px', flex: '0 0 auto' },
      }}
      footer={
        !highPermissionPrompt && (
          <InteractionActions
            request={currentRequest}
            confirmDisabled={confirmDisabled}
            onCancel={handleCancel}
            onConfirm={handleConfirm}
            onAllowAlways={handleAllowAlways}
            onAllowAlwaysDir={handleAllowAlwaysDir}
            onRequestHighPermission={handleRequestHighPermission}
          />
        )
      }
    >
      <InteractionContent
        request={currentRequest}
        selectedValue={selectedValue}
        onSelect={setSelectedValue}
        inputValue={inputValue}
        onInputChange={setInputValue}
        onInputSubmit={handleConfirm}
      />
      {highPermissionPrompt && (
        <HighPermissionConfirm
          description={t('interaction.taskHighPermissionDesc')}
          onConfirm={handleConfirmHighPermission}
          onCancel={cancelHighPermissionPrompt}
        />
      )}
    </Modal>
  )
}

export default UnifiedInteractionModal
