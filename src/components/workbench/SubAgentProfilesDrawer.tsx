import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, List, Avatar, Tag, App, theme, Modal, Typography, Empty, Popconfirm, Tooltip, Divider } from 'antd'
import { SolutionOutlined, DeleteOutlined, ReloadOutlined, EyeOutlined, RobotOutlined } from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface SubAgentProfile {
  id: string
  name: string
  description: string
  system_prompt: string
  tools_json: string
  skills_json: string
  provider_id?: string | null
  model_id?: string | null
  source: 'user' | 'builtin'
}

const parseTags = (json: string): string[] => {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 子智能体模板抽屉（只读模板库）：主管委托时可按模板派发（subagent_profile_id） */
const SubAgentProfilesDrawer: React.FC<{
  open: boolean
  onClose: () => void
}> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const { message: toast } = App.useApp()
  const { token } = theme.useToken()
  const [profiles, setProfiles] = useState<SubAgentProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<SubAgentProfile | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI.subagent.listProfiles()
      setProfiles(list || [])
    } catch {
      toast.error(t('common.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const handleDelete = async (id: string) => {
    try {
      const res = await window.electronAPI.subagent.deleteProfile(id)
      if (!res.ok) { toast.error(res.error || t('common.deleteFailed')); return }
      toast.success(t('common.deleteSuccess'))
      if (detail?.id === id) setDetail(null)
      void load()
    } catch {
      toast.error(t('common.deleteFailed'))
    }
  }

  const renderTags = (list: string[], emptyText: string) => (
    list.length > 0
      ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {list.map((x) => <Tag key={x} style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{x}</Tag>)}
        </div>
      )
      : <Text type="secondary" style={{ fontSize: 12 }}>{emptyText}</Text>
  )

  return (
    <Drawer
      title={t('subagentProfiles.title')}
      open={open}
      onClose={onClose}
      width={480}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} />}
    >
      <Paragraph type="secondary" style={{ marginTop: 0, fontSize: 12 }}>
        {t('subagentProfiles.builtinHint')}
      </Paragraph>
      <List
        loading={loading}
        dataSource={profiles}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('subagentProfiles.empty')} /> }}
        renderItem={(p: SubAgentProfile) => {
          const tools = parseTags(p.tools_json)
          const skills = parseTags(p.skills_json)
          return (
            <List.Item
              style={{ padding: '10px 0', cursor: 'pointer' }}
              onClick={() => setDetail(p)}
              actions={[
                <Tooltip key="view" title={t('subagentProfiles.detail')}>
                  <Button type="text" size="small" icon={<EyeOutlined />} onClick={(e) => { e.stopPropagation(); setDetail(p) }} />
                </Tooltip>,
                p.source === 'user' && (
                  <Popconfirm
                    key="del"
                    title={t('subagentProfiles.confirmDelete')}
                    onConfirm={() => void handleDelete(p.id)}
                  >
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>
                ),
              ]}
            >
              <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                <Avatar size={32} icon={<SolutionOutlined />} style={{ backgroundColor: token.colorPrimaryBg, color: token.colorPrimary, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Text strong style={{ fontSize: 13 }}>{p.name}</Text>
                    {p.source === 'builtin' && <Tag style={{ margin: 0 }}>{t('subagentProfiles.builtin')}</Tag>}
                  </div>
                  {p.description && (
                    <Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }} ellipsis={{ rows: 1 }}>
                      {p.description}
                    </Paragraph>
                  )}
                  <Paragraph style={{ margin: '2px 0 0', fontSize: 11, color: token.colorTextQuaternary }} ellipsis={{ rows: 1 }}>
                    {t('subagentProfiles.toolsLabel')}: {tools.join('、') || t('subagentProfiles.defaultTools')}
                    {skills.length > 0 ? ` · ${t('subagentProfiles.skillsLabel')}: ${skills.join('、')}` : ''}
                  </Paragraph>
                  <Paragraph style={{ margin: 0, fontSize: 11, color: token.colorTextQuaternary }} ellipsis={{ rows: 1 }}>
                    {t('subagentProfiles.promptLabel')}: {p.system_prompt}
                  </Paragraph>
                </div>
              </div>
            </List.Item>
          )
        }}
      />

      <Modal
        title={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RobotOutlined />
            <span>{detail?.name}</span>
            {detail?.source === 'builtin' && <Tag style={{ margin: 0 }}>{t('subagentProfiles.builtin')}</Tag>}
          </div>
        )}
        open={!!detail}
        onCancel={() => setDetail(null)}
        width={720}
        footer={<Button onClick={() => setDetail(null)}>{t('common.close')}</Button>}
      >
        {detail && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh', overflow: 'auto', paddingRight: 4 }}>
            <div>
              <Text strong style={{ fontSize: 12 }}>{t('subagentProfiles.descriptionLabel')}</Text>
              <Paragraph style={{ margin: '4px 0 0', fontSize: 13 }}>
                {detail.description || <Text type="secondary">{t('subagentProfiles.none')}</Text>}
              </Paragraph>
            </div>

            <div>
              <Text strong style={{ fontSize: 12 }}>{t('subagentProfiles.modelLabel')}</Text>
              <div style={{ marginTop: 4 }}>
                {detail.provider_id || detail.model_id
                  ? <Tag style={{ margin: 0, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{detail.provider_id || '-'} / {detail.model_id || '-'}</Tag>
                  : <Text type="secondary" style={{ fontSize: 12 }}>{t('subagentProfiles.inheritModel')}</Text>}
              </div>
            </div>

            <div>
              <Text strong style={{ fontSize: 12 }}>{t('subagentProfiles.toolsLabel')}</Text>
              <div style={{ marginTop: 4 }}>{renderTags(parseTags(detail.tools_json), t('subagentProfiles.defaultTools'))}</div>
            </div>

            <div>
              <Text strong style={{ fontSize: 12 }}>{t('subagentProfiles.skillsLabel')}</Text>
              <div style={{ marginTop: 4 }}>{renderTags(parseTags(detail.skills_json), t('subagentProfiles.none'))}</div>
            </div>

            <Divider style={{ margin: '2px 0' }} />

            <div>
              <Text strong style={{ fontSize: 12 }}>{t('subagentProfiles.promptLabel')}</Text>
              <pre
                style={{
                  margin: '6px 0 0',
                  padding: 12,
                  borderRadius: token.borderRadius,
                  background: token.colorFillQuaternary,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  color: token.colorText,
                  fontSize: 12,
                  lineHeight: 1.7,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                }}
              >
                {detail.system_prompt || t('subagentProfiles.none')}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </Drawer>
  )
}

export default SubAgentProfilesDrawer
