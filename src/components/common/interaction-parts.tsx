import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Dropdown, Input, Tag, Typography, theme } from 'antd'
import type { MenuProps } from 'antd'
import {
  BellOutlined,
  CheckCircleFilled,
  DownOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  QuestionCircleOutlined,
  WarningFilled,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useTaskPermissionStore } from '../../stores/task-permission.store'
import type { DiffDisclosure, InteractionRequest, InteractionResponse } from '../../stores/interaction.store'

const { Text } = Typography

/** 授权下拉项：主文案 + 次要说明 */
function renderAllowOption(title: string, desc: string, descColor: string) {
  return (
    <div style={{ padding: '2px 0', minWidth: 216 }}>
      <div style={{ fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: descColor }}>{desc}</div>
    </div>
  )
}

/** 交互正文：支持 **加粗** 与 ``` 代码块，保留换行 */
export const InteractionMessageText: React.FC<{ text: string; style?: React.CSSProperties }> = ({ text, style }) => {
  const { token } = theme.useToken()
  const parts = useMemo(() => text.split(/(```[\s\S]*?```)/g), [text])

  return (
    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.72, ...style }}>
      {parts.map((part, index) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const raw = part.slice(3, -3)
          const firstBreak = raw.indexOf('\n')
          const code = firstBreak >= 0 ? raw.slice(firstBreak + 1) : raw
          return (
            <pre
              key={`code-${index}`}
              className="wa-detail-block"
              style={{
                margin: '8px 0',
                fontFamily: token.fontFamilyCode,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 180,
                overflow: 'auto',
              }}
            >
              {code}
            </pre>
          )
        }
        return part.split(/(\*\*[^*\n]+\*\*)/g).map((piece, pieceIndex) => {
          if (piece.startsWith('**') && piece.endsWith('**')) {
            return <strong key={`b-${index}-${pieceIndex}`}>{piece.slice(2, -2)}</strong>
          }
          return <span key={`t-${index}-${pieceIndex}`}>{piece}</span>
        })
      })}
    </div>
  )
}

const diffCounts = (diff: DiffDisclosure) => {
  const lines = diff.content.split('\n')
  return {
    added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  }
}

/** 文件改动预览：按行首 +/-/@@ 前缀着色，独立滚动区 */
export const DiffPreview: React.FC<{
  diff: DiffDisclosure
  collapsible?: boolean
  defaultOpen?: boolean
}> = ({ diff, collapsible = false, defaultOpen = true }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [open, setOpen] = useState(defaultOpen)
  const counts = useMemo(() => diffCounts(diff), [diff])
  const expanded = !collapsible || open
  const lines = diff.content.split('\n')

  return (
    <div style={{ marginTop: 10 }}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: token.colorTextSecondary,
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          <FileTextOutlined style={{ fontSize: 12 }} />
          {t('interaction.viewDiff', { added: counts.added, removed: counts.removed })}
          <DownOutlined style={{ fontSize: 10, transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
        </button>
      ) : (
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
          {t('interaction.diffLabel')}
        </Text>
      )}
      {expanded && (
        <>
          <div
            className="wa-detail-block"
            style={{
              marginTop: collapsible ? 6 : 0,
              maxHeight: 220,
              overflow: 'auto',
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
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
              {t('interaction.diffTruncatedHint')}
            </Text>
          )}
        </>
      )}
    </div>
  )
}

/** 选项列表：整行可点击，选中态用主色描边，避免 Radio 在窄卡片里换行错位 */
export const InteractionOptions: React.FC<{
  options: NonNullable<InteractionRequest['options']>
  value?: string
  onChange: (value: string) => void
}> = ({ options, value, onChange }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()

  return (
    <div role="radiogroup" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <div
            key={option.value}
            role="radio"
            aria-checked={selected}
            tabIndex={0}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onChange(option.value)
              }
            }}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              border: `1px solid ${selected ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
              background: selected ? token.colorPrimaryBg : token.colorFillQuaternary,
              transition: 'border-color .15s, background .15s',
            }}
          >
            <span style={{ flexShrink: 0, marginTop: 1, color: selected ? token.colorPrimary : token.colorTextQuaternary }}>
              {selected
                ? <CheckCircleFilled style={{ fontSize: 13 }} />
                : <span style={{ display: 'inline-block', width: 13, height: 13, borderRadius: '50%', border: `1px solid ${token.colorBorder}` }} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: selected ? 500 : 400, color: selected ? token.colorPrimary : token.colorText }}>
                  {option.label}
                </span>
                {option.danger && (
                  <Tag color="error" style={{ margin: 0, fontSize: 10, lineHeight: '16px', padding: '0 5px' }}>
                    {t('interaction.danger')}
                  </Tag>
                )}
              </div>
              {option.description && (
                <div style={{ marginTop: 2, fontSize: 12, lineHeight: 1.5, color: token.colorTextTertiary }}>
                  {option.description}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 安全提示条：按请求类型给出简短的允许/拒绝后果说明 */
export const InteractionSecurityAlert: React.FC<{ request: InteractionRequest }> = ({ request }) => {
  const { t } = useTranslation()
  if (!request.source?.startsWith('security:')) return null
  const message = request.taskFullAccess
    ? t('interaction.taskAccessHint')
    : request.forced ? t('interaction.forcedHint') : t('interaction.securityWarning')
  return <Alert type="warning" showIcon title={message} style={{ marginBottom: 10, borderRadius: 8 }} />
}

/** 确认卡正文：标题/说明/选项/输入/diff 统一排版 */
export const InteractionContent: React.FC<{
  request: InteractionRequest
  selectedValue?: string
  onSelect: (value: string) => void
  inputValue: string
  onInputChange: (value: string) => void
  onInputSubmit?: () => void
  diffCollapsible?: boolean
  diffDefaultOpen?: boolean
}> = ({
  request,
  selectedValue,
  onSelect,
  inputValue,
  onInputChange,
  onInputSubmit,
  diffCollapsible = false,
  diffDefaultOpen = true,
}) => {
  const { t } = useTranslation()
  const messageNode = <InteractionMessageText text={request.message} style={{ marginBottom: 0 }} />

  return (
    <div>
      <InteractionSecurityAlert request={request} />
      {request.type === 'confirm' && (
        <>
          {messageNode}
          {request.diff && <DiffPreview diff={request.diff} collapsible={diffCollapsible} defaultOpen={diffDefaultOpen} />}
        </>
      )}
      {request.type === 'select' && (
        <>
          <div style={{ marginBottom: 10 }}>{messageNode}</div>
          <InteractionOptions options={request.options || []} value={selectedValue} onChange={onSelect} />
        </>
      )}
      {request.type === 'input' && (
        <>
          <div style={{ marginBottom: 10 }}>{messageNode}</div>
          <Input.TextArea
            value={inputValue}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={request.placeholder || t('interaction.inputPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                onInputSubmit?.()
              }
            }}
          />
          <Text type="secondary" style={{ fontSize: 11, marginTop: 4, display: 'block' }}>
            {t('interaction.ctrlEnterHint')}
          </Text>
        </>
      )}
    </div>
  )
}

/** 授权下拉菜单项；非安全类请求或强制确认时返回 undefined */
export function buildAllowMenuItems(
  request: InteractionRequest,
  t: (key: string, options?: Record<string, any>) => string,
  token: { colorTextTertiary: string; colorError: string },
): MenuProps['items'] | undefined {
  if (request.type !== 'confirm' || !request.source?.startsWith('security:') || request.forced) return undefined
  const items: NonNullable<MenuProps['items']> = []
  if (request.dirScope) {
    items.push({
      key: 'dir',
      icon: <FolderOpenOutlined />,
      label: renderAllowOption(
        t('interaction.allowAlwaysDir'),
        t('interaction.allowThisDirDesc'),
        token.colorTextTertiary,
      ),
    })
  } else {
    items.push({
      key: 'source',
      icon: <CheckCircleFilled />,
      label: renderAllowOption(
        t('interaction.allowAlways'),
        t('interaction.allowAlwaysDesc'),
        token.colorTextTertiary,
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
      token.colorError,
    ),
  })
  return items
}

/** 本轮任务高权限的二次确认：内联展开，不再叠加一层全局弹窗 */
export const HighPermissionConfirm: React.FC<{
  description: string
  onConfirm: () => void
  onCancel: () => void
}> = ({ description, onConfirm, onCancel }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  return (
    <div style={{
      marginTop: 10,
      padding: '10px 12px',
      borderRadius: 8,
      border: `1px solid ${token.colorErrorBorder}`,
      background: token.colorErrorBg,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: token.colorError }}>
        <WarningFilled style={{ fontSize: 13 }} />
        {t('interaction.taskHighPermissionTitle')}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.6, color: token.colorTextSecondary }}>
        {description}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5, color: token.colorTextTertiary }}>
        {t('interaction.taskHighPermissionCloseHint')}
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <Button size="small" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button size="small" danger type="primary" onClick={onConfirm}>
          {t('interaction.taskHighPermissionOk')}
        </Button>
      </div>
    </div>
  )
}

/** 统一的确认操作区：拒绝 + 主操作（安全确认带更宽授权下拉） */
export const InteractionActions: React.FC<{
  request: InteractionRequest
  confirmDisabled?: boolean
  onCancel: () => void
  onConfirm: () => void
  onAllowAlways: () => void
  onAllowAlwaysDir: () => void
  onRequestHighPermission: () => void
}> = ({
  request,
  confirmDisabled,
  onCancel,
  onConfirm,
  onAllowAlways,
  onAllowAlwaysDir,
  onRequestHighPermission,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const isDanger = !!(request.danger || request.source?.startsWith('security:'))
  const menuItems = buildAllowMenuItems(request, t, token)

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key }) => {
    if (key === 'dir') onAllowAlwaysDir()
    else if (key === 'source') onAllowAlways()
    else if (key === 'task') onRequestHighPermission()
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
      <Button onClick={onCancel} data-testid="interaction-reject">
        {request.type === 'confirm' ? t('interaction.reject') : t('common.cancel')}
      </Button>
      {menuItems ? (
        <div style={{ display: 'inline-flex', alignItems: 'stretch' }}>
          <Button
            type="primary"
            danger={isDanger}
            disabled={confirmDisabled}
            onClick={onConfirm}
            data-testid="interaction-allow-once"
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            {t('interaction.allowOnce')}
          </Button>
          <Dropdown menu={{ items: menuItems, onClick: handleMenuClick }} trigger={['click']} placement="topRight">
            <Button
              type="primary"
              danger={isDanger}
              disabled={confirmDisabled}
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
        <Button type="primary" danger={isDanger} disabled={confirmDisabled} onClick={onConfirm} data-testid="interaction-confirm">
          {request.type === 'confirm' ? t('interaction.confirm') : t('common.confirm')}
        </Button>
      )}
    </div>
  )
}

/** 交互响应逻辑（确认/拒绝/更宽授权/任务高权限），弹窗与内联卡共用 */
export function useInteractionResponder(
  request: InteractionRequest | null,
  respondById: (id: string, response: InteractionResponse) => void,
) {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [inputValue, setInputValue] = useState('')
  const [selectedValue, setSelectedValue] = useState<string | undefined>(undefined)
  const [highPermissionPrompt, setHighPermissionPrompt] = useState(false)

  useEffect(() => {
    if (!request) {
      setInputValue('')
      setSelectedValue(undefined)
      setHighPermissionPrompt(false)
      return
    }
    setInputValue(request.defaultValue || '')
    setSelectedValue(
      request.options?.find((o) => o.value === request.defaultValue)?.value
      || request.options?.[0]?.value,
    )
    setHighPermissionPrompt(false)
  }, [request])

  const respond = useCallback((response: InteractionResponse) => {
    if (request) respondById(request.id, response)
  }, [request, respondById])

  const handleConfirm = useCallback(() => {
    if (!request) return
    if (request.type === 'confirm' && request.taskFullAccess) {
      useTaskPermissionStore.getState().enable(request.conversationId)
      respond({ confirmed: true, cancelled: false, taskHighPermission: true })
      message.warning(t('interaction.taskHighPermissionEnabled'), 5)
      return
    }
    if (request.type === 'select') {
      respond({ selectedValue: selectedValue || '', cancelled: false })
      return
    }
    if (request.type === 'input') {
      if (request.required && !inputValue.trim()) return
      respond({ inputValue, cancelled: false })
      return
    }
    respond({ confirmed: true, cancelled: false })
  }, [request, respond, selectedValue, inputValue, message, t])

  const handleAllowAlways = useCallback(() => {
    respond({ confirmed: true, cancelled: false, allowAlways: true })
  }, [respond])

  const handleAllowAlwaysDir = useCallback(() => {
    respond({ confirmed: true, cancelled: false, allowAlwaysDir: true })
  }, [respond])

  const handleRequestHighPermission = useCallback(() => {
    setHighPermissionPrompt(true)
  }, [])

  const handleConfirmHighPermission = useCallback(() => {
    if (!request) return
    useTaskPermissionStore.getState().enable(request.conversationId)
    respond({ confirmed: true, cancelled: false, taskHighPermission: true })
    message.warning(t('interaction.taskHighPermissionEnabled'), 5)
  }, [request, respond, message, t])

  const handleCancel = useCallback(() => {
    respond({ cancelled: true })
  }, [respond])

  const confirmDisabled =
    request?.type === 'select' ? !selectedValue
      : request?.type === 'input' && request.required ? !inputValue.trim()
        : false

  return {
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
    cancelHighPermissionPrompt: useCallback(() => setHighPermissionPrompt(false), []),
    handleCancel,
  }
}

/** 供弹窗/内联卡标题使用的图标 */
export const InteractionTitleIcon: React.FC<{ request: InteractionRequest }> = ({ request }) => {
  const { token } = theme.useToken()
  const isSecurity = request.source?.startsWith('security:')
  const isDanger = !!(request.danger || isSecurity)
  if (isDanger) {
    return <WarningFilled style={{ color: isSecurity ? token.colorError : token.colorWarning, fontSize: 18 }} />
  }
  if (request.type === 'input') {
    return <EditOutlined style={{ color: token.colorPrimary, fontSize: 17 }} />
  }
  return <QuestionCircleOutlined style={{ color: token.colorPrimary, fontSize: 17 }} />
}
