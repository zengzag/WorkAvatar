import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Form,
  Input,
  Button,
  Space,
  Avatar,
  Badge,
  Empty,
  Typography,
  Alert,
  Modal,
  Popconfirm,
  theme,
} from 'antd'
import {
  ApiOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  LinkOutlined,
  DisconnectOutlined,
} from '@ant-design/icons'

const { TextArea } = Input
const { Text } = Typography

interface MCPServer {
  id: string
  name: string
  command: string
  status: string
  last_error?: string
}

interface MCPServersSectionProps {
  mcpServers: MCPServer[]
  isMcpModalOpen: boolean
  setIsMcpModalOpen: (open: boolean) => void
  mcpForm: ReturnType<typeof Form.useForm>[0]
  editingMcpServer: MCPServer | null
  setEditingMcpServer: (server: MCPServer | null) => void
  connectingMcp: string | null
  onCreateMCPServer: (values: any) => void
  onConnectMCPServer: (serverId: string) => void
  onDisconnectMCPServer: (serverId: string) => void
  onDeleteMCPServer: (serverId: string) => void
  onOpenMcpEditor: (server?: MCPServer) => void
}

const MCPServersSection: React.FC<MCPServersSectionProps> = ({
  mcpServers,
  isMcpModalOpen,
  setIsMcpModalOpen,
  mcpForm,
  editingMcpServer,
  setEditingMcpServer,
  connectingMcp,
  onCreateMCPServer,
  onConnectMCPServer,
  onDisconnectMCPServer,
  onDeleteMCPServer,
  onOpenMcpEditor,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <Alert
          title={t('employeeSettings.mcpAlertTitle')}
          description={t('employeeSettings.mcpAlertDesc')}
          type="info"
          showIcon
        />

        <Card
          title={
            <Space>
              <ApiOutlined />
              <span>{t('employeeSettings.mcpServerList', { count: mcpServers.length })}</span>
            </Space>
          }
          extra={
            <Button type="primary" icon={<PlusOutlined />} onClick={() => onOpenMcpEditor()}>
              {t('employeeSettings.addServer')}
            </Button>
          }
        >
          {mcpServers.length === 0 ? (
            <Empty description={t('employeeSettings.noMcpServers')} />
          ) : (
            <div>
              {mcpServers.map((server) => (
                <div
                  key={server.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    padding: '12px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                    <Avatar
                      style={{
                        backgroundColor:
                          server.status === 'connected'
                            ? token.colorSuccess
                            : server.status === 'error'
                            ? token.colorError
                            : token.colorBgContainer,
                        flexShrink: 0,
                      }}
                      icon={<ApiOutlined />}
                    />
                    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                      <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Text strong ellipsis style={{ display: 'inline-block' }}>{server.name}</Text>
                        <Badge
                          status={
                            server.status === 'connected'
                              ? 'success'
                              : server.status === 'error'
                              ? 'error'
                              : 'default'
                          }
                          text={
                            server.status === 'connected'
                              ? t('employeeSettings.connected')
                              : server.status === 'error'
                              ? t('employeeSettings.error')
                              : t('employeeSettings.notConnected')
                          }
                          style={{ flexShrink: 0 }}
                        />
                      </div>
                      <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t('employeeSettings.command')} {server.command}
                        </Text>
                        {server.last_error && (
                          <Text type="danger" style={{ fontSize: 12 }}>
                            {t('employeeSettings.errorLabel')} {server.last_error}
                          </Text>
                        )}
                      </Space>
                    </div>
                  </div>
                  <Space>
                    {server.status === 'connected' ? (
                      <Button
                        type="text"
                        icon={<DisconnectOutlined />}
                        onClick={() => onDisconnectMCPServer(server.id)}
                      >
                        {t('common.disconnect')}
                      </Button>
                    ) : (
                      <Button
                        type="primary"
                        icon={<LinkOutlined />}
                        loading={connectingMcp === server.id}
                        onClick={() => onConnectMCPServer(server.id)}
                      >
                        {t('common.connect')}
                      </Button>
                    )}
                    <Button type="text" icon={<EditOutlined />} onClick={() => onOpenMcpEditor(server)}>
                      {t('common.edit')}
                    </Button>
                    <Popconfirm
                      title={t('employeeSettings.confirmDeleteMcp')}
                      onConfirm={() => onDeleteMCPServer(server.id)}
                    >
                      <Button type="text" danger icon={<DeleteOutlined />}>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  </Space>
                </div>
              ))}
            </div>
          )}
        </Card>
      </Space>

      <Modal
        title={editingMcpServer ? t('employeeSettings.editMcp') : t('employeeSettings.addMcp')}
        open={isMcpModalOpen}
        onCancel={() => {
          setIsMcpModalOpen(false)
          setEditingMcpServer(null)
          mcpForm.resetFields()
        }}
        footer={null}
        width={560}
      >
        <Form form={mcpForm} layout="vertical" onFinish={onCreateMCPServer}>
          <Form.Item name="name" label={t('employeeSettings.serverName')} rules={[{ required: true, message: t('employeeSettings.enterServerName') }]}>
            <Input placeholder={t('employeeSettings.serverNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="command" label={t('employeeSettings.startCommand')} rules={[{ required: true, message: t('employeeSettings.enterCommand') }]}>
            <Input placeholder={t('employeeSettings.commandPlaceholder')} />
          </Form.Item>
          <Form.Item name="args" label={t('employeeSettings.args')}>
            <TextArea rows={3} placeholder="例如：-m&#10;mcp-server-filesystem&#10;/path/to/allowed/dir" />
          </Form.Item>
          <Form.Item name="env" label={t('employeeSettings.envVars')}>
            <TextArea rows={2} placeholder={`{"API_KEY": "xxx", "DEBUG": "true"}`} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit">
                {editingMcpServer ? t('employeeSettings.update') : t('common.create')}
              </Button>
              <Button onClick={() => setIsMcpModalOpen(false)}>{t('common.cancel')}</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export default MCPServersSection
