import { Drawer, theme, Empty } from 'antd'
import { TeamOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useCallback, useState } from 'react'
import type { MessageSegment } from './types'
import { DelegationSegment } from './DelegationSegment'

interface SubTaskDrawerProps {
  open: boolean
  segments: MessageSegment[] // 仅 delegation 段
  getToolDisplayName: (name: string) => string
  onClose: () => void
}

const SubTaskDrawer: React.FC<SubTaskDrawerProps> = ({ open, segments, getToolDisplayName, onClose }) => {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  // 抽屉内独立的展开/折叠状态（默认展开便于查看详情，不写入消息段）
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const handleToggle = useCallback((_msgId: string, segId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(segId)) next.delete(segId)
      else next.add(segId)
      return next
    })
  }, [])

  return (
    <Drawer
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <TeamOutlined style={{ color: token.colorPrimary }} />
          {t('workbench.delegationViewTitle')}
        </span>
      }
      open={open}
      onClose={onClose}
      width={560}
      styles={{ body: { padding: 12, overflowY: 'auto', background: token.colorBgLayout } }}
    >
      {segments.length === 0 ? (
        <Empty description={t('workbench.delegationNoOutput')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {segments.map(seg => (
            <DelegationSegment
              key={seg.id}
              seg={{
                ...seg,
                collapsed: expandedIds.has(seg.id) ? false : (seg.collapsed ?? true),
                // 子段（工具调用/思考）折叠状态同样由抽屉内 expandedIds 驱动，
                // 键格式与 DelegationSegment 内部 ""<segId>__sub__<subSegId>" 保持一致，
                // 修复抽屉内无法展开子任务里的工具/思考的 bug
                subSegments: (seg.subSegments || []).map(ss => {
                  const subKey = `${seg.id}__sub__${ss.id}`
                  return expandedIds.has(subKey) ? { ...ss, collapsed: false } : ss
                }),
              }}
              msgId={`st_${seg.id}`}
              onToggle={handleToggle}
              getToolDisplayName={getToolDisplayName}
            />
          ))}
        </div>
      )}
    </Drawer>
  )
}

export default SubTaskDrawer