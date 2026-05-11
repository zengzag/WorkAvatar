import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Space,
  Avatar,
  Tag,
  Empty,
  Typography,
  Alert,
  Popconfirm,
  theme,
} from 'antd'
import {
  BookOutlined,
  DeleteOutlined,
  PlusOutlined,
  ImportOutlined,
  ThunderboltOutlined,
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

interface SkillsSectionProps {
  installedSkills: InstalledSkill[]
  employeeSkills: InstalledSkill[]
  availableSkills: InstalledSkill[]
  installingSkill: boolean
  onInstallFromDir: () => void
  onInstallFromZip: () => void
  onUninstallSkill: (skillId: string) => void
  onAssignSkill: (skillId: string) => void
  onRemoveSkill: (skillId: string) => void
}

const SkillsSection: React.FC<SkillsSectionProps> = ({
  installedSkills,
  employeeSkills,
  availableSkills,
  installingSkill,
  onInstallFromDir,
  onInstallFromZip,
  onUninstallSkill,
  onAssignSkill,
  onRemoveSkill,
}) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      <Alert
        title={t('employeeSettings.skillsAlertTitle')}
        description={t('employeeSettings.skillsAlertDesc')}
        type="info"
        showIcon
      />

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
                  <Avatar style={{ backgroundColor: '#722ed1', flexShrink: 0 }} icon={<BookOutlined />} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                      <Tag color="default" style={{ flexShrink: 0 }}>{skill.author}</Tag>
                    </div>
                    <Space orientation="vertical" size={0} style={{ width: '100%' }}>
                      <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
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
            <ImportOutlined />
            <span>{t('employeeSettings.assignedSkills', { count: employeeSkills.length })}</span>
          </Space>
        }
      >
        {employeeSkills.length === 0 ? (
          <Empty description={t('employeeSettings.noAssignedSkills')} />
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
                  <Avatar style={{ backgroundColor: token.colorPrimary, flexShrink: 0 }} icon={<BookOutlined />} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                    </div>
                    <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
                  </div>
                </div>
                <Popconfirm
                  title={t('employeeSettings.confirmRemoveSkill')}
                  description={t('employeeSettings.removeSkillDesc')}
                  onConfirm={() => onRemoveSkill(skill.id)}
                >
                  <Button type="text" danger icon={<DeleteOutlined />}>
                    {t('common.remove')}
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
            <ThunderboltOutlined />
            <span>{t('employeeSettings.availableSkills', { count: availableSkills.length })}</span>
          </Space>
        }
      >
        {availableSkills.length === 0 ? (
          <Empty description={t('employeeSettings.noAvailableSkills')} />
        ) : (
          <div>
            {availableSkills.map((skill) => (
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
                  <Avatar style={{ backgroundColor: token.colorSuccess, flexShrink: 0 }} icon={<BookOutlined />} />
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                    <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                      <Tag color="blue" style={{ flexShrink: 0 }}>v{skill.version}</Tag>
                    </div>
                    <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description || skill.skillMdContent?.substring(0, 200).replace(/^#\s+.+\n?/, '').trim() || t('employeeSettings.noDesc')}</Text>
                  </div>
                </div>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => onAssignSkill(skill.id)}
                >
                  {t('common.assign')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Space>
  )
}

export default SkillsSection
