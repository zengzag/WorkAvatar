import { useState, useEffect, useMemo } from 'react'
import { Select, Space, Tag, Input, theme } from 'antd'
import { RobotOutlined, CloudServerOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

/**
 * LLMSelector 插件内复刻版（宿主 src/components/llm/LLMSelector.tsx）。
 * 不在插件渲染端 import 宿主源码：类型/工具函数本地内联，
 * provider 列表经宿主运行时全局 window.electronAPI.llm.getProviders() 获取。
 */

type LLMProviderType =
  | 'openai' | 'openai-compatible' | 'lmstudio' | 'deepseek' | 'qwen' | 'zhipu' | 'volcengine'
  | 'xiaomi' | 'moonshot' | 'yi' | 'groq' | 'mistral' | 'azure' | 'vertex' | 'bedrock' | 'xai'

interface LLMModelConfig {
  id: string
  name: string
  model: string
  category?: 'chat' | 'embedding'
  [key: string]: unknown
}

interface LLMProvider {
  id: string
  name: string
  provider_type: LLMProviderType
  model: string
  embedding_model: string
  models_json?: string
  [key: string]: unknown
}

const DOMESTIC_PROVIDERS = new Set(['deepseek', 'qwen', 'zhipu', 'volcengine', 'xiaomi', 'moonshot', 'yi'])
const LOCAL_PROVIDERS = new Set(['lmstudio', 'openai-compatible'])

function getProviderModels(provider: { models_json?: string }): LLMModelConfig[] {
  if (!provider?.models_json) return []
  try {
    return JSON.parse(provider.models_json).map((m: any) => ({
      ...m,
      category: m.category || 'chat',
    }))
  } catch {
    return []
  }
}

const SEP = '::'

function parseCompositeValue(value: string): { providerId: string; modelId: string } {
  const i = value.indexOf(SEP)
  if (i < 0) return { providerId: value, modelId: '' }
  return { providerId: value.substring(0, i), modelId: value.substring(i + SEP.length) }
}

interface LLMSelectorProps {
  providerId?: string
  modelId?: string
  onChange: (providerId: string, modelId: string) => void
  style?: React.CSSProperties
  modelCategory?: 'chat' | 'embedding'
  providers?: LLMProvider[]
}

const ellipsisStyle: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }

const LLMSelector: React.FC<LLMSelectorProps> = ({
  providerId,
  modelId,
  onChange,
  style,
  modelCategory,
  providers: externalProviders,
}) => {
  const { token } = theme.useToken()
  const { t } = useTranslation('voice')
  const [internalProviders, setInternalProviders] = useState<LLMProvider[]>([])
  const [customModel, setCustomModel] = useState(modelId || '')

  const providers = externalProviders ?? internalProviders

  useEffect(() => {
    if (externalProviders) return
    ;(window as any).electronAPI?.llm?.getProviders?.().then((result: any) => {
      setInternalProviders(result as LLMProvider[])
    }).catch(() => {})
  }, [externalProviders])

  useEffect(() => {
    setCustomModel(modelId || '')
  }, [modelId])

  const { selectOptions, needsCustomInput } = useMemo(() => {
    const groups: Array<{
      label: React.ReactNode
      options: Array<{ value: string; label: React.ReactNode; searchLabel: string }>
    }> = []
    let customInputNeeded = false

    for (const provider of providers) {
      const models = getProviderModels(provider)
      const filteredModels = modelCategory
        ? models.filter(m => (m.category || 'chat') === modelCategory)
        : models

      const isDomestic = DOMESTIC_PROVIDERS.has(provider.provider_type)
      const isLocal = LOCAL_PROVIDERS.has(provider.provider_type)

      const groupLabel = (
        <Space size={4}>
          {isDomestic && <Tag color="red" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('llmSelector.domestic')}</Tag>}
          {isLocal && <Tag color="green" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('llmSelector.local')}</Tag>}
          <span>{provider.name}</span>
        </Space>
      )

      const groupOptions: Array<{ value: string; label: React.ReactNode; searchLabel: string }> = []

      if (filteredModels.length > 0) {
        for (const model of filteredModels) {
          groupOptions.push({
            value: `${provider.id}${SEP}${model.model}`,
            label: <span style={ellipsisStyle}>{model.name}</span>,
            searchLabel: `${provider.name} ${model.name} ${model.model}`,
          })
        }
      } else {
        const defaultModel = modelCategory === 'embedding' ? provider.embedding_model : provider.model
        if (defaultModel) {
          groupOptions.push({
            value: `${provider.id}${SEP}${defaultModel}`,
            label: <span style={ellipsisStyle}>{defaultModel}</span>,
            searchLabel: `${provider.name} ${defaultModel}`,
          })
        }
        if (providerId === provider.id) {
          customInputNeeded = true
        }
      }

      if (groupOptions.length > 0) {
        groups.push({ label: groupLabel, options: groupOptions })
      }
    }

    const currentComposite = providerId && modelId ? `${providerId}${SEP}${modelId}` : ''
    if (currentComposite) {
      let matched = false
      for (const g of groups) {
        if (g.options.some(o => o.value === currentComposite)) {
          matched = true
          break
        }
      }
      if (!matched) {
        const provider = providers.find(p => p.id === providerId)
        if (provider) {
          const existingGroup = groups.find(g =>
            g.options.some(o => o.value.startsWith(`${providerId}${SEP}`))
          )
          const customOption = {
            value: currentComposite,
            label: <span style={ellipsisStyle}>{modelId}</span>,
            searchLabel: `${provider.name} ${modelId}`,
          }
          if (existingGroup) {
            existingGroup.options.push(customOption)
          } else {
            groups.push({
              label: <span>{provider.name}</span>,
              options: [customOption],
            })
          }
        }
      }
    }

    return { selectOptions: groups, needsCustomInput: customInputNeeded }
  }, [providers, modelCategory, t, providerId, modelId])

  const currentValue = providerId && modelId ? `${providerId}${SEP}${modelId}` : undefined

  const handleSelectChange = (value: string | undefined) => {
    if (!value) {
      handleClear()
      return
    }
    const { providerId: pId, modelId: mId } = parseCompositeValue(value)
    onChange(pId, mId)
    setCustomModel(mId)
  }

  const handleClear = () => {
    onChange('', '')
    setCustomModel('')
  }

  const handleCustomModelConfirm = () => {
    if (customModel.trim() && providerId) {
      onChange(providerId, customModel.trim())
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
        placeholder={t('llmSelector.selectModel')}
        style={{ minWidth: 107, maxWidth: 187 }}
        value={currentValue}
        onChange={handleSelectChange}
        showSearch
        filterOption={(input, option) =>
          ((option as any)?.searchLabel || '').toLowerCase().includes(input.toLowerCase())
        }
        options={selectOptions}
        optionLabelProp="label"
        allowClear
        onClear={handleClear}
      />
      {needsCustomInput && (
        <Input
          size="small"
          placeholder={modelCategory === 'embedding'
            ? (providers.find(p => p.id === providerId)?.embedding_model || t('llmSelector.inputModel'))
            : (providers.find(p => p.id === providerId)?.model || t('llmSelector.inputModel'))}
          value={customModel}
          onChange={e => setCustomModel(e.target.value)}
          onPressEnter={handleCustomModelConfirm}
          onBlur={handleCustomModelConfirm}
          style={{ minWidth: 60, maxWidth: 107 }}
        />
      )}
    </Space>
  )
}

export default LLMSelector
