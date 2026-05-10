import { Card, Button, Space, Typography, Tag } from 'antd'
import { DeleteOutlined, ApiOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface MCPServer {
  id: string
  name: string
  command: string
  args_json?: string
  env_json?: string
  status?: string
  is_enabled?: boolean
  last_error?: string
}

interface MCPServerPanelProps {
  servers: MCPServer[]
  onDelete: (id: string) => void
  onConnect: (id: string) => Promise<void>
  onDisconnect: (id: string) => Promise<void>
}

export default function MCPServerPanel({ servers, onDelete, onConnect, onDisconnect }: MCPServerPanelProps) {
  if (servers.length === 0) {
    return <Card><div style={{ textAlign: 'center', padding: 40 }}>暂无 MCP 服务器</div></Card>
  }

  return (
    <div>
      {servers.map((server) => (
        <div
          key={server.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '12px 0',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: server.status === 'connected' ? '#e6f7ff' : '#f5f5f5',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <ApiOutlined style={{ fontSize: 20, color: server.status === 'connected' ? '#52c41a' : '#999' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Text strong ellipsis style={{ display: 'inline-block' }}>{server.name}</Text>
                <Tag color={server.status === 'connected' ? 'success' : server.status === 'error' ? 'error' : 'default'} style={{ flexShrink: 0 }}>
                  {server.status || '未连接'}
                </Tag>
              </div>
              <div>
                <Text code ellipsis style={{ display: 'block' }}>{server.command} {(server.args_json ? JSON.parse(server.args_json) : []).join(' ')}</Text>
                {server.last_error && <Paragraph type="danger" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>{server.last_error}</Paragraph>}
              </div>
            </div>
          </div>
          <Space>
            {server.status === 'connected'
              ? <Button size="small" danger icon={<PauseCircleOutlined />} onClick={() => onDisconnect(server.id)}>断开</Button>
              : <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => onConnect(server.id)}>连接</Button>}
            <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(server.id)} />
          </Space>
        </div>
      ))}
    </div>
  )
}