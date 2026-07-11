import { useTranslation } from 'react-i18next'
import { Checkbox, Typography } from 'antd'
import { ToolOutlined } from '@ant-design/icons'

interface ToolCheckboxesProps {
  tools: any[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

/** 内置工具多选列表 */
const ToolCheckboxes: React.FC<ToolCheckboxesProps> = ({ tools, selectedIds, onChange }) => {
  const { t } = useTranslation()

  return (
    <div>
      <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
        <ToolOutlined style={{ marginRight: 4 }} />
        {t('creationWizard.toolsHint')}
      </Typography.Text>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {tools.map((tool: any) => (
          <Checkbox
            key={tool.id}
            checked={selectedIds.includes(tool.id)}
            onChange={(e) => {
              if (e.target.checked) {
                onChange([...selectedIds, tool.id])
              } else {
                onChange(selectedIds.filter((id) => id !== tool.id))
              }
            }}
          >
            {tool.title || tool.name}
          </Checkbox>
        ))}
      </div>
    </div>
  )
}

export default ToolCheckboxes
