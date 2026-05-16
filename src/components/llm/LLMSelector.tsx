import { useState, useEffect } from 'react'
import { Select, Space, Tag, Input, theme } from 'antd'
import { RobotOutlined, CloudServerOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LLMProvider } from '../../types'
import { getProviderModels } from '../../utils/llm'

const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'moonshot', 'yi'])
const LOCAL_PROVIDERS = new Set(['lmstudio', 'openai-compatible'])

interface LLMSelectorProps {
  providerId?: string
  modelId?: string
  onProviderChange: (providerId: string) => void
  onModelChange: (modelId: string) => void
  style?: React.CSSProperties
  modelCategory?: 'chat' | 'embedding'
  providers?: LLMProvider[]
}

const ellipsisStyle: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }

const LLMSelector: React.FC<LLMSelectorProps> = ({
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
  style,
  modelCategory,
  providers: externalProviders,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [internalProviders, setInternalProviders] = useState<LLMProvider[]>([])
  const [customProviderId, setCustomProviderId] = useState(providerId || '')
  const [customModel, setCustomModel] = useState(modelId || '')

  const providers = externalProviders ?? internalProviders

  useEffect(() => {
    if (externalProviders) return
    window.electronAPI.llm.getProviders().then((result: any) => {
      setInternalProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [externalProviders])

  useEffect(() => {
    setCustomProviderId(providerId || '')
  }, [providerId])

  useEffect(() => {
    setCustomModel(modelId || '')
  }, [modelId])

  const selectedProvider = customProviderId ? providers.find(p => p.id === customProviderId) : null
  const allModels = selectedProvider ? getProviderModels(selectedProvider) : []
  const modelOptions = modelCategory
    ? allModels.filter(m => (m.category || 'chat') === modelCategory)
    : allModels

  const hasModelOptions = modelOptions.length > 0

  const providerOptions = providers.map((p) => {
    const isDomestic = DOMESTIC_PROVIDERS.has(p.provider_type)
    const isLocal = LOCAL_PROVIDERS.has(p.provider_type)
    return {
      value: p.id,
      label: (
        <Space size={4}>
          {isDomestic && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('llmSelector.domestic')}</Tag>}
          {isLocal && <Tag color="green" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('llmSelector.local')}</Tag>}
          <span>{p.name}</span>
        </Space>
      ),
      searchLabel: `${p.name} ${p.model} ${p.provider_type}`,
    }
  })

  const selectMaxWidth = 160

  const handleProviderChange = (value: string) => {
    setCustomProviderId(value)
    setCustomModel('')
    onProviderChange(value)
  }

  const handleModelSelect = (value: string) => {
    onModelChange(value)
    setCustomModel(value)
  }

  const handleCustomModelConfirm = () => {
    if (customModel.trim()) {
      onModelChange(customModel.trim())
    }
  }

  return (
    <Space size={8} style={style}>
      {modelCategory === 'embedding' ? (
        <CloudServerOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
      ) : (
        <RobotOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
      )}
      <Select
        size="small"
        placeholder={t('llmSelector.selectProvider')}
        style={{ minWidth: 100, maxWidth: selectMaxWidth }}
        value={customProviderId || undefined}
        onChange={handleProviderChange}
        optionLabelProp="label"
        showSearch
        filterOption={(input, option) =>
          (option?.searchLabel as string || '').toLowerCase().includes(input.toLowerCase())
        }
        options={providerOptions.map((opt) => ({
          value: opt.value,
          label: <span style={ellipsisStyle}>{opt.label}</span>,
          title: opt.searchLabel,
          searchLabel: opt.searchLabel,
        }))}
        allowClear
      />
      {customProviderId && hasModelOptions && (
        <Select
          size="small"
          placeholder={t('llmSelector.selectModel')}
          style={{ minWidth: 90, maxWidth: selectMaxWidth }}
          value={customModel || undefined}
          onChange={handleModelSelect}
          optionLabelProp="label"
          options={modelOptions.map((opt) => ({
            value: opt.model,
            label: <span style={ellipsisStyle}>{opt.name}</span>,
          }))}
          allowClear
        />
      )}
      {customProviderId && !hasModelOptions && (
        <Input
          size="small"
          placeholder={modelCategory === 'embedding' ? (selectedProvider?.embedding_model || t('llmSelector.inputModel')) : (selectedProvider?.model || t('llmSelector.inputModel'))}
          value={customModel}
          onChange={e => setCustomModel(e.target.value)}
          onPressEnter={handleCustomModelConfirm}
          onBlur={handleCustomModelConfirm}
          style={{ minWidth: 90, maxWidth: selectMaxWidth }}
        />
      )}
    </Space>
  )
}

export default LLMSelector
