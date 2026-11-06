import { useState, useEffect, useCallback, useMemo } from 'react'
import { Modal, Input, Button, Dropdown, Space, Typography, Alert, Radio, Tag, App, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  ExclamationCircleOutlined,
  WarningOutlined,
  QuestionCircleOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  CheckCircleOutlined,
  BellOutlined,
  DownOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useInteractionStore, type InteractionRequest, type DiffDisclosure } from '../../stores/interaction.store'
import { useTaskPermissionStore } from '../../stores/task-permission.store'

const { TextArea } = Input
const { Text, Paragraph } = Typography
const { useToken } = theme

/** 授权下拉项：主文案 + 次要说明 */
function renderAllowOption(title: string, desc: string, descColor: string) {
  return (
    <div style={{ padding: '2px 0', minWidth: 208 }}>
      <div style={{ fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: descColor }}>{desc}</div>
    </div>
  )
}

/** 文件改动预览（unified diff）：按行首 +/-/@@ 前缀着色，独立滚动区 */
const DiffPreview: React.FC<{ diff: DiffDisclosure }> = ({ diff }) => {
  const { t } = useTranslation()
  const { token } = useToken()
  const lines = diff.content.split('\n')
  return (
    <div style={{ marginTop: 14 }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
        {t('interaction.diffLabel')}
      </Text>
      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          maxHeight: 240,
          overflow: 'auto',
          background: token.colorFillQuaternary,
          fontFamily: token.fontFamilyCode,
          fontSize: 12,
          lineHeight: 1.6,
          padding: '6px 0',
        }}
      >
        {lines.map((line, i) => {
          const color = line.startsWith('+') ? token.colorSuccess
            : line.startsWith('-') ? token.colorError
            : line.startsWith('@@') ? token.colorTextTertiary
            : token.colorText
          return (
            <div key={i} style={{ padding: '0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color }}>
              {line || ' '}
            </div>
          )
        })}
      </div>
      {diff.truncated && (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          {t('interaction.diffTruncatedHint')}
        </Text>
      )}
    </div>
  )
}

const UnifiedInteractionModal: React.FC<{ compact?: boolean }> = ({ compact }) => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = useToken()
  const currentRequest = useInteractionStore((s) => s.currentRequest)
  const respond = useInteractionStore((s) => s.respond)
  const enqueue = useInteractionStore((s) => s.enqueue)
  const dismiss = useInteractionStore((s) => s.dismiss)

  const [inputValue, setInputValue] = useState('')
  const [selectedValue, setSelectedValue] = useState<string | undefined>(undefined)

  useEffect(() => {
    const cleanup = window.electronAPI.interaction.onRequest((request: InteractionRequest) => {
      enqueue(request)
    })
    return () => { cleanup() }
  }, [enqueue])

  // 主进程侧请求超时或会话已结束时弹窗自动关闭，避免停留在无法响应的弹窗上
  useEffect(() => {
    const cleanup = window.electronAPI.interaction.onDismiss(({ id }) => {
      dismiss(id)
    })
    return () => { cleanup() }
  }, [dismiss])

  useEffect(() => {
    if (currentRequest) {
      setInputValue(currentRequest.defaultValue || '')
      setSelectedValue(
        currentRequest.options?.find((o) => o.value === currentRequest.defaultValue)?.value ||
        currentRequest.options?.[0]?.value
      )
    }
  }, [currentRequest])

  const handleConfirm = useCallback(() => {
    if (!currentRequest) return
    switch (currentRequest.type) {
      case 'confirm':
        // 模型申请的本轮任务完整访问：确认即开启任务级高权限，界面与主进程登记同步
        if (currentRequest.taskFullAccess) {
          useTaskPermissionStore.getState().enable(currentRequest.conversationId)
          respond({ confirmed: true, cancelled: false, taskHighPermission: true })
          message.warning(t('interaction.taskHighPermissionEnabled'), 5)
          break
        }
        respond({ confirmed: true, cancelled: false })
        break
      case 'select':
        respond({ selectedValue: selectedValue || '', cancelled: false })
        break
      case 'input':
        if (currentRequest.required && !inputValue.trim()) return
        respond({ inputValue, cancelled: false })
        break
    }
  }, [currentRequest, selectedValue, inputValue, respond, message, t])

  const handleAllowAlways = useCallback(() => {
    if (!currentRequest) return
    respond({ confirmed: true, cancelled: false, allowAlways: true })
  }, [currentRequest, respond])

  const handleAllowAlwaysDir = useCallback(() => {
    if (!currentRequest) return
    respond({ confirmed: true, cancelled: false, allowAlwaysDir: true })
  }, [currentRequest, respond])

  /**
   * "本轮任务不再提醒"：开启任务级高权限模式（先经高危二次确认）。
   * 主进程登记随确认响应（taskHighPermission）完成；本地仅同步界面状态，供 ChatInput 高权限按钮显示并支持关闭。
   */
  const handleTaskHighPermission = useCallback(() => {
    if (!currentRequest) return
    useTaskPermissionStore.getState().enable(currentRequest.conversationId)
    respond({ confirmed: true, cancelled: false, taskHighPermission: true })
    message.warning(t('interaction.taskHighPermissionEnabled'), 5)
  }, [currentRequest, respond, message, t])

  const promptTaskHighPermission = useCallback(() => {
    modal.confirm({
      title: t('interaction.taskHighPermissionTitle'),
      icon: <WarningOutlined style={{ color: token.colorError, fontSize: 20 }} />,
      content: (
        <div style={{ marginTop: 6 }}>
          <Text style={{ display: 'block', marginBottom: 8 }}>
            {t('interaction.taskHighPermissionDesc')}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('interaction.taskHighPermissionCloseHint')}
          </Text>
        </div>
      ),
      okText: t('interaction.taskHighPermissionOk'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      centered: true,
      onOk: handleTaskHighPermission,
    })
  }, [modal, t, token.colorError, handleTaskHighPermission])

  const handleCancel = useCallback(() => {
    respond({ cancelled: true })
  }, [respond])

  const showAllowMenu = currentRequest?.type === 'confirm'
    && currentRequest.source?.startsWith('security:')
    && !currentRequest.forced

  const allowMenuItems = useMemo<MenuProps['items']>(() => {
    if (!showAllowMenu) return []
    const items: MenuProps['items'] = [
      {
        key: 'file',
        icon: <FileTextOutlined />,
        label: renderAllowOption(
          t('interaction.allowThisFile'),
          t('interaction.allowThisFileDesc'),
          token.colorTextTertiary
        ),
      },
    ]
    if (currentRequest?.dirScope) {
      items.push({
        key: 'dir',
        icon: <FolderOpenOutlined />,
        label: renderAllowOption(
          t('interaction.allowAlwaysDir'),
          t('interaction.allowThisDirDesc'),
          token.colorTextTertiary
        ),
      })
    } else {
      items.push({
        key: 'source',
        icon: <CheckCircleOutlined />,
        label: renderAllowOption(
          t('interaction.allowAlways'),
          t('interaction.allowAlwaysDesc'),
          token.colorTextTertiary
        ),
      })
    }
    items.push({ type: 'divider' })
    items.push({
      key: 'task',
      icon: <BellOutlined />,
      danger: true,
      label: renderAllowOption(
        t('interaction.taskHighPermission'),
        t('interaction.taskHighPermissionMenuDesc'),
        token.colorError
      ),
    })
    return items
  }, [showAllowMenu, currentRequest?.dirScope, t, token.colorTextTertiary, token.colorError])

  /** 下拉项与右侧一次性允许共用同一套响应逻辑，功能与此前独立按钮一致 */
  const handleAllowMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(({ key }) => {
    switch (key) {
      case 'dir':
        handleAllowAlwaysDir()
        break
      case 'source':
        handleAllowAlways()
        break
      case 'task':
        promptTaskHighPermission()
        break
      default:
        handleConfirm()
    }
  }, [handleAllowAlwaysDir, handleAllowAlways, promptTaskHighPermission, handleConfirm])

  if (!currentRequest) return null

  const isDanger = currentRequest.danger || currentRequest.source?.startsWith('security:')
  const isSecurityConfirm = currentRequest.source?.startsWith('security:')

  const getIcon = () => {
    if (isSecurityConfirm) return <WarningOutlined style={{ color: token.colorError, fontSize: 20 }} />
    if (isDanger) return <ExclamationCircleOutlined style={{ color: token.colorWarning, fontSize: 20 }} />
    return <QuestionCircleOutlined style={{ color: token.colorPrimary, fontSize: 20 }} />
  }

  const renderContent = () => {
    switch (currentRequest.type) {
      case 'confirm':
        return (
          <div>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0, lineHeight: 1.7 }}>
              {currentRequest.message}
            </Paragraph>
            {currentRequest.diff && <DiffPreview diff={currentRequest.diff} />}
          </div>
        )

      case 'select':
        return (
          <div>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 16, lineHeight: 1.7 }}>
              {currentRequest.message}
            </Paragraph>
            <Radio.Group
              value={selectedValue}
              onChange={(e) => setSelectedValue(e.target.value)}
              style={{ width: '100%' }}
            >
              <Space orientation="vertical" style={{ width: '100%' }}>
                {currentRequest.options?.map((option) => (
                  <Radio key={option.value} value={option.value}>
                    <Space>
                      <Text strong>{option.label}</Text>
                      {option.danger && <Tag color="error">{t('interaction.danger')}</Tag>}
                    </Space>
                    {option.description && (
                      <div style={{ marginLeft: 22, marginTop: 2 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{option.description}</Text>
                      </div>
                    )}
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </div>
        )

      case 'input':
        return (
          <div>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 12, lineHeight: 1.7 }}>
              {currentRequest.message}
            </Paragraph>
            <TextArea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={currentRequest.placeholder || t('interaction.inputPlaceholder')}
              autoSize={{ minRows: 2, maxRows: 6 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) {
                  e.preventDefault()
                  handleConfirm()
                }
              }}
            />
            <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
              {t('interaction.ctrlEnterHint')}
            </Text>
          </div>
        )
    }
  }

  const confirmDisabled =
    currentRequest.type === 'select' ? !selectedValue :
    currentRequest.type === 'input' && currentRequest.required ? !inputValue.trim() :
    false

  return (
    <Modal
      open={!!currentRequest}
      rootClassName={compact ? 'wa-approval-modal wa-approval-modal-compact' : 'wa-approval-modal'}
      title={
        <Space size={10}>
          {getIcon()}
          <span style={{ fontWeight: 600 }}>{currentRequest.title || t('interaction.defaultTitle')}</span>
        </Space>
      }
      closable={false}
      // 小秘书面板窗打开弹窗时面板整体让位，窗口就是弹窗本身，不需要遮罩
      mask={compact ? false : { closable: false }}
      // 紧凑模式：小秘书面板窗只有 372px 宽，弹窗必须按窗口宽度自适应并垂直居中
      centered={compact || undefined}
      width={
        compact
          ? 'calc(100vw - 16px)'
          : currentRequest.diff ? 560
            : currentRequest.type === 'select' && (currentRequest.options?.length || 0) > 3 ? 560 : 480
      }
      styles={{
        container: {
          borderRadius: 12,
          padding: 0,
          overflow: 'hidden',
        },
        header: { margin: 0, padding: '14px 20px' },
        // 正文超高时整体滚动：长路径列表与 diff 都可能超出视口。
        // 小秘书窗口高度由弹窗自身高度决定，这里必须用固定上限，否则会和窗口高度互相追赶
        body: { padding: '16px 20px', maxHeight: compact ? 320 : '60vh', overflowY: 'auto' },
        footer: { margin: 0, padding: '12px 20px' },
      }}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          <Button onClick={handleCancel}>
            {currentRequest.type === 'confirm' ? t('interaction.reject') : t('common.cancel')}
          </Button>
          {showAllowMenu ? (
            // 一次性允许 + 下拉授权选项：默认允许此文件，其余授权范围收进下拉
            <div style={{ display: 'inline-flex', alignItems: 'stretch' }}>
              <Button
                type="primary"
                danger={isDanger}
                onClick={handleConfirm}
                style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
              >
                {t('interaction.allowThisFile')}
              </Button>
              <Dropdown
                menu={{ items: allowMenuItems, onClick: handleAllowMenuClick }}
                trigger={['click']}
                placement="topRight"
              >
                <Button
                  type="primary"
                  danger={isDanger}
                  icon={<DownOutlined />}
                  aria-label={t('interaction.allowMenuMore')}
                  style={{
                    paddingInline: 8,
                    borderTopLeftRadius: 0,
                    borderBottomLeftRadius: 0,
                    boxShadow: 'inset 1px 0 0 rgba(255, 255, 255, 0.3)',
                  }}
                />
              </Dropdown>
            </div>
          ) : (
            <Button
              type="primary"
              danger={isDanger}
              onClick={handleConfirm}
              disabled={confirmDisabled}
            >
              {currentRequest.type === 'confirm'
                ? t('interaction.confirm')
                : t('common.confirm')
              }
            </Button>
          )}
        </div>
      }
    >
      {isSecurityConfirm && (
        <Alert
          type="warning"
          showIcon
          title={
            currentRequest.taskFullAccess ? t('interaction.taskAccessHint')
              : currentRequest.forced ? t('interaction.forcedHint')
              : t('interaction.securityWarning')
          }
          style={{ marginBottom: 16, borderRadius: 8 }}
        />
      )}
      {renderContent()}
    </Modal>
  )
}

export default UnifiedInteractionModal
