import { Card, Switch, Button, Typography, Tag, Space } from 'antd'

const { Text, Paragraph } = Typography

interface Tool {
  id: string
  name: string
  description: string
  source?: string
  type?: string
  is_enabled: boolean
}

interface ToolConfigPanelProps {
  assignedTools: Tool[]
  availableTools: Tool[]
  onToggle: (toolId: string, enabled: boolean) => void
  onRemove: (toolId: string) => void
  onAssign: (toolId: string) => void
}

export default function ToolConfigPanel({ assignedTools, availableTools, onToggle, onRemove, onAssign }: ToolConfigPanelProps) {
  return (
    <Card title={<Space><Text strong>已分配的工具 ({assignedTools.length})</Text></Space>}>
      {assignedTools.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <Text type="secondary">尚未分配任何工具</Text>
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            请从下方可用工具列表中选择并分配工具
          </Paragraph>
        </div>
      ) : (
        <div>
          {assignedTools.map((tool) => (
            <div
              key={tool.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: '1px solid #f0f0f0',
              }}
            >
              <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Text ellipsis style={{ display: 'inline-block' }}>{tool.name}</Text>
                  <Tag style={{ flexShrink: 0 }}>{tool.source || 'builtin'}</Tag>
                </div>
                <Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block' }}>{tool.description}</Text>
              </div>
              <Space>
                <Switch size="small" checked={tool.is_enabled} onChange={(v) => onToggle(tool.id, v)} />
                <Button size="small" danger onClick={() => onRemove(tool.id)}>移除</Button>
              </Space>
            </div>
          ))}
        </div>
      )}

      {availableTools.length > 0 && (
        <Card title={<Space><Text strong>可用工具 ({availableTools.length})</Text></Space>} type="inner" style={{ marginTop: 16 }}>
          <div>
            {availableTools.map((tool) => (
              <div
                key={tool.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: '1px solid #f0f0f0',
                }}
              >
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <Text ellipsis style={{ display: 'block' }}>{tool.name}</Text>
                  <Text type="secondary" ellipsis style={{ fontSize: 12, display: 'block' }}>{tool.description}</Text>
                </div>
                <Button size="small" type="primary" onClick={() => onAssign(tool.id)}>分配</Button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </Card>
  )
}