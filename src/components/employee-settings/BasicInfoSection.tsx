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
  Popconfirm,
  Typography,
  Row,
  Col,
} from 'antd'
import {
  SaveOutlined,
  UserOutlined,
  RobotOutlined,
  FileTextOutlined,
  SettingOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import type { LLMProvider } from '../../types'
import { getProviderModelOptions } from '../../utils/llm'

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
  formLlmProviderId: string
  setFormLlmProviderId: (value: string) => void
  providers: LLMProvider[]
  loading: boolean
  onSave: (values: any) => void
  onDelete: () => void
  projectId?: string
  projects?: any[]
  onProjectChange?: (projectId: string) => void
}

const BasicInfoSection: React.FC<BasicInfoSectionProps> = ({
  form,
  formLlmProviderId,
  setFormLlmProviderId,
  providers,
  loading,
  onSave,
  onDelete,
  projectId,
  projects,
  onProjectChange,
}) => {
  const { t } = useTranslation()

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

        <Form.Item label={t('employeeSettings.projectOptional')}>
          <Select
            value={projectId || undefined}
            placeholder={t('employeeSettings.selectProject')}
            allowClear
            onChange={onProjectChange}
          >
            <Select.Option value="">{t('employeeSettings.noProjectOption')}</Select.Option>
            {(projects || []).map((p: any) => (
              <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
            ))}
          </Select>
        </Form.Item>

        <Row gutter={24}>
          <Col span={12}>
            <Form.Item name="llm_provider_id" label={t('employeeSettings.llmProvider')}>
              <Select
                placeholder={t('employeeSettings.selectProvider')}
                allowClear
                onChange={(value) => {
                  setFormLlmProviderId(value || '')
                  form.setFieldValue('llm_model', undefined)
                }}
              >
                {providers.map((p) => (
                  <Select.Option key={p.id} value={p.id}>
                    {p.name} ({p.model})
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="llm_model" label={t('employeeSettings.modelName')}>
              {formLlmProviderId && getProviderModelOptions(providers.find(p => p.id === formLlmProviderId)!).length > 0 ? (
                <Select
                  placeholder={t('employeeSettings.selectModel')}
                  allowClear
                  options={getProviderModelOptions(providers.find(p => p.id === formLlmProviderId)!)}
                />
              ) : (
                <Input placeholder={t('employeeSettings.modelPlaceholder')} />
              )}
            </Form.Item>
          </Col>
        </Row>

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
            <Popconfirm
              title={t('employeeSettings.confirmDeleteEmployee')}
              description={t('employeeSettings.deleteEmployeeDesc')}
              onConfirm={onDelete}
              okText={t('common.delete')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />}>
                {t('employeeSettings.deleteEmployee')}
              </Button>
            </Popconfirm>
          </Space>
        </Form.Item>
      </Form>
    </Card>
  )
}

export default BasicInfoSection
