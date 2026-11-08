import { useTranslation } from 'react-i18next'
import { Collapse, Input, Space, Typography } from 'antd'
import { ToolOutlined, UserOutlined } from '@ant-design/icons'
import ToolCheckboxes, { type ToolCategoryDef } from './ToolCheckboxes'

const { Text } = Typography
const { TextArea } = Input

interface ProfileEditorProps {
  name: string
  onNameChange: (value: string) => void
  description: string
  onDescriptionChange: (value: string) => void
  rules: string
  onRulesChange: (value: string) => void
  builtinTools: any[]
  toolCategories: ToolCategoryDef[]
  selectedToolIds: string[]
  onToolIdsChange: (ids: string[]) => void
  disabled?: boolean
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 6,
}

/** 员工方案编辑器：名称 / 简介 / 系统提示词 / 可用工具 */
const ProfileEditor: React.FC<ProfileEditorProps> = ({
  name,
  onNameChange,
  description,
  onDescriptionChange,
  rules,
  onRulesChange,
  builtinTools,
  toolCategories,
  selectedToolIds,
  onToolIdsChange,
  disabled,
}) => {
  const { t } = useTranslation()

  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <div style={labelStyle}>
          <Text strong>{t('creationWizard.employeeNameLabel')}</Text>
          <Text type="danger">*</Text>
        </div>
        <Input
          prefix={<UserOutlined />}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('creationWizard.employeeNamePlaceholder')}
          disabled={disabled}
          data-testid="wizard-employee-name"
        />
      </div>

      <div>
        <div style={labelStyle}>
          <Text strong>{t('creationWizard.descriptionFieldLabel')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('creationWizard.descriptionFieldHint')}
          </Text>
        </div>
        <TextArea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t('creationWizard.descriptionFieldPlaceholder')}
          rows={3}
          maxLength={150}
          showCount
          disabled={disabled}
        />
      </div>

      <div>
        <div style={labelStyle}>
          <Text strong>{t('creationWizard.rulesFieldLabel')}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('creationWizard.rulesFieldHint')}
          </Text>
        </div>
        <TextArea
          value={rules}
          onChange={(e) => onRulesChange(e.target.value)}
          placeholder={t('creationWizard.rulesFieldPlaceholder')}
          rows={8}
          disabled={disabled}
          data-testid="wizard-rules"
        />
      </div>

      <Collapse
        items={[
          {
            key: 'tools',
            label: (
              <span>
                <ToolOutlined style={{ marginRight: 6 }} />
                {t('creationWizard.toolSettings')}
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  {t('creationWizard.toolsSelected', { count: selectedToolIds.length })}
                </Text>
              </span>
            ),
            children: (
              <ToolCheckboxes
                tools={builtinTools}
                categories={toolCategories}
                selectedIds={selectedToolIds}
                onChange={onToolIdsChange}
              />
            ),
          },
        ]}
      />
    </Space>
  )
}

export default ProfileEditor
