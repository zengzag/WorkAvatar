import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Form,
  Input,
  Button,
  Select,
  Space,
  Avatar,
  Divider,
  Row,
  Col,
  App,
  theme,
} from 'antd'
import {
  SaveOutlined,
  UserOutlined,
  RobotOutlined,
  FileTextOutlined,
  SettingOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
} from '@ant-design/icons'

const { TextArea } = Input

interface BasicInfoSectionProps {
  form: ReturnType<typeof Form.useForm>[0]
  loading: boolean
  onSave: (values: any) => void
  onDelete: (workspacePath?: string) => void
  workspacePath?: string
  employeeId: string
}

const BasicInfoSection: React.FC<BasicInfoSectionProps> = ({
  form,
  loading,
  onSave,
  onDelete,
  workspacePath,
  employeeId,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()

  // 头像样式配置，颜色使用主题语义 token 以适配明暗主题
  const avatarOptions = useMemo(() => [
    { value: 'default', icon: <RobotOutlined />, color: token.colorPrimary, label: t('employeeSettings.avatarDefault') },
    { value: 'business', icon: <UserOutlined />, color: token.colorSuccess, label: t('employeeSettings.avatarBusiness') },
    { value: 'document', icon: <FileTextOutlined />, color: token.colorWarning, label: t('employeeSettings.avatarDocument') },
    { value: 'settings', icon: <SettingOutlined />, color: token.colorInfo, label: t('employeeSettings.avatarSettings') },
  ], [token, t])

  const handleChangeWorkspacePath = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('employeeSettings.selectWorkspaceDir'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return

      await window.electronAPI.employee.update({
        id: employeeId,
        workspace_path: result.filePaths[0],
      })
      message.success(t('common.saveSuccess'))
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [t, employeeId, message])

  const handleOpenInExplorer = useCallback(async () => {
    if (!workspacePath) return
    try {
      await window.electronAPI.workspace.openInExplorer({ path: workspacePath })
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }, [workspacePath, message, t])

  return (
    <Card>
      <Form form={form} layout="vertical" onFinish={onSave}>
        <Row gutter={24}>
          <Col span={16}>
            <Form.Item
              name="name"
              label={t('employeeSettings.employeeName')}
              rules={[{ required: true, message: t('employeeSettings.enterName') }]}
            >
              <Input placeholder={t('employeeSettings.namePlaceholder')} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="avatar_type" label={t('employeeSettings.avatarStyle')}>
              <Select>
                {avatarOptions.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    <Space>
                      <Avatar size="small" style={{ backgroundColor: opt.color }}>
                        {opt.icon}
                      </Avatar>
                      {opt.label}
                    </Space>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="description" label={t('employeeSettings.descriptionLabel')}>
          <TextArea rows={3} placeholder={t('employeeSettings.descPlaceholder')} />
        </Form.Item>

        <Form.Item label={t('employeeSettings.workspacePath')}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={workspacePath || ''}
              readOnly
              placeholder={t('employeeSettings.workspacePathPlaceholder')}
            />
            <Button
              icon={<FolderOpenOutlined />}
              onClick={handleChangeWorkspacePath}
            >
              {t('employeeSettings.changeWorkspaceDir')}
            </Button>
            {workspacePath && (
              <Button
                icon={<FolderOpenOutlined />}
                onClick={handleOpenInExplorer}
              >
                {t('employeeSettings.openInExplorer')}
              </Button>
            )}
          </Space.Compact>
        </Form.Item>

        <Divider />

        <Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={loading}>
              {t('employeeSettings.saveBasic')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() => onDelete(workspacePath)}
            >
              {t('employeeSettings.deleteEmployee')}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  )
}

export default React.memo(BasicInfoSection)
