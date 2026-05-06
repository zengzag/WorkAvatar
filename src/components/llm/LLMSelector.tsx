import { useState, useEffect } from 'react'
import { Select, Space } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { LLMProvider, LLMModelConfig } from '../../types'

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
  const [providers, setProviders] = useState<LLMProvider[]>([])

  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [])

  const getProviderModels = (pid: string): LLMModelConfig[] => {
    const provider = providers.find(p => p.id === pid)
    if (!provider?.models_json) return []
    try {
      return JSON.parse(provider.models_json)
    } catch {
      return []
    }
  }

  const providerOptions = providers.map((p) => ({
    value: p.id,
    label: `${p.name} (${p.model})`,
  }))

  const modelOptions = providerId
    ? getProviderModels(providerId).map((m) => ({
        value: m.model,
        label: m.name,
      }))
    : []

  const selectMaxWidth = 160

  return (
    <Space size={8} style={style}>
      <RobotOutlined style={{ color: '#1677ff', flexShrink: 0 }} />
      <Select
        size="small"
        placeholder="运营商"
        style={{ minWidth: 100, maxWidth: selectMaxWidth }}
        value={providerId || undefined}
        onChange={(value) => {
          onProviderChange(value)
          onModelChange('')
        }}
        optionLabelProp="label"
        options={providerOptions.map((opt) => ({
          value: opt.value,
          label: <span style={ellipsisStyle}>{opt.label}</span>,
          title: opt.label,
        }))}
        allowClear
      />
      {providerId && modelOptions.length > 0 && (
        <Select
          size="small"
          placeholder="模型"
          style={{ minWidth: 90, maxWidth: selectMaxWidth }}
          value={modelId || undefined}
          onChange={onModelChange}
          optionLabelProp="label"
          options={modelOptions.map((opt) => ({
            value: opt.value,
            label: <span style={ellipsisStyle}>{opt.label}</span>,
            title: opt.label,
          }))}
          allowClear
        />
      )}
    </Space>
  )
}

export default LLMSelector
