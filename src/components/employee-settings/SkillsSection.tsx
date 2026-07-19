import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Switch,
  Space,
  Avatar,
  Tag,
  Empty,
  Typography,
  Popconfirm,
  theme,
} from 'antd'
import {
  BookOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  FileZipOutlined,
} from '@ant-design/icons'

const { Text } = Typography

interface InstalledSkill {
  id: string
  name: string
  description: string
  version: string
  author: string
  tags: string[]
  is_enabled: boolean
  created_at: number
  skillMdContent?: string
}

interface EmployeeSkill extends InstalledSkill {
  enabled: boolean
}

interface SkillsSectionProps {
  installedSkills: InstalledSkill[]
  employeeSkills: EmployeeSkill[]
  installingSkill: boolean
  onInstallFromDir: () => void
  onInstallFromZip: () => void
  onUninstallSkill: (skillId: string) => void
  onToggleSkill: (skillId: string, enabled: boolean) => void
}

// 描述回退逻辑：优先 description，其次取 skillMdContent 前 200 字符去掉首行 Markdown 标题，最后回退到无描述
function getSkillDescription(skill: InstalledSkill, fallback: string): string {
  if (skill.description) return skill.description
  if (skill.skillMdContent) {
    const preview = skill.skillMdContent.substring(0, 200).replace(/^#\s+.+\n?/, '').trim()
    if (preview) return preview
  }
  return fallback
}

const SkillsSection: React.FC<SkillsSectionProps> = ({
  installedSkills,
  employeeSkills,
  installingSkill,
  onInstallFromDir,
  onInstallFromZip,
  onUninstallSkill,
  onToggleSkill,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // 已启用技能 id 集合，使用 useMemo 缓存避免每次渲染重新构造
  const enabledSkillIds = useMemo(
    () => new Set(employeeSkills.filter((s) => s.enabled).map((s) => s.id)),
    [employeeSkills]
  )

  const noDescText = t('employeeSettings.noDesc')

  // 包装 props 传入的回调，保证稳定引用
  const handleToggle = useCallback((skillId: string, enabled: boolean) => {
    onToggleSkill(skillId, enabled)
  }, [onToggleSkill])

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      <Card
        title={
          <Space>
            <BookOutlined />
            <span>{t('employeeSettings.installedSkills', { count: installedSkills.length })}</span>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<FolderOpenOutlined />} onClick={onInstallFromDir} loading={installingSkill}>
              {t('employeeSettings.installFromDir')}
            </Button>
            <Button icon={<FileZipOutlined />} onClick={onInstallFromZip} loading={installingSkill}>
              {t('employeeSettings.installFromZip')}
            </Button>
          </Space>
        }
      >
        {installedSkills.length === 0 ? (
          <Empty description={t('employeeSettings.noInstalledSkills')} />
        ) : (
          <div>
            {installedSkills.map((skill) => (
              <div
                key={skill.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
                  <Avatar style={{ backgroundColor: token.colorInfo, flexShrink: 0 }} icon={<BookOutlined />} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                      <Tag color="default" style={{ flexShrink: 0 }}>{skill.author}</Tag>
                    </div>
                    <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                      <Text type="secondary" ellipsis style={{ display: 'block' }}>{getSkillDescription(skill, noDescText)}</Text>
                      <Space size={4} style={{ marginTop: 4 }} wrap>
                        {skill.tags.map((tag) => (
                          <Tag key={tag}>{tag}</Tag>
                        ))}
                      </Space>
                    </Space>
                  </div>
                </div>
                <Popconfirm
                  title={t('employeeSettings.confirmUninstallSkill')}
                  description={t('employeeSettings.uninstallSkillDesc')}
                  onConfirm={() => onUninstallSkill(skill.id)}
                >
                  <Button type="text" danger icon={<DeleteOutlined />}>
                    {t('common.uninstall')}
                  </Button>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title={
          <Space>
            <BookOutlined />
            <span>{t('employeeSettings.availableSkills', { count: employeeSkills.length })}</span>
          </Space>
        }
      >
        {employeeSkills.length === 0 ? (
          <Empty description={t('employeeSettings.noInstalledSkills')} />
        ) : (
          <div>
            {employeeSkills.map((skill) => (
              <div
                key={skill.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                  <Avatar
                    style={{
                      backgroundColor: enabledSkillIds.has(skill.id) ? token.colorPrimary : token.colorBgContainer,
                      flexShrink: 0,
                    }}
                    icon={<BookOutlined />}
                  />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                    </div>
                    <Text type="secondary" ellipsis style={{ display: 'block' }}>{getSkillDescription(skill, noDescText)}</Text>
                  </div>
                </div>
                <Switch
                  checked={skill.enabled}
                  onChange={(checked) => handleToggle(skill.id, checked)}
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

export default React.memo(SkillsSection)
