import { useState, useEffect } from 'react'
import { Select, Space, Tag, theme } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
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
  const [providers, setProviders] = useState<LLMProvider[]>([])

  useEffect(() => {
    window.electronAPI.llm.getProviders().then((result: any) => {
      setProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [])

  const providerOptions = providers.map((p) => {
    const isDomestic = DOMESTIC_PROVIDERS.has(p.provider_type)
    const isLocal = LOCAL_PROVIDERS.has(p.provider_type)
    return {
      value: p.id,
      label: (
        <Space size={4}>
          {isDomestic && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>国产</Tag>}
          {isLocal && <Tag color="green" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>本地</Tag>}
          <span>{p.name}</span>
        </Space>
      ),
      searchLabel: `${p.name} ${p.model} ${p.provider_type}`,
    }
  })

  const modelOptions = providerId
    ? getProviderModels(providers.find(p => p.id === providerId)!).map((m) => ({
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
      <RobotOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
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
