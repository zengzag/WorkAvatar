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
  theme,
  Collapse,
} from 'antd'
import {
  ToolOutlined,
  FileOutlined,
  DatabaseOutlined,
  CalendarOutlined,
  RobotOutlined,
  GlobalOutlined,
  SettingOutlined,
  FileTextOutlined,
  MessageOutlined,
  BulbOutlined,
} from '@ant-design/icons'

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

interface CategoryTool {
  id: string
  name: string
  title: string
  description: string
}

export interface ToolCategoryInfo {
  id: string
  name: string
  title: string
  description: string
  icon: string
  tool_ids: string[]
  tools: CategoryTool[]
  is_enabled: boolean
  enabled_count: number
  total_count: number
}

const CATEGORY_ICON_MAP: Record<string, React.ReactNode> = {
  file: <FileOutlined />,
  database: <DatabaseOutlined />,
  calendar: <CalendarOutlined />,
  robot: <RobotOutlined />,
  global: <GlobalOutlined />,
  setting: <SettingOutlined />,
  'file-document': <FileTextOutlined />,
  message: <MessageOutlined />,
  tool: <BulbOutlined />,
}

interface ToolsSectionProps {
  /** 向后兼容：单工具列表（旧数据，留着但不再渲染） */
  employeeTools?: ToolInfo[]
  /** 新的分类聚合工具列表 */
  toolCategories?: ToolCategoryInfo[]
  /** 切换单个工具（保留用于兼容） */
  onToggleTool?: (toolId: string, enabled: boolean) => void
  /** 切换整个分类下的所有工具 */
  onToggleCategory?: (categoryId: string, enabled: boolean) => void
}

const ToolsSection: React.FC<ToolsSectionProps> = ({
  employeeTools,
  toolCategories,
  onToggleTool,
  onToggleCategory,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const handleToggleCategory = useCallback(
    (categoryId: string, enabled: boolean) => {
      onToggleCategory?.(categoryId, enabled)
    },
    [onToggleCategory],
  )

  const hasCategories = toolCategories && toolCategories.length > 0
  const hasLegacyTools = employeeTools && employeeTools.length > 0

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      <Card
        title={
          <Space>
            <ToolOutlined />
            <span>
              {t('employeeSettings.builtinTools', {
                count: hasCategories ? toolCategories!.length : employeeTools?.length || 0,
              })}
            </span>
          </Space>
        }
        extra={
          hasCategories && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('employeeSettings.categoryHint')}
            </Text>
          )
        }
      >
        {!hasCategories && !hasLegacyTools ? (
          <Empty description={t('employeeSettings.noBuiltinTools')} />
        ) : hasCategories ? (
          <div>
            {toolCategories!.map((cat) => {
              const isPartiallyOn =
                cat.enabled_count > 0 && cat.enabled_count < cat.total_count
              const catIcon = CATEGORY_ICON_MAP[cat.icon] || <ToolOutlined />

              return (
                <div
                  key={cat.id}
                  style={{
                    padding: '12px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  {/* 分类级头部：图标 + 名称/描述 + 开关 */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <Avatar
                        style={{
                          backgroundColor: cat.is_enabled
                            ? token.colorPrimary
                            : token.colorBgContainer,
                          flexShrink: 0,
                        }}
                        icon={catIcon}
                      />
                      <div
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
                      >
                        <div
                          style={{
                            marginBottom: 4,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <Text
                            strong
                            ellipsis
                            style={{ display: 'inline-block' }}
                          >
                            {t(`employeeSettings.toolCategory_${cat.id}`, {
                              defaultValue: cat.title,
                            })}
                          </Text>
                          <Tag color="blue" style={{ flexShrink: 0 }}>
                            {t('employeeSettings.builtin')}
                          </Tag>
                          <Tag
                            color={
                              cat.enabled_count === cat.total_count
                                ? 'green'
                                : isPartiallyOn
                                ? 'orange'
                                : 'default'
                            }
                            style={{ flexShrink: 0 }}
                          >
                            {t('employeeSettings.categoryToolCount', {
                              enabled: cat.enabled_count,
                              total: cat.total_count,
                            })}
                          </Tag>
                        </div>
                        <Text
                          type="secondary"
                          ellipsis
                          style={{ display: 'block' }}
                        >
                          {t(
                            `employeeSettings.toolCategoryDesc_${cat.id}`,
                            { defaultValue: cat.description },
                          )}
                        </Text>
                      </div>
                    </div>
                    <Switch
                      checked={cat.is_enabled}
                      onChange={(checked) =>
                        handleToggleCategory(cat.id, checked)
                      }
                      checkedChildren={t('common.enable')}
                      unCheckedChildren={t('common.disable')}
                    />
                  </div>

                  {/* 分类折叠：工具明细（只读），让用户理解该分类包含哪些能力 */}
                  <Collapse
                    ghost
                    size="small"
                    style={{ marginTop: 8, marginLeft: 52 }}
                    items={[
                      {
                        key: cat.id,
                        label: (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t('employeeSettings.expandCategoryTools', {
                              count: cat.tools.length,
                            })}
                          </Text>
                        ),
                        children: (
                          <div
                            style={{
                              padding: '8px 12px',
                              background: token.colorFillQuaternary,
                              borderRadius: token.borderRadiusSM,
                            }}
                          >
                            {cat.tools.map((tool) => {
                              const toolEnabled =
                                onToggleTool && employeeTools
                                  ? employeeTools.find(
                                      (et) => et.id === tool.id,
                                    )?.is_enabled ?? true
                                  : undefined
                              return (
                                <div
                                  key={tool.id}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    padding: '6px 0',
                                  }}
                                >
                                  <div
                                    style={{
                                      flex: 1,
                                      minWidth: 0,
                                      marginRight: 12,
                                    }}
                                  >
                                    <Text
                                      style={{ fontSize: 13 }}
                                      ellipsis
                                      title={
                                        toolEnabled === undefined
                                          ? undefined
                                          : toolEnabled
                                          ? t('common.on')
                                          : t('common.off')
                                      }
                                    >
                                      {tool.title || tool.name}
                                    </Text>
                                    <Text
                                      type="secondary"
                                      style={{
                                        fontSize: 12,
                                        display: 'block',
                                      }}
                                      ellipsis
                                    >
                                      {tool.description ||
                                        t('employeeSettings.noDesc')}
                                    </Text>
                                  </div>
                                  {onToggleTool && (
                                    <Switch
                                      size="small"
                                      checked={toolEnabled ?? true}
                                      onChange={(checked) =>
                                        onToggleTool(tool.id, checked)
                                      }
                                    />
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        ),
                      },
                    ]}
                  />
                </div>
              )
            })}
          </div>
        ) : (
          // 向后兼容：未提供 categories 时，使用旧的平铺视图
          <div>
            {employeeTools!.map((tool) => (
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <Avatar
                    style={{
                      backgroundColor: tool.is_enabled
                        ? token.colorPrimary
                        : token.colorBgContainer,
                      flexShrink: 0,
                    }}
                    icon={<ToolOutlined />}
                  />
                  <div
                    style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}
                  >
                    <div
                      style={{
                        marginBottom: 4,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Text
                        strong
                        ellipsis
                        style={{ display: 'inline-block' }}
                      >
                        {tool.title || tool.name}
                      </Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>
                        {t('employeeSettings.builtin')}
                      </Tag>
                    </div>
                    <Text
                      type="secondary"
                      ellipsis
                      style={{ display: 'block' }}
                    >
                      {tool.description || t('employeeSettings.noDesc')}
                    </Text>
                  </div>
                </div>
                <Switch
                  checked={tool.is_enabled}
                  onChange={(checked) => onToggleTool?.(tool.id, checked)}
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
