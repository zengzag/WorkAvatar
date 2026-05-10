import { useState, useEffect } from 'react'
import { Select, Space, Tag } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import type { LLMProvider, LLMModelConfig } from '../../types'

const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'moonshot', 'yi'])

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

  const providerOptions = providers.map((p) => {
    const isDomestic = DOMESTIC_PROVIDERS.has(p.provider_type)
    return {
      value: p.id,
      label: (
        <Space size={4}>
          {isDomestic && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>国产</Tag>}
          <span>{p.name}</span>
          <span style={{ color: '#999', fontSize: 11 }}>({p.model})</span>
        </Space>
      ),
      searchLabel: `${p.name} ${p.model} ${p.provider_type}`,
    }
  })

  const modelOptions = providerId
    ? getProviderModels(providerId).map((m) => ({
        value: m.model,
        label: (
          <Space size={4}>
            <span>{m.name}</span>
            {m.enable_thinking && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>思考</Tag>}
          </Space>
        ),
      }))
    : []

  const selectMaxWidth = 160

  return (
    <Space size={8} style={style}>
      <RobotOutlined style={{ color: '#1677ff', flexShrink: 0 }} />
      <Select
        size="small"
        placeholder="服务商"
        style={{ minWidth: 100, maxWidth: selectMaxWidth }}
        value={providerId || undefined}
        onChange={(value) => {
          onProviderChange(value)
          onModelChange('')
        }}
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
          }))}
          allowClear
        />
      )}
    </Space>
  )
}

export default LLMSelector
