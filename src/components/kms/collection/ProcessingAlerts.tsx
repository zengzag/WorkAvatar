import React from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Typography } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import type { ProcessingCollectionState } from './collection-types'

const { Text } = Typography

interface ProcessingAlertsProps {
  processingMap: Record<string, ProcessingCollectionState>
  onViewProgress: (id: string, name: string) => void
}

const ProcessingAlerts: React.FC<ProcessingAlertsProps> = ({ processingMap, onViewProgress }) => {
  const { t } = useTranslation()
  const entries = Object.values(processingMap)
  if (entries.length === 0) return null

  return (
    <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      {entries.map((p) => (
        <Alert
          key={p.id}
          type="info"
          showIcon
          icon={<LoadingOutlined />}
          message={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Text strong style={{ fontSize: 13 }}>
                  {t('kms.collectionProcess.backgroundRunningHint', { name: p.name, percent: p.percent })}
                </Text>
                {p.message && (
                  <Text type="secondary" style={{ fontSize: 11, marginLeft: 8 }}>
                    - {p.message}
                  </Text>
                )}
              </div>
              <Button
                type="link"
                size="small"
                onClick={() => onViewProgress(p.id, p.name)}
              >
                {t('kms.collectionProcess.viewProgress')}
              </Button>
            </div>
          }
          style={{ padding: '6px 12px' }}
        />
      ))}
    </div>
  )
}

export default ProcessingAlerts
