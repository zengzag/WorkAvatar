import { Col, Form, Select, Switch, Slider, Typography, Tooltip, InputNumber, Divider } from 'antd'
import { QuestionCircleOutlined, BulbOutlined } from '@ant-design/icons'
import type { LLMModelConfig } from '../../types'

const { Text } = Typography

interface LLMProvider {
  id: string
  name: string
  model: string
  provider_type: string
  models_json?: string
}

interface EmployeeLLMConfigProps {
  providers: LLMProvider[]
  selectedProviderId: string | null
  selectedModel: string
  temperature: number
  maxTokens: number
  reviewMode: boolean
  enableThinking: boolean
  onProviderChange: (id: string) => void
  onModelChange: (model: string) => void
  onTemperatureChange: (t: number) => void
  onMaxTokensChange: (t: number) => void
  onReviewModeChange: (v: boolean) => void
  onEnableThinkingChange: (v: boolean) => void
}

function getProviderModels(provider: LLMProvider): LLMModelConfig[] {
  if (!provider.models_json) return []
  try {
    return JSON.parse(provider.models_json)
  } catch {
    return []
  }
}

export default function EmployeeLLMConfig({
  providers, selectedProviderId, selectedModel, temperature, maxTokens, reviewMode, enableThinking,
  onProviderChange, onModelChange, onTemperatureChange, onMaxTokensChange, onReviewModeChange, onEnableThinkingChange,
}: EmployeeLLMConfigProps) {
  const selectedProvider = providers.find(p => p.id === selectedProviderId)
  const providerModels = selectedProvider ? getProviderModels(selectedProvider) : []
  const selectedModelConfig = providerModels.find(m => m.model === selectedModel)

  return (
    <>
      <Col span={12}>
        <Form.Item label="LLM 提供商">
          <Select value={selectedProviderId || undefined} onChange={onProviderChange}
            placeholder="选择 LLM 提供商" allowClear>
            {providers.map(p => <Select.Option key={p.id} value={p.id}>{p.name} ({p.provider_type})</Select.Option>)}
          </Select>
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item label="模型">
          <Select value={selectedModel || undefined} onChange={onModelChange}
            placeholder="输入或选择模型名" mode="tags" maxCount={1} tokenSeparators={[',']}>
            {providerModels.map(m => (
              <Select.Option key={m.model} value={m.model}>
                {m.name} {m.enable_thinking ? '🧠' : ''}
              </Select.Option>
            ))}
            {selectedProvider && !providerModels.length && (
              <Select.Option key={selectedProvider.model} value={selectedProvider.model}>{selectedProvider.model}</Select.Option>
            )}
          </Select>
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item label={
          <span>Temperature <Tooltip title="控制生成随机性，越高越有创意"><QuestionCircleOutlined /></Tooltip></span>
        }>
          <Slider min={0} max={2} step={0.1} value={temperature} onChange={onTemperatureChange}
            marks={{ 0: '0', 0.5: '0.5', 1: '1', 1.5: '1.5', 2: '2' }} />
        </Form.Item>
      </Col>
      <Col span={12}>
        <Form.Item label={"最大 Token 数"}>
          <Slider min={512} max={32768} step={512} value={maxTokens} onChange={onMaxTokensChange}
            marks={{ 512: '512', 4096: '4K', 8192: '8K', 16384: '16K', 32768: '32K' }} />
        </Form.Item>
      </Col>

      <Col span={24}>
        <Divider plain style={{ margin: '8px 0 16px' }}>
          <BulbOutlined /> 思考模式
        </Divider>
      </Col>
      <Col span={12}>
        <Form.Item label={
          <span>启用思考模式 <Tooltip title="开启后模型会先进行推理再回答，适用于复杂推理任务。需要模型支持（如 DeepSeek Reasoner、QwQ 等）"><QuestionCircleOutlined /></Tooltip></span>
        }>
          <Switch checked={enableThinking} onChange={onEnableThinkingChange} />
        </Form.Item>
      </Col>
      {enableThinking && selectedModelConfig?.thinking_budget && (
        <Col span={12}>
          <Form.Item label="思考预算">
            <InputNumber value={selectedModelConfig.thinking_budget} disabled style={{ width: '100%' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>由模型配置决定</Text>
          </Form.Item>
        </Col>
      )}

      <Col span={24}>
        <Form.Item label={"审核模式"}>
          <Switch checked={reviewMode} onChange={onReviewModeChange} />
          <Text type="secondary" style={{ marginLeft: 8 }}>开启后，员工执行工具需要人工确认</Text>
        </Form.Item>
      </Col>
    </>
  )
}
