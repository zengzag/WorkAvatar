import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Typography, Space, Select, Tag, App, theme } from 'antd'
import { SafetyOutlined } from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface IndexDir {
  id: string
  dir_path: string
  display_name: string
  enabled: number
}

interface ExcludedFile {
  id: string
  fileName: string
  filePath: string
  level: number
}

interface KMSSensitiveControlCardProps {
  /** 当前全部索引目录（选择排除级别） */
  dirs: IndexDir[]
}

/**
 * 敏感内容控制卡片（AI 排除级别）：
 * - 目录级：Select 设置 ai_exclusion_level（0 完全参与 / 1 仅手动处理 / 2 完全排除）
 * - 文件级：列出已排除的文件（在文件预览中设置），可移回
 * level >= 2 的文件/目录不参与任何搜索、MCP、Agent 数据供给。
 */
const KMSSensitiveControlCard: React.FC<KMSSensitiveControlCardProps> = ({ dirs }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [excludedFiles, setExcludedFiles] = useState<ExcludedFile[]>([])
  const [dirLevels, setDirLevels] = useState<Record<string, number>>({})

  const loadExclusions = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.listAiExclusions()
      if (result && !result.error) {
        setExcludedFiles(Array.isArray(result.files) ? result.files : [])
        const levels: Record<string, number> = {}
        for (const d of (Array.isArray(result.dirs) ? result.dirs : [])) levels[d.id] = d.level
        setDirLevels(levels)
      }
    } catch (err) {
      console.error('Failed to load AI exclusions:', err)
    }
  }, [])

  useEffect(() => { loadExclusions() }, [dirs, loadExclusions])

  const handleDirLevelChange = useCallback(async (dirId: string, level: number) => {
    try {
      await window.electronAPI.kms.setDirAiExclusion({ dirId, level: level as 0 | 1 | 2 })
      setDirLevels(prev => ({ ...prev, [dirId]: level }))
      message.success(t(level >= 2 ? 'kms.sensitive.dirExcluded' : 'kms.sensitive.saved'))
      if (level >= 2) loadExclusions()
    } catch (err: any) {
      console.error('Failed to set dir AI exclusion:', err)
      message.error(t('kms.sensitive.saveFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [message, t, loadExclusions])

  const handleFileLevelChange = useCallback(async (fileId: string, level: number) => {
    try {
      await window.electronAPI.kms.setFileAiExclusion({ fileId, level: level as 0 | 1 | 2 })
      message.success(t(level >= 2 ? 'kms.sensitive.fileExcluded' : 'kms.sensitive.saved'))
      if (level === 0) {
        setExcludedFiles(prev => prev.filter(f => f.id !== fileId))
      } else {
        setExcludedFiles(prev => prev.map(f => (f.id === fileId ? { ...f, level } : f)))
      }
    } catch (err: any) {
      console.error('Failed to set file AI exclusion:', err)
      message.error(t('kms.sensitive.saveFailed') + (err?.message ? `: ${err.message}` : ''))
    }
  }, [message, t])

  const levelOptions = [
    { value: 0, label: t('kms.sensitive.level0') },
    { value: 1, label: t('kms.sensitive.level1') },
    { value: 2, label: t('kms.sensitive.level2') },
  ]

  return (
    <div>
      <Space size={8} style={{ marginBottom: 4 }}>
        <SafetyOutlined style={{ color: token.colorWarning }} />
        <Text strong style={{ fontSize: 14 }}>{t('kms.sensitive.title')}</Text>
      </Space>
      <Paragraph type="secondary" style={{ margin: '0 0 12px', fontSize: 12 }}>
        {t('kms.sensitive.desc')}
      </Paragraph>

      <div style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 12, fontWeight: 500, display: 'block', marginBottom: 8 }}>
          {t('kms.sensitive.dirLevel')}
        </Text>
        {dirs.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.sensitive.noDirs')}</Text>
        ) : (
          dirs.map(dir => (
            <div
              key={dir.id}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}
            >
              <Text style={{ fontSize: 12, minWidth: 0 }} ellipsis={{ tooltip: dir.dir_path }}>
                {dir.display_name || dir.dir_path.split(/[/\\]/).pop()}
              </Text>
              <Select
                size="small"
                style={{ width: 150, flexShrink: 0 }}
                value={dirLevels[dir.id] ?? 0}
                onChange={(v) => handleDirLevelChange(dir.id, v)}
                options={levelOptions}
              />
            </div>
          ))
        )}
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: 500 }}>{t('kms.sensitive.fileLevel')}</Text>
          {excludedFiles.length > 0 && (
            <Tag color="orange" style={{ fontSize: 10, margin: 0, lineHeight: '16px', padding: '0 5px' }}>
              {excludedFiles.length}
            </Tag>
          )}
        </div>
        {excludedFiles.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>{t('kms.sensitive.noFiles')}</Text>
        ) : (
          <div>
            {excludedFiles.map(file => (
              <div key={file.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <Text style={{ fontSize: 12, minWidth: 0 }} ellipsis={{ tooltip: file.filePath }}>
                  {file.fileName}
                </Text>
                <Select
                  size="small"
                  style={{ width: 150, flexShrink: 0 }}
                  value={file.level}
                  onChange={(v) => handleFileLevelChange(file.id, v)}
                  options={levelOptions}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default KMSSensitiveControlCard
