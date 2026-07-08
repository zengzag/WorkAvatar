import { useState, useEffect, useCallback } from 'react'
import { Modal, Input, Button, Space, Typography, Alert, Radio, Tag } from 'antd'
import { ExclamationCircleOutlined, WarningOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useInteractionStore, type InteractionRequest } from '../../stores/interaction.store'

const { TextArea } = Input
const { Text, Paragraph } = Typography

const UnifiedInteractionModal: React.FC = () => {
  const { t } = useTranslation()
  const currentRequest = useInteractionStore((s) => s.currentRequest)
  const respond = useInteractionStore((s) => s.respond)
  const enqueue = useInteractionStore((s) => s.enqueue)

  const [inputValue, setInputValue] = useState('')
  const [selectedValue, setSelectedValue] = useState<string | undefined>(undefined)

  useEffect(() => {
    const cleanup = window.electronAPI.interaction.onRequest((request: InteractionRequest) => {
      enqueue(request)
    })
    return () => { cleanup() }
  }, [enqueue])

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
  }, [currentRequest, selectedValue, inputValue, respond])

  const handleAllowAlways = useCallback(() => {
    if (!currentRequest) return
    respond({ confirmed: true, cancelled: false, allowAlways: true })
  }, [currentRequest, respond])

  const handleCancel = useCallback(() => {
    respond({ cancelled: true })
  }, [respond])

  if (!currentRequest) return null

  const isDanger = currentRequest.danger || currentRequest.source?.startsWith('security:')
  const isSecurityConfirm = currentRequest.source?.startsWith('security:')

  const getIcon = () => {
    if (isSecurityConfirm) return <WarningOutlined style={{ color: '#ff4d4f', fontSize: 22 }} />
    if (isDanger) return <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 22 }} />
    return <QuestionCircleOutlined style={{ color: '#1677ff', fontSize: 22 }} />
  }

  const renderContent = () => {
    switch (currentRequest.type) {
      case 'confirm':
        return (
          <div>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
              {currentRequest.message}
            </Paragraph>
          </div>
        )

      case 'select':
        return (
          <div>
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 16 }}>
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
            <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
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

  return (
    <Modal
      open={!!currentRequest}
      title={
        <Space>
          {getIcon()}
          <span>{currentRequest.title || t('interaction.defaultTitle')}</span>
        </Space>
      }
      closable={false}
      mask={{ closable: false }}
      width={currentRequest.type === 'select' && (currentRequest.options?.length || 0) > 3 ? 560 : 480}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button onClick={handleCancel}>
            {currentRequest.type === 'confirm' ? t('interaction.reject') : t('common.cancel')}
          </Button>
          {currentRequest.type === 'confirm' && isSecurityConfirm && (
            <Button onClick={handleAllowAlways}>
              {t('interaction.allowAlways')}
            </Button>
          )}
          <Button
            type="primary"
            danger={isDanger}
            onClick={handleConfirm}
            disabled={
              currentRequest.type === 'select' ? !selectedValue :
              currentRequest.type === 'input' && currentRequest.required ? !inputValue.trim() :
              false
            }
          >
            {currentRequest.type === 'confirm'
              ? t('interaction.confirm')
              : t('common.confirm')
            }
          </Button>
        </Space>
      }
    >
      {isSecurityConfirm && (
        <Alert
          type="warning"
          showIcon
          title={t('interaction.securityWarning')}
          style={{ marginBottom: 16 }}
        />
      )}
      {renderContent()}
    </Modal>
  )
}

export default UnifiedInteractionModal
