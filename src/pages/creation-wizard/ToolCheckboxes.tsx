import { useTranslation } from 'react-i18next'
import { Checkbox, Typography, Space, Tag, theme } from 'antd'
import {
  FileOutlined,
  DatabaseOutlined,
  CalendarOutlined,
  RobotOutlined,
  GlobalOutlined,
  MessageOutlined,
  BulbOutlined,
  ToolOutlined,
  CodeOutlined,
  AppstoreOutlined,
  TeamOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface ToolItem {
  id: string
  name: string
  title?: string
  description?: string
}

/** 工具分类（来自后端，含插件分类） */
export interface ToolCategoryDef {
  id: string
  title: string
  icon: string
  is_plugin?: boolean
  plugin_id?: string
  tool_ids: string[]
}

interface ToolCheckboxesProps {
  tools: ToolItem[]
  categories: ToolCategoryDef[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

const CATEGORY_ICON_MAP: Record<string, React.ReactNode> = {
  file: <FileOutlined />,
  database: <DatabaseOutlined />,
  calendar: <CalendarOutlined />,
  robot: <RobotOutlined />,
  global: <GlobalOutlined />,
  message: <MessageOutlined />,
  tool: <BulbOutlined />,
  code: <CodeOutlined />,
  plugin: <AppstoreOutlined />,
  team: <TeamOutlined />,
}

/** 将工具名/标题映射为更简短的中文标签 */
function toolShortLabel(tool: ToolItem, t: any): string {
  const i18nKey = `workbench.toolNames.${tool.name}` as any
  const translated = t(i18nKey, { defaultValue: '' })
  if (translated) return translated
  return tool.title || tool.name
}

/** 工具多选列表（按分类分组，分类来自后端含插件分类） */
const ToolCheckboxes: React.FC<ToolCheckboxesProps> = ({ tools, categories, selectedIds, onChange }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const selectedSet = new Set(selectedIds)

  const handleCategoryToggle = (catToolIds: string[], checked: boolean) => {
    if (checked) {
      const merged = Array.from(new Set([...selectedIds, ...catToolIds]))
      // 只保留 tools 中实际存在的工具
      const validIds = new Set(tools.map(tl => tl.id))
      onChange(merged.filter(id => validIds.has(id)))
    } else {
      const removeSet = new Set(catToolIds)
      onChange(selectedIds.filter(id => !removeSet.has(id)))
    }
  }

  const handleSingleToolToggle = (toolId: string, checked: boolean) => {
    if (checked) {
      onChange([...selectedIds, toolId])
    } else {
      onChange(selectedIds.filter(id => id !== toolId))
    }
  }

  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        <ToolOutlined style={{ marginRight: 4 }} />
        {t('creationWizard.toolsHint')}
      </Text>

      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        {categories.map((cat) => {
          // 从传入 tools 中找出属于该分类的工具（保证 UI 不展示不存在的工具）
          const catTools = tools.filter(tl => cat.tool_ids.includes(tl.id))
          if (catTools.length === 0) return null

          const catToolIds = catTools.map(tl => tl.id)
          const enabledCount = catToolIds.filter(id => selectedSet.has(id)).length
          const total = catToolIds.length
          const allChecked = enabledCount === total
          const someChecked = enabledCount > 0 && !allChecked

          return (
            <div
              key={cat.id}
              style={{
                padding: '10px 12px',
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: token.borderRadius,
                background: token.colorFillQuaternary,
              }}
            >
              {/* 分类头部：图标 + 名称/数量 tag + 分类全选 checkbox */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                  <span style={{ color: token.colorPrimary }}>{CATEGORY_ICON_MAP[cat.icon] || <AppstoreOutlined />}</span>
                  <Text strong ellipsis style={{ fontSize: 13 }}>
                    {cat.is_plugin
                      ? t(cat.title, { ns: cat.plugin_id, defaultValue: cat.title })
                      : t(`employeeSettings.toolCategory_${cat.id}`, { defaultValue: cat.title })}
                  </Text>
                  {cat.is_plugin && (
                    <Tag color="purple" style={{ fontSize: 11, padding: '0 6px', marginInlineEnd: 0 }}>
                      {t('employeeSettings.plugin')}
                    </Tag>
                  )}
                  <Tag
                    color={
                      allChecked ? 'green' : someChecked ? 'orange' : 'default'
                    }
                    style={{ fontSize: 11, padding: '0 6px', marginInlineEnd: 0 }}
                  >
                    {enabledCount}/{total}
                  </Tag>
                </div>
                <Checkbox
                  indeterminate={someChecked}
                  checked={allChecked}
                  onChange={(e) => handleCategoryToggle(catToolIds, e.target.checked)}
                  style={{ marginInlineEnd: 0 }}
                />
              </div>

              {/* 分类下的工具复选框列表 */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px 14px',
                  marginLeft: 24,
                  paddingTop: 2,
                }}
              >
                {catTools.map((tool) => (
                  <Checkbox
                    key={tool.id}
                    checked={selectedSet.has(tool.id)}
                    onChange={(e) => handleSingleToolToggle(tool.id, e.target.checked)}
                    style={{ marginInlineEnd: 0 }}
                  >
                    <span style={{ fontSize: 13 }}>
                      {toolShortLabel(tool, t)}
                    </span>
                  </Checkbox>
                ))}
              </div>
            </div>
          )
        })}
      </Space>
    </div>
  )
}

export default ToolCheckboxes
