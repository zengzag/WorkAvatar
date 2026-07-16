import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Empty, Spin, Space, Tag, Input, App, Typography, theme, Tooltip,
} from 'antd'
import {
  DeleteOutlined, PlusOutlined, ReloadOutlined, ClearOutlined,
} from '@ant-design/icons'

const { Text, Paragraph } = Typography

interface StopWord {
  id: string
  word: string
  source: string
  created_at: number
}

const KMSStopWordsPanel: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()

  const [words, setWords] = useState<StopWord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filterSource, setFilterSource] = useState<'all' | 'manual' | 'auto_idf'>('all')
  const [newWord, setNewWord] = useState('')
  const [adding, setAdding] = useState(false)

  const loadWords = useCallback(async () => {
    setLoading(true)
    try {
      const params = filterSource !== 'all' ? { source: filterSource as 'manual' | 'auto_idf', limit: 500 } : { limit: 500 }
      const result = await window.electronAPI.kms.getStopWords(params)
      if (result) {
        setWords(result.words || [])
        setTotal(result.total || 0)
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed to load stop words')
    } finally {
      setLoading(false)
    }
  }, [filterSource, message])

  useEffect(() => {
    loadWords()
  }, [loadWords])

  const handleAdd = useCallback(async () => {
    const w = newWord.trim()
    if (!w) return
    setAdding(true)
    try {
      const result = await window.electronAPI.kms.addStopWord(w)
      if (result?.success) {
        message.success(t('kms.stopWords.addSuccess'))
        setNewWord('')
        loadWords()
      } else {
        message.error(result?.error || 'Failed')
      }
    } catch (err: any) {
      message.error(err?.message || 'Failed')
    } finally {
      setAdding(false)
    }
  }, [newWord, t, message, loadWords])

  const handleDelete = useCallback((id: string, word: string) => {
    modal.confirm({
      title: t('kms.stopWords.deleteConfirm'),
      content: word,
      okText: t('common.delete'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          await window.electronAPI.kms.deleteStopWord(id)
          message.success(t('kms.stopWords.deleteSuccess'))
          loadWords()
        } catch (err: any) {
          message.error(err?.message || 'Failed')
        }
      },
    })
  }, [t, message, modal, loadWords])

  const handleClearAuto = useCallback(() => {
    modal.confirm({
      title: t('kms.stopWords.clearAutoConfirm'),
      okText: t('common.confirm'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        try {
          const result = await window.electronAPI.kms.clearAutoStopWords()
          if (result?.success) {
            message.success(t('kms.stopWords.clearAutoSuccess', { count: result.cleared || 0 }))
            loadWords()
          }
        } catch (err: any) {
          message.error(err?.message || 'Failed')
        }
      },
    })
  }, [t, message, modal, loadWords])

  return (
    <div>
      {/* 标题 */}
      <div style={{ marginBottom: 12 }}>
        <Space>
          <DeleteOutlined style={{ color: token.colorPrimary }} />
          <Text strong style={{ fontSize: 14 }}>{t('kms.stopWords.title')}</Text>
          {total > 0 && (
            <Tag color="blue" style={{ fontSize: 10 }}>{t('kms.stopWords.count', { count: total })}</Tag>
          )}
        </Space>
        <Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>
          {t('kms.stopWords.subtitle')}
        </Paragraph>
      </div>

      {/* 添加 + 过滤 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input.Search
          placeholder={t('kms.stopWords.addPlaceholder')}
          value={newWord}
          onChange={e => setNewWord(e.target.value)}
          onSearch={handleAdd}
          enterButton={
            <span>
              <PlusOutlined /> {t('kms.stopWords.addWord')}
            </span>
          }
          loading={adding}
          style={{ width: 280 }}
        />
        {filterSource !== 'all' && (
          <Tag
            closable
            onClose={() => setFilterSource('all')}
            style={{ lineHeight: '20px' }}
          >
            {filterSource === 'manual' ? t('kms.stopWords.sourceManual') : t('kms.stopWords.sourceAutoIdf')}
          </Tag>
        )}
        <div style={{ flex: 1 }} />
        <Tooltip title={t('kms.stopWords.clearAuto')}>
          <Button
            icon={<ClearOutlined />}
            onClick={handleClearAuto}
            size="small"
          >
            {t('kms.stopWords.clearAuto')}
          </Button>
        </Tooltip>
        <Button
          icon={<ReloadOutlined />}
          onClick={loadWords}
          loading={loading}
          size="small"
        >
          {t('common.refresh')}
        </Button>
      </div>

      {/* 停用词列表 */}
      <div style={{ minHeight: 200 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin />
          </div>
        ) : words.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={t('kms.stopWords.noWords')}
            style={{ marginTop: 40 }}
          />
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {words.map(w => (
              <Tag
                key={w.id}
                closable
                onClose={(e) => { e.preventDefault(); handleDelete(w.id, w.word) }}
                color={w.source === 'auto_idf' ? 'blue' : undefined}
                style={{ fontSize: 13, padding: '4px 8px', lineHeight: '20px' }}
              >
                {w.word}
                <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>
                  {w.source === 'auto_idf' ? t('kms.stopWords.sourceAutoIdf') : t('kms.stopWords.sourceManual')}
                </Text>
              </Tag>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default KMSStopWordsPanel
