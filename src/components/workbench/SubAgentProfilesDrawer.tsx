import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, Button, List, Avatar, Tag, App, theme, Modal, Input, Typography, Empty, Popconfirm } from 'antd'
import { PlusOutlined, SolutionOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons'

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

interface EditorState {
  open: boolean
  id?: string
  name: string
  description: string
  system_prompt: string
  tools: string
  skills: string
}

const emptyEditor: EditorState = { open: false, name: '', description: '', system_prompt: '', tools: '', skills: '' }

const parseTags = (json: string): string[] => {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** 子智能体模板管理抽屉：主管委托时可按模板派发（subagent_profile_id） */
const SubAgentProfilesDrawer: React.FC<{
  open: boolean
  onClose: () => void
}> = ({ open, onClose }) => {
  const { t } = useTranslation()
  const { message: toast } = App.useApp()
  const { token } = theme.useToken()
  const [profiles, setProfiles] = useState<SubAgentProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<EditorState>(emptyEditor)

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

  const openCreate = () => setEditor({ ...emptyEditor, open: true })
  const openEdit = (p: SubAgentProfile) => setEditor({
    open: true,
    id: p.id,
    name: p.name,
    description: p.description,
    system_prompt: p.system_prompt,
    tools: parseTags(p.tools_json).join(', '),
    skills: parseTags(p.skills_json).join(', '),
  })

  const handleSave = async () => {
    if (!editor.name.trim() || !editor.system_prompt.trim()) {
      toast.warning(t('subagentProfiles.nameAndPromptRequired'))
      return
    }
    const tools = editor.tools.split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean)
    const skills = editor.skills.split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean)
    try {
      const res = editor.id
        ? await window.electronAPI.subagent.updateProfile({
            id: editor.id, name: editor.name, description: editor.description,
            system_prompt: editor.system_prompt, tools, skills,
          })
        : await window.electronAPI.subagent.createProfile({
            name: editor.name, description: editor.description,
            system_prompt: editor.system_prompt, tools, skills,
          })
      if (!res.ok) { toast.error(res.error || t('common.saveFailed')); return }
      toast.success(t('common.saveSuccess'))
      setEditor(emptyEditor)
      void load()
    } catch {
      toast.error(t('common.saveFailed'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await window.electronAPI.subagent.deleteProfile(id)
      if (!res.ok) { toast.error(res.error || t('common.deleteFailed')); return }
      toast.success(t('common.deleteSuccess'))
      void load()
    } catch {
      toast.error(t('common.deleteFailed'))
    }
  }

  return (
    <Drawer
      title={t('subagentProfiles.title')}
      open={open}
      onClose={onClose}
      width={480}
      extra={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} />
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
            {t('subagentProfiles.create')}
          </Button>
        </div>
      }
    >
      <List
        loading={loading}
        dataSource={profiles}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('subagentProfiles.empty')} /> }}
        renderItem={(p: SubAgentProfile) => (
          <List.Item
            style={{ padding: '10px 0' }}
            actions={[
              p.source === 'user' && (
                <Button key="edit" type="text" size="small" icon={<EditOutlined />} onClick={() => openEdit(p)} />
              ),
              p.source === 'user' && (
                <Popconfirm
                  key="del"
                  title={t('subagentProfiles.confirmDelete')}
                  onConfirm={() => void handleDelete(p.id)}
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} />
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
                <Paragraph style={{ margin: 0, fontSize: 11, color: token.colorTextQuaternary }} ellipsis={{ rows: 1 }}>
                  {parseTags(p.tools_json).join('、') || t('subagentProfiles.defaultTools')}
                </Paragraph>
              </div>
            </div>
          </List.Item>
        )}
      />

      <Modal
        title={editor.id ? t('subagentProfiles.edit') : t('subagentProfiles.create')}
        open={editor.open}
        onCancel={() => setEditor(emptyEditor)}
        onOk={() => void handleSave()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        destroyOnHidden
        width={560}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            placeholder={t('subagentProfiles.fieldName')}
            value={editor.name}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            maxLength={50}
          />
          <Input
            placeholder={t('subagentProfiles.fieldDescription')}
            value={editor.description}
            onChange={(e) => setEditor({ ...editor, description: e.target.value })}
            maxLength={200}
          />
          <Input.TextArea
            placeholder={t('subagentProfiles.fieldSystemPrompt')}
            value={editor.system_prompt}
            onChange={(e) => setEditor({ ...editor, system_prompt: e.target.value })}
            autoSize={{ minRows: 4, maxRows: 14 }}
          />
          <Input
            placeholder={t('subagentProfiles.fieldTools')}
            value={editor.tools}
            onChange={(e) => setEditor({ ...editor, tools: e.target.value })}
          />
          <Input
            placeholder={t('subagentProfiles.fieldSkills')}
            value={editor.skills}
            onChange={(e) => setEditor({ ...editor, skills: e.target.value })}
          />
        </div>
      </Modal>
    </Drawer>
  )
}

export default SubAgentProfilesDrawer
