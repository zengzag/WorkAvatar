import { useEffect } from 'react'
import { Modal } from 'antd'
import { useTranslation } from 'react-i18next'
import { selectModalRequest, useInteractionStore, type InteractionRequest } from '../../stores/interaction.store'
import {
  HighPermissionConfirm,
  InteractionActions,
  InteractionContent,
  InteractionTitleIcon,
  useInteractionResponder,
} from './interaction-parts'

const UnifiedInteractionModal: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { t } = useTranslation()
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
            fontSize: 15,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {currentRequest.title || t('interaction.defaultTitle')}
          </span>
        </div>
      }
      closable={false}
      // 小秘书面板窗打开弹窗时面板整体让位，窗口就是弹窗本身，不需要遮罩
      mask={compact ? false : { closable: false }}
      centered={compact || undefined}
      width={compact ? 'calc(100vw - 16px)' : 520}
      styles={{
        container: { borderRadius: 12, padding: 0, overflow: 'hidden' },
        header: { margin: 0, padding: '14px 20px' },
        // 正文超高时整体滚动；小秘书窗口高度由弹窗自身决定，这里用固定上限
        body: { padding: '14px 20px', maxHeight: compact ? 320 : '60vh', overflowY: 'auto' },
        footer: { margin: 0, padding: '12px 20px' },
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
