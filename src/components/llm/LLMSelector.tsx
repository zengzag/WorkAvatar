import { useState, useEffect } from 'react'
import { Select, Space, Tag, Input, theme } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
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
}

const ellipsisStyle: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }

const LLMSelector: React.FC<LLMSelectorProps> = ({
  providerId,
  modelId,
  onProviderChange,
  onModelChange,
  style,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [customModel, setCustomModel] = useState(modelId || '')

  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [])

  const selectedProvider = providerId ? providers.find(p => p.id === providerId) : null
  const modelOptions = selectedProvider
    ? getProviderModels(selectedProvider)
    : []

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
    onProviderChange(value)
    onModelChange('')
    setCustomModel('')
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
      <RobotOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
      <Select
        size="small"
        placeholder={t('llmSelector.selectProvider')}
        style={{ minWidth: 100, maxWidth: selectMaxWidth }}
        value={providerId || undefined}
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
      {providerId && hasModelOptions && (
        <Select
          size="small"
          placeholder={t('llmSelector.selectModel')}
          style={{ minWidth: 90, maxWidth: selectMaxWidth }}
          value={modelId || undefined}
          onChange={handleModelSelect}
          optionLabelProp="label"
          options={modelOptions.map((opt) => ({
            value: opt.model,
            label: (
              <Space size={4}>
                <span style={ellipsisStyle}>{opt.name}</span>
                {opt.enable_thinking && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('llmSelector.thinking')}</Tag>}
              </Space>
            ),
          }))}
          allowClear
        />
      )}
      {providerId && !hasModelOptions && (
        <Input
          size="small"
          placeholder={selectedProvider?.model || t('llmSelector.inputModel')}
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
