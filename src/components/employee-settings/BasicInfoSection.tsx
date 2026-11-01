import React, { useCallback, useMemo, useRef, useState } from 'react'
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
  Tooltip,
} from 'antd'
import {
  SaveOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import EmployeeAvatar, {
  EMPLOYEE_AVATAR_ICONS,
  AVATAR_COLOR_PRESETS,
  renderEmployeeAvatarIcon,
} from '../common/EmployeeAvatar'

const { TextArea } = Input

/** 头像目标边长（px）：居中裁切正方形后缩放 */
const AVATAR_EDGE = 256
/** 头像 data URL 字符上限：超限时降分辨率重编码，避免大图拖慢列表渲染与导出 */
const AVATAR_MAX_DATA_URL_LENGTH = 400 * 1024

/** 居中裁切为正方形并绘制到指定边长 */
const drawAvatarCanvas = (bitmap: ImageBitmap, edge: number): HTMLCanvasElement => {
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = edge
  canvas.height = edge
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    edge,
    edge,
  )
  return canvas
}

/** WebP 体积远小于 PNG 且保留透明底；环境不支持时回退 PNG */
const encodeAvatar = (canvas: HTMLCanvasElement, quality: number): string => {
  const webp = canvas.toDataURL('image/webp', quality)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
}

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
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 头像图片压缩：居中裁切为正方形并缩放到 256px；超限时逐级降分辨率，保证入库体积可控 */
  const handlePickImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error(t('employeeSettings.avatarImageInvalid'))
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      message.error(t('employeeSettings.avatarImageTooLarge'))
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      let dataUrl = ''
      try {
        for (const edge of [AVATAR_EDGE, 192, 128]) {
          dataUrl = encodeAvatar(drawAvatarCanvas(bitmap, edge), 0.85)
          if (dataUrl.length <= AVATAR_MAX_DATA_URL_LENGTH) break
        }
      } finally {
        bitmap.close?.()
      }
      form.setFieldValue('avatar_image', dataUrl)
    } catch {
      message.error(t('employeeSettings.avatarImageFailed'))
    }
  }, [form, message, t])

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

  // 实时预览：跟随表单里的图标 / 颜色 / 上传图片
  const avatarIcon = Form.useWatch('avatar_icon', form) as string | undefined
  const avatarColor = Form.useWatch('avatar_color', form) as string | undefined
  const avatarImage = Form.useWatch('avatar_image', form) as string | undefined

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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <EmployeeAvatar
                    avatarIcon={avatarIcon}
                    avatarColor={avatarColor}
                    avatarImage={avatarImage}
                    size={32}
                    shape="square"
                  />
                  {!readonly && avatarImage && (
                    <Tooltip title={t('employeeSettings.avatarRemove')}>
                      <button
                        type="button"
                        onClick={() => form.setFieldValue('avatar_image', '')}
                        style={{
                          position: 'absolute',
                          top: -5,
                          right: -5,
                          width: 16,
                          height: 16,
                          padding: 0,
                          borderRadius: '50%',
                          border: `1px solid ${token.colorBorderSecondary}`,
                          background: token.colorBgContainer,
                          color: token.colorTextSecondary,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                      >
                        <CloseOutlined style={{ fontSize: 9 }} />
                      </button>
                    </Tooltip>
                  )}
                </div>
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
                {!readonly && (
                  <>
                    <Form.Item name="avatar_image" noStyle>
                      <input type="hidden" />
                    </Form.Item>
                    <Button
                      type="link"
                      style={{
                        padding: 0,
                        height: 'auto',
                        marginLeft: 'auto',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {avatarImage
                        ? t('employeeSettings.avatarReplace')
                        : t('employeeSettings.avatarUpload')}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (file) handlePickImage(file)
                      }}
                    />
                  </>
                )}
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
