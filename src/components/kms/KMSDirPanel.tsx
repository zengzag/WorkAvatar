import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Switch, Popconfirm, Empty, Typography, Space, Card, theme } from 'antd'
import { FolderOpenOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons'

const { Text } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
  recursive: number
  file_extensions: string
  created_at: number
  updated_at: number
}

interface KMSDirPanelProps {
  dirs: IndexDir[]
  onUpdateDir: (id: string, updates: { displayName?: string; enabled?: boolean; recursive?: boolean; fileExtensions?: string[] }) => void
  onDeleteDir: (id: string) => void
  onAddDir: (dirPath: string, displayName?: string, recursive?: boolean, fileExtensions?: string[]) => void
}

const KMSDirPanel: React.FC<KMSDirPanelProps> = ({ dirs, onUpdateDir, onDeleteDir, onAddDir }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const handleAddDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        properties: ['openDirectory'],
      })
      if (result && !result.canceled && result.filePaths.length > 0) {
        const dirPath = result.filePaths[0]
        const displayName = dirPath.split(/[/\\]/).pop() || dirPath
        onAddDir(dirPath, displayName, true)
      }
    } catch (err) {
      console.error('Failed to open directory picker:', err)
    }
  }, [onAddDir])

  if (dirs.length === 0) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <Empty
          image={<FolderOpenOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />}
          description={
            <div>
              <Text style={{ display: 'block', marginBottom: 8, fontSize: 15, fontWeight: 500 }}>
                {t('kms.noDirs')}
              </Text>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={handleAddDir}
              >
                {t('kms.addDir')}
              </Button>
            </div>
          }
        />
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '0 0 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAddDir}
        >
          {t('kms.addDir')}
        </Button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        <Space direction="vertical" style={{ width: '100%' }} size={8}>
          {dirs.map((dir) => (
            <Card
              key={dir.id}
              size="small"
              style={{
                borderLeft: `3px solid ${dir.enabled ? token.colorPrimary : token.colorTextQuaternary}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <FolderOpenOutlined style={{ color: dir.enabled ? token.colorPrimary : token.colorTextQuaternary }} />
                    <Text strong style={{ fontSize: 14 }}>
                      {dir.display_name || dir.dir_path.split(/[/\\]/).pop()}
                    </Text>
                    <Switch
                      size="small"
                      checked={dir.enabled === 1}
                      onChange={(checked) => onUpdateDir(dir.id, { enabled: checked })}
                    />
                  </div>
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block' }}
                    ellipsis={{ tooltip: dir.dir_path }}
                  >
                    {dir.dir_path}
                  </Text>
                  <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {dir.recursive === 1 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {t('kms.dirRecursive')}
                      </Text>
                    )}
                    {dir.file_extensions && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        {dir.file_extensions}
                      </Text>
                    )}
                  </div>
                </div>
                <Popconfirm
                  title={t('kms.removeDirConfirm')}
                  onConfirm={() => onDeleteDir(dir.id)}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                  />
                </Popconfirm>
              </div>
            </Card>
          ))}
        </Space>
      </div>
    </div>
  )
}

export default KMSDirPanel
