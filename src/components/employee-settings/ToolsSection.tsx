import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Switch,
  Space,
  Avatar,
  Tag,
  Empty,
  Typography,
  Alert,
  theme,
} from 'antd'
import { ToolOutlined, ClockCircleOutlined, CalculatorOutlined } from '@ant-design/icons'

const { Text } = Typography

interface ToolInfo {
  id: string
  name: string
  title: string
  description: string
  category: string
  is_enabled: boolean
  is_assigned: boolean
}

const TOOL_ICON_MAP: Record<string, React.ReactNode> = {
  calculator: <CalculatorOutlined />,
  date_time: <ClockCircleOutlined />,
}

interface ToolsSectionProps {
  employeeTools: ToolInfo[]
  onToggleTool: (toolId: string, enabled: boolean) => void
}

const ToolsSection: React.FC<ToolsSectionProps> = ({ employeeTools, onToggleTool }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // 包装 props 传入的回调，保证稳定引用（Switch 内部 onChange 仍依赖 tool.id 在 map 闭包中）
  const handleToggle = useCallback((toolId: string, enabled: boolean) => {
    onToggleTool(toolId, enabled)
  }, [onToggleTool])

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      <Alert
        title={t('employeeSettings.toolsAlertTitle')}
        description={t('employeeSettings.toolsAlertDesc')}
        type="info"
        showIcon
      />

      <Card
        title={
          <Space>
            <ToolOutlined />
            <span>{t('employeeSettings.builtinTools', { count: employeeTools.length })}</span>
          </Space>
        }
      >
        {employeeTools.length === 0 ? (
          <Empty description={t('employeeSettings.noBuiltinTools')} />
        ) : (
          <div>
            {employeeTools.map((tool) => (
              <div
                key={tool.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                  <Avatar
                    style={{ backgroundColor: tool.is_enabled ? token.colorPrimary : token.colorBgContainer, flexShrink: 0 }}
                    icon={TOOL_ICON_MAP[tool.name] || <ToolOutlined />}
                  />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{tool.title || tool.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>{t('employeeSettings.builtin')}</Tag>
                    </div>
                    <Text type="secondary" ellipsis style={{ display: 'block' }}>{tool.description || t('employeeSettings.noDesc')}</Text>
                  </div>
                </div>
                <Switch
                  checked={tool.is_enabled}
                  onChange={(checked) => handleToggle(tool.id, checked)}
                  checkedChildren={t('common.enable')}
                  unCheckedChildren={t('common.disable')}
                />
              </div>
            ))}
          </div>
        )}
      </Card>
    </Space>
  )
}

export default React.memo(ToolsSection)
