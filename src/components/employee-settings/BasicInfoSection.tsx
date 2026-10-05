import React, { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Form,
  Input,
  Button,
  Select,
  Space,
  Row,
  Col,
  App,
  theme,
  ColorPicker,
} from 'antd'
import {
  SaveOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import EmployeeAvatar, {
  EMPLOYEE_AVATAR_ICONS,
  AVATAR_COLOR_PRESETS,
  renderEmployeeAvatarIcon,
} from '../common/EmployeeAvatar'

const { TextArea } = Input

interface BasicInfoSectionProps {
  form: ReturnType<typeof Form.useForm>[0]
  loading: boolean
  onSave: (values: any) => void
  onDelete: (workspacePath?: string) => void
  workspacePath?: string
  employeeId: string
  /** 只读模式（注册员工）：表单禁用、隐藏保存/删除/生成等操作 */
  readonly?: boolean
}

const BasicInfoSection: React.FC<BasicInfoSectionProps> = ({
  form,
  loading,
  onSave,
  onDelete,
  workspacePath,
  employeeId,
  readonly,
}) => {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const [generating, setGenerating] = useState(false)

  // 头像图标选项（预览统一走 EmployeeAvatar，保证与实际渲染一致）
  const iconOptions = useMemo(() => EMPLOYEE_AVATAR_ICONS.map((key) => ({
    value: key,
    label: (
      <Space size={6}>
        {renderEmployeeAvatarIcon(key, 14)}
        {t(`employeeSettings.avatarIcon_${key}`)}
      </Space>
    ),
  })), [t])

  // 实时预览：跟随表单里的图标 / 颜色
  const avatarIcon = Form.useWatch('avatar_icon', form) as string | undefined
  const avatarColor = Form.useWatch('avatar_color', form) as string | undefined

  /** 用 LLM 根据名称、规则、工具与技能生成简短描述，填入表单（未保存的表单值优先） */
  const handleGenerateDescription = useCallback(async () => {
    if (!employeeId || generating) return
    setGenerating(true)
    try {
      const { name, rules } = form.getFieldsValue() as { name?: string; rules?: string }
      const result = await window.electronAPI.employee.generateDescription({
        employee_id: employeeId,
        name,
        rules,
      })
      if (result?.success && result.description) {
        form.setFieldValue('description', result.description)
        message.success(t('employeeSettings.generateDescSuccess'))
      } else if (result?.error === 'NO_LLM_PROVIDER') {
        message.warning(t('employeeSettings.noProviderForGenerate'))
      } else {
        message.error(result?.error || t('employeeSettings.generateDescFailed'))
      }
    } catch {
      message.error(t('employeeSettings.generateDescFailed'))
    } finally {
      setGenerating(false)
    }
  }, [employeeId, form, generating, message, t])

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
        <Row gutter={20}>
          <Col span={10}>
            <Form.Item
              name="name"
              label={t('employeeSettings.employeeName')}
              rules={[{ required: true, message: t('employeeSettings.enterName') }]}
            >
              <Input placeholder={t('employeeSettings.namePlaceholder')} disabled={readonly} />
            </Form.Item>
          </Col>
          <Col span={14}>
            <Form.Item label={t('employeeSettings.avatarStyle')}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <EmployeeAvatar avatarIcon={avatarIcon} avatarColor={avatarColor} size={32} shape="square" />
                <div style={{ width: 1, height: 24, background: token.colorBorderSecondary }} />
                <Form.Item name="avatar_icon" noStyle>
                  <Select disabled={readonly} style={{ width: 116 }} options={iconOptions} />
                </Form.Item>
                <span style={{ fontSize: 12, color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>
                  {t('employeeSettings.avatarColor')}
                </span>
                <Form.Item
                  name="avatar_color"
                  noStyle
                  getValueFromEvent={(color: any) => (typeof color === 'string' ? color : color?.toHexString?.() ?? color)}
                >
                  <ColorPicker
                    disabled={readonly}
                    format="hex"
                    style={{ width: 40, height: 32, borderRadius: 6 }}
                    presets={[{ label: t('employeeSettings.avatarColorPresets'), colors: AVATAR_COLOR_PRESETS }]}
                  />
                </Form.Item>
              </div>
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="description"
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {t('employeeSettings.descriptionLabel')}
              {!readonly && (
                <Button
                  type="link"
                  size="small"
                  htmlType="button"
                  icon={<ThunderboltOutlined />}
                  loading={generating}
                  onClick={handleGenerateDescription}
                  style={{ padding: 0, height: 'auto' }}
                >
                  {t('employeeSettings.autoGenerate')}
                </Button>
              )}
            </span>
          }
        >
          <TextArea rows={3} placeholder={t('employeeSettings.descPlaceholder')} disabled={readonly} />
        </Form.Item>

        <Form.Item name="rules" label={t('employeeSettings.rulesLabel')}>
          <TextArea rows={8} placeholder={t('employeeSettings.rulesPlaceholder')} disabled={readonly} />
        </Form.Item>

        <Form.Item label={t('employeeSettings.workspacePath')}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={workspacePath || ''}
              readOnly
              placeholder={t('employeeSettings.workspacePathPlaceholder')}
            />
            {!readonly && (
              <>
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
              </>
            )}
          </Space.Compact>
        </Form.Item>

        {!readonly && (
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
        )}
      </Form>
    </Card>
  )
}

export default React.memo(BasicInfoSection)
