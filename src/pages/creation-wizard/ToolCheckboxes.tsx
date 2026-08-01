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
} from '@ant-design/icons'

const { Text } = Typography

interface ToolItem {
  id: string
  name: string
  title?: string
  description?: string
}

interface ToolCheckboxesProps {
  tools: ToolItem[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
}

/** 工具分类定义（与后端 TOOL_CATEGORY_DEFS 对齐） */
const TOOL_CATEGORIES: Array<{
  id: string
  icon: React.ReactNode
  toolIds: string[]
}> = [
  {
    id: 'file_operations',
    icon: <FileOutlined />,
    toolIds: [
      'file_read', 'file_write', 'file_edit',
      'file_mkdir', 'file_list', 'file_search',
      'file_delete', 'file_move', 'file_copy',
      'file_rename', 'file_stat',
    ],
  },
  {
    id: 'kms',
    icon: <DatabaseOutlined />,
    toolIds: [
      'kms_search', 'kms_get_content', 'kms_knowledge_card',
      'kms_list_collections', 'kms_collection_overview',
      'kms_get_toc', 'kms_get_paragraphs',
    ],
  },
  {
    id: 'calendar',
    icon: <CalendarOutlined />,
    toolIds: [
      'calendar_event_list', 'calendar_event_create', 'calendar_event_update', 'calendar_event_delete',
      'calendar_todo_list', 'calendar_todo_create', 'calendar_todo_update',
      'calendar_todo_delete', 'calendar_todo_complete', 'calendar_todo_stats',
    ],
  },
  {
    id: 'automation',
    icon: <RobotOutlined />,
    toolIds: [
      'automation_list_employees', 'automation_list_providers',
      'automation_task_list', 'automation_task_create', 'automation_task_update',
      'automation_task_delete', 'automation_task_toggle',
      'automation_task_run_now', 'automation_task_preview', 'automation_run_list',
    ],
  },
  {
    id: 'web',
    icon: <GlobalOutlined />,
    toolIds: ['web_search', 'web_fetch'],
  },
  {
    id: 'scripting',
    icon: <CodeOutlined />,
    toolIds: ['shell_exec', 'javascript_exec'],
  },
  {
    id: 'conversation_memory',
    icon: <MessageOutlined />,
    toolIds: ['search_conversations', 'list_conversations', 'get_conversation_detail'],
  },
  {
    id: 'basic_helpers',
    icon: <BulbOutlined />,
    toolIds: ['date_time', 'ask_user'],
  },
]

/** 将工具名/标题映射为更简短的中文标签 */
function toolShortLabel(tool: ToolItem, t: any): string {
  const i18nKey = `workbench.toolNames.${tool.name}` as any
  const translated = t(i18nKey, { defaultValue: '' })
  if (translated) return translated
  return tool.title || tool.name
}

/** 内置工具多选列表（按分类分组） */
const ToolCheckboxes: React.FC<ToolCheckboxesProps> = ({ tools, selectedIds, onChange }) => {
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
        {TOOL_CATEGORIES.map((cat) => {
          // 从传入 tools 中找出属于该分类的工具（保证 UI 不展示不存在的工具）
          const catTools = tools.filter(tl => cat.toolIds.includes(tl.id))
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
                  <span style={{ color: token.colorPrimary }}>{cat.icon}</span>
                  <Text strong ellipsis style={{ fontSize: 13 }}>
                    {t(`employeeSettings.toolCategory_${cat.id}`, { defaultValue: cat.id })}
                  </Text>
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
