import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Card,
  Button,
  Empty,
  Typography,
  Select,
  Space,
  Tag,
  App,
} from 'antd'
import { LinkOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import KBListItem from '../common/KBListItem'

const { Text } = Typography

interface KnowledgeBaseSectionProps {
  linkedKBs: any[]
  employeeKBs: any[]
  allKBs: any[]
  projectId?: string
  employeeId: string
  onRefresh: () => void
}

const KnowledgeBaseSection: React.FC<KnowledgeBaseSectionProps> = ({
  linkedKBs,
  employeeKBs,
  allKBs,
  projectId,
  employeeId,
  onRefresh,
}) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [linking, setLinking] = useState(false)
  const [selectedKbId, setSelectedKbId] = useState<string | undefined>(undefined)

  const existingKbIds = new Set([
    ...employeeKBs.map((kb: any) => kb.id),
    ...linkedKBs.map((kb: any) => kb.id),
  ])

  const availableKBs = allKBs.filter((kb: any) => !existingKbIds.has(kb.id))

  const handleLinkKB = async () => {
    if (!selectedKbId) return
    setLinking(true)
    try {
      await window.electronAPI.employee.linkKB({ employee_id: employeeId, kb_id: selectedKbId })
      message.success(t('employeeSettings.kbLinked'))
      setSelectedKbId(undefined)
      onRefresh()
    } catch {
      message.error(t('common.saveFailed'))
    } finally {
      setLinking(false)
    }
  }

  const handleUnlinkKB = async (kbId: string) => {
    try {
      await window.electronAPI.employee.unlinkKB({ employee_id: employeeId, kb_id: kbId })
      message.success(t('employeeSettings.kbUnlinked'))
      onRefresh()
    } catch {
      message.error(t('common.deleteFailed'))
    }
  }

  const allLinkedKBs = (() => {
    const map = new Map<string, any>()
    for (const kb of linkedKBs) {
      map.set(kb.id, { ...kb, source: 'project' })
    }
    for (const kb of employeeKBs) {
      if (!map.has(kb.id)) {
        map.set(kb.id, { ...kb, source: 'employee' })
      }
    }
    return Array.from(map.values())
  })()

  return (
    <Card
      title={t('employeeSettings.linkedKb')}
      extra={
        projectId ? (
          <Button type="link" icon={<LinkOutlined />} onClick={() => navigate(`/project/${projectId}`)}>
            {t('employeeSettings.manageAssociation')}
          </Button>
        ) : null
      }
    >
      {allLinkedKBs.length > 0 ? (
        <div>
          {allLinkedKBs.map((kb: any) => (
            <div key={kb.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <KBListItem kb={kb} />
              </div>
              {kb.source === 'employee' && (
                <Button
                  type="text"
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => handleUnlinkKB(kb.id)}
                />
              )}
              {kb.source === 'project' && (
                <Tag color="blue" style={{ fontSize: 11 }}>{t('employeeSettings.kbFromProject')}</Tag>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty description={t('employeeSettings.noLinkedKb')} />
      )}

      <div style={{ marginTop: 16, borderTop: `1px solid var(--ant-color-border-secondary)`, paddingTop: 16 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          {t('employeeSettings.linkKbDirectly')}
        </Text>
        <Space.Compact style={{ width: '100%' }}>
          <Select
            style={{ flex: 1 }}
            placeholder={t('employeeSettings.selectKbToLink')}
            value={selectedKbId}
            onChange={setSelectedKbId}
            options={availableKBs.map((kb: any) => ({ value: kb.id, label: kb.name }))}
            allowClear
            notFoundContent={t('employeeSettings.noAvailableKb')}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleLinkKB}
            loading={linking}
            disabled={!selectedKbId}
          >
            {t('employeeSettings.linkKb')}
          </Button>
        </Space.Compact>
      </div>
    </Card>
  )
}

export default KnowledgeBaseSection
