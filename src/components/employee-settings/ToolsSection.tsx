import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Segmented,
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
  AppstoreOutlined,
  TeamOutlined,
} from '@ant-design/icons'

const { Text } = Typography

export type ToolMode = 'on' | 'on_demand' | 'off'

interface ToolInfo {
  id: string
  name: string
  title: string
  description: string
  category: string
  mode?: ToolMode
  is_enabled: boolean
  is_assigned: boolean
}

interface CategoryTool {
  id: string
  name: string
  title: string
  description: string
  mode: ToolMode
}

export interface ToolCategoryInfo {
  id: string
  name: string
  title: string
  description: string
  icon: string
  /** 插件贡献的分类（来自某插件，仅插件加载时存在） */
  is_plugin?: boolean
  /** 插件分类对应的插件 id（用于以插件命名空间解析 title 的 i18n key） */
  plugin_id?: string
  tool_ids: string[]
  tools: CategoryTool[]
  mode: ToolMode
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
  plugin: <AppstoreOutlined />,
  team: <TeamOutlined />,
}

interface ToolsSectionProps {
  /** 向后兼容：单工具列表（旧数据，留着但不再渲染） */
  employeeTools?: ToolInfo[]
  /** 新的分类聚合工具列表 */
  toolCategories?: ToolCategoryInfo[]
  /** 切换单个工具的模式（on / on_demand / off） */
  onChangeToolMode?: (toolId: string, mode: ToolMode) => void
  /** 切换整个分类下所有工具的模式 */
  onChangeCategoryMode?: (categoryId: string, mode: ToolMode) => void
}

const ToolsSection: React.FC<ToolsSectionProps> = ({
  employeeTools,
  toolCategories,
  onChangeToolMode,
  onChangeCategoryMode,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const modeOptions = [
    { label: t('employeeSettings.mode_off'), value: 'off' },
    { label: t('employeeSettings.mode_on_demand'), value: 'on_demand' },
    { label: t('employeeSettings.mode_on'), value: 'on' },
  ]

  const handleChangeCategoryMode = useCallback(
    (categoryId: string, mode: ToolMode) => {
      onChangeCategoryMode?.(categoryId, mode)
    },
    [onChangeCategoryMode],
  )

  const handleChangeToolMode = useCallback(
    (toolId: string, mode: ToolMode) => {
      onChangeToolMode?.(toolId, mode)
    },
    [onChangeToolMode],
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
              const catIcon = CATEGORY_ICON_MAP[cat.icon] || <ToolOutlined />
              // 分类内工具模式不一致时提示"混合"（分类 Segmented 仍按最高状态显示）
              const isMixed = new Set(cat.tools.map(t => t.mode)).size > 1

              return (
                <div
                  key={cat.id}
                  style={{
                    padding: '12px 0',
                    borderBottom: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  {/* 分类级头部：图标 + 名称/描述 + 三态模式选择 */}
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
                          backgroundColor:
                            cat.mode === 'off'
                              ? token.colorBgContainer
                              : token.colorPrimary,
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
                            {cat.is_plugin
                              ? t(cat.title, { ns: cat.plugin_id, defaultValue: cat.title })
                              : t(`employeeSettings.toolCategory_${cat.id}`, {
                                  defaultValue: cat.title,
                                })}
                          </Text>
                          {cat.is_plugin ? (
                            <Tag color="purple" style={{ flexShrink: 0 }}>
                              {t('employeeSettings.plugin')}
                            </Tag>
                          ) : (
                            <Tag color="blue" style={{ flexShrink: 0 }}>
                              {t('employeeSettings.builtin')}
                            </Tag>
                          )}
                          <Tag
                            color={
                              cat.mode === 'off' ? 'default' : 'green'
                            }
                            style={{ flexShrink: 0 }}
                          >
                            {t('employeeSettings.categoryToolCount', {
                              enabled: cat.enabled_count,
                              total: cat.total_count,
                            })}
                          </Tag>
                          {isMixed && (
                            <Tag color="orange" style={{ flexShrink: 0 }}>
                              {t('employeeSettings.categoryMixed')}
                            </Tag>
                          )}
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
                    <Segmented
                      size="small"
                      options={modeOptions}
                      value={cat.mode}
                      onChange={(value) =>
                        handleChangeCategoryMode(cat.id, value as ToolMode)
                      }
                    />
                  </div>

                  {/* 分类折叠：工具明细（可单独设置每个工具的模式） */}
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
                            {cat.tools.map((tool) => (
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
                                {onChangeToolMode && (
                                  <Segmented
                                    size="small"
                                    options={modeOptions}
                                    value={tool.mode}
                                    onChange={(value) =>
                                      handleChangeToolMode(
                                        tool.id,
                                        value as ToolMode,
                                      )
                                    }
                                  />
                                )}
                              </div>
                            ))}
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
                <Segmented
                  size="small"
                  options={modeOptions}
                  value={tool.mode || (tool.is_enabled ? 'on' : 'off')}
                  onChange={(value) =>
                    handleChangeToolMode(tool.id, value as ToolMode)
                  }
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
