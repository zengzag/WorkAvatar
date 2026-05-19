import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Form,
  Input,
  Button,
  Select,
  Switch,
  Space,
  Avatar,
  Divider,
  Typography,
  Row,
  Col,
  App,
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
import LLMSelector from '../llm/LLMSelector'
import type { LLMProvider } from '../../types'

const { TextArea } = Input
const { Text } = Typography

const AVATAR_OPTIONS = [
  { value: 'default', icon: <RobotOutlined />, color: '#1677ff' },
  { value: 'business', icon: <UserOutlined />, color: '#52c41a' },
  { value: 'document', icon: <FileTextOutlined />, color: '#faad14' },
  { value: 'settings', icon: <SettingOutlined />, color: '#722ed1' },
]

interface BasicInfoSectionProps {
  form: ReturnType<typeof Form.useForm>[0]
  providers: LLMProvider[]
  loading: boolean
  onSave: (values: any) => void
  onDelete: (workspacePath?: string) => void
  workspacePath?: string
  employeeId: string
}

const BasicInfoSection: React.FC<BasicInfoSectionProps> = ({
  form,
  providers,
  loading,
  onSave,
  onDelete,
  workspacePath,
  employeeId,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()

  const handleChangeWorkspacePath = async () => {
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
  }

  const handleOpenInExplorer = async () => {
    if (!workspacePath) return
    try {
      await window.electronAPI.workspace.openInExplorer({ path: workspacePath })
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }

  const handleLlmChange = (providerId: string, modelId: string) => {
    form.setFieldsValue({ llm_provider_id: providerId, llm_model: modelId })
  }

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
                {AVATAR_OPTIONS.map((opt) => (
                  <Select.Option key={opt.value} value={opt.value}>
                    <Space>
                      <Avatar size="small" style={{ backgroundColor: opt.color }}>
                        {opt.icon}
                      </Avatar>
                      {opt.value === 'default' && t('employeeSettings.avatarDefault')}
                      {opt.value === 'business' && t('employeeSettings.avatarBusiness')}
                      {opt.value === 'document' && t('employeeSettings.avatarDocument')}
                      {opt.value === 'settings' && t('employeeSettings.avatarSettings')}
                    </Space>
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
        </Row>

        <Form.Item name="description" label={t('common.description')}>
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

        <Form.Item label={t('employeeSettings.llmModel')}>
          <Form.Item name="llm_provider_id" hidden><Input /></Form.Item>
          <Form.Item name="llm_model" hidden><Input /></Form.Item>
          <LLMSelector
            providerId={form.getFieldValue('llm_provider_id') || ''}
            modelId={form.getFieldValue('llm_model') || ''}
            onChange={handleLlmChange}
            providers={providers}
          />
        </Form.Item>

        <Form.Item name="review_mode" valuePropName="checked" label={null}>
          <Switch checkedChildren={t('common.on')} unCheckedChildren={t('common.off')} />
        </Form.Item>
        <Text type="secondary">{t('employeeSettings.manualReviewDesc')}</Text>

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

export default BasicInfoSection
