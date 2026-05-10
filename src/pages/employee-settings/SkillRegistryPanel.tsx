import { Card, Button, Space, Tag, Typography, Switch, theme } from 'antd'
import { DownloadOutlined, DeleteOutlined, CloseOutlined } from '@ant-design/icons'

const { Text } = Typography

interface InstalledSkill {
  id: string
  name: string
  description: string
  enabled: boolean
}

interface SkillRegistryPanelProps {
  skills: InstalledSkill[]
  employeeSkills: Array<{ skill_id: string; is_enabled: boolean }>
  onInstall: () => void
  onUninstall: (id: string) => Promise<void>
  onToggle: (id: string, enabled: boolean) => void
  onAssign: (skillId: string) => void
  onRemove: (skillId: string) => void
}

export default function SkillRegistryPanel({
  skills, employeeSkills, onInstall, onUninstall, onToggle, onAssign, onRemove
}: SkillRegistryPanelProps) {
  const { token } = theme.useToken()

  if (skills.length === 0) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Text type="secondary">暂无已安装的技能</Text>
          <div style={{ marginTop: 16 }}>
            <Button type="primary" icon={<DownloadOutlined />} onClick={onInstall}>安装技能</Button>
          </div>
        </div>
      </Card>
    )
  }

  const assignedSkillIds = employeeSkills.map(es => es.skill_id)

  return (
    <div>
      {skills.map((skill) => {
        const isAssigned = assignedSkillIds.includes(skill.id)
        return (
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
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              <div style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Text strong ellipsis style={{ display: 'inline-block' }}>{skill.name}</Text>
                {isAssigned && <Tag color="blue" style={{ flexShrink: 0 }}>已分配</Tag>}
                <Tag color={skill.enabled ? 'success' : 'default'} style={{ flexShrink: 0 }}>{skill.enabled ? '启用' : '禁用'}</Tag>
              </div>
              <Text type="secondary" ellipsis style={{ display: 'block' }}>{skill.description}</Text>
            </div>
            <Space>
              {isAssigned
                ? <Button size="small" icon={<CloseOutlined />} onClick={() => onRemove(skill.id)}>取消分配</Button>
                : <Button size="small" type="primary" icon={<DownloadOutlined />} onClick={() => onAssign(skill.id)}>分配</Button>}
              <Switch size="small" checked={skill.enabled} onChange={(v) => onToggle(skill.id, v)} />
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onUninstall(skill.id)}>删除</Button>
            </Space>
          </div>
        )
      })}
    </div>
  )
}
