import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  Button,
  Empty,
  Typography,
  App,
  Modal,
  Form,
  Input,
  Tag,
  Space,
  Tooltip,
  Switch,
  Alert,
  Progress,
  Select,
  theme,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  PushpinOutlined,
  PushpinFilled,
  EditOutlined,
  SearchOutlined,
  CompressOutlined,
} from '@ant-design/icons'
import type { LLMProvider } from '../../types'

const { Text, Paragraph } = Typography

interface MemoryItem {
  id: string
  employee_id: string
  key: string
  topic: string
  content: string
  is_pinned: number
  source: 'auto' | 'manual'
  importance: 'critical' | 'normal' | 'low'
  created_at: number
  updated_at: number
  last_referenced_at: number | null
}

interface MemoryStats {
  count: number
  totalChars: number
  pinnedCount: number
  autoCount: number
  manualCount: number
  oldestTimestamp: number | null
  staleCount: number
}

interface MemorySectionProps {
  employeeId: string
  memoryEnabled: boolean
  onMemoryEnabledChange: (enabled: boolean) => void
}

// 记忆主题常量（值为后端 LLM 提取时写入的中文标识）
const MEMORY_TOPIC = {
  USER_PREFERENCE: '用户偏好',
  DECISION: '决策结论',
  FACT: '事实知识',
} as const

// 主题对应的标签颜色
const TOPIC_COLORS: Record<string, string> = {
  [MEMORY_TOPIC.USER_PREFERENCE]: 'blue',
  [MEMORY_TOPIC.DECISION]: 'green',
  [MEMORY_TOPIC.FACT]: 'orange',
}

// 跨任务记忆总字符上限（与后端 memory 服务保持一致）
const MEMORY_CAPACITY_LIMIT = 8000

const MemorySection: React.FC<MemorySectionProps> = ({
  employeeId,
  memoryEnabled,
  onMemoryEnabledChange,
}) => {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { token } = theme.useToken()
  const [memories, setMemories] = useState<MemoryItem[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)
  const [editingMemory, setEditingMemory] = useState<MemoryItem | null>(null)
  const [addForm] = Form.useForm()

  const loadMemories = useCallback(async () => {
    if (!memoryEnabled) return
    setLoading(true)
    try {
      const [memResult, statsResult] = await Promise.all([
        window.electronAPI.employee.listMemories({ employee_id: employeeId }),
        window.electronAPI.employee.getMemoryStats({ employee_id: employeeId }),
      ])
      setMemories(memResult || [])
      setStats(statsResult || null)
    } catch {
      message.error(t('employeeSettings.memoryLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [employeeId, memoryEnabled, message, t])

  useEffect(() => {
    if (memoryEnabled) {
      loadMemories()
    }
  }, [loadMemories, memoryEnabled])

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      loadMemories()
      return
    }
    setLoading(true)
    try {
      const result = await window.electronAPI.employee.searchMemories({
        employee_id: employeeId,
        query: searchQuery,
      })
      setMemories(result || [])
    } catch {
      message.error(t('employeeSettings.memorySearchFailed'))
    } finally {
      setLoading(false)
    }
  }, [employeeId, searchQuery, loadMemories, message, t])

  const handleAddMemory = useCallback(async (values: any) => {
    try {
      await window.electronAPI.employee.createMemory({
        employee_id: employeeId,
        key: values.key,
        topic: values.topic,
        content: values.content,
        source: 'manual',
        importance: values.importance || 'normal',
      })
      message.success(t('employeeSettings.memoryCreated'))
      setIsAddModalOpen(false)
      addForm.resetFields()
      loadMemories()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [employeeId, message, t, addForm, loadMemories])

  const handleEditMemory = useCallback(async (values: any) => {
    if (!editingMemory) return
    try {
      await window.electronAPI.employee.updateMemory({
        id: editingMemory.id,
        key: values.key,
        topic: values.topic,
        content: values.content,
        importance: values.importance,
      })
      message.success(t('employeeSettings.memoryUpdated'))
      setEditingMemory(null)
      addForm.resetFields()
      loadMemories()
    } catch {
      message.error(t('common.saveFailed'))
    }
  }, [editingMemory, message, t, addForm, loadMemories])

  const handleDeleteMemory = useCallback((memory: MemoryItem) => {
    modal.confirm({
      title: t('employeeSettings.confirmDeleteMemory'),
      content: memory.content,
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.deleteMemory(memory.id)
          message.success(t('common.deleted'))
          loadMemories()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [modal, message, t, loadMemories])

  const handleTogglePin = useCallback(async (memory: MemoryItem) => {
    try {
      await window.electronAPI.employee.togglePinMemory(memory.id)
      message.success(memory.is_pinned ? t('employeeSettings.memoryUnpinned') : t('employeeSettings.memoryPinned'))
      loadMemories()
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }, [message, t, loadMemories])

  const handleConsolidate = useCallback(async () => {
    let providerId: string | undefined
    let modelId: string | undefined
    try {
      const providers = await window.electronAPI.llm.getProviders()
      const defaultProvider = (providers && providers.length > 0)
        ? (providers.find((p: LLMProvider) => p.is_default) || providers[0])
        : null
      if (defaultProvider) {
        providerId = defaultProvider.id
        modelId = defaultProvider.model
      }
    } catch {}

    if (!providerId) {
      message.warning(t('employeeSettings.memoryNoProvider'))
      return
    }
    setConsolidating(true)
    try {
      const result = await window.electronAPI.employee.consolidateMemories({
        employee_id: employeeId,
        provider_id: providerId,
        model_id: modelId,
      })
      if (result.success) {
        const { deleted, merged, simplified } = result
        message.success(
          t('employeeSettings.memoryConsolidated', { deleted, merged, simplified })
        )
        loadMemories()
      } else {
        message.error(result.error || t('employeeSettings.memoryConsolidateFailed'))
      }
    } catch {
      message.error(t('employeeSettings.memoryConsolidateFailed'))
    } finally {
      setConsolidating(false)
    }
  }, [employeeId, message, t, loadMemories])

  const openAddModal = useCallback(() => {
    setEditingMemory(null)
    addForm.resetFields()
    setIsAddModalOpen(true)
  }, [addForm])

  const openEditModal = useCallback((memory: MemoryItem) => {
    setEditingMemory(memory)
    addForm.setFieldsValue({
      key: memory.key,
      topic: memory.topic,
      content: memory.content,
      importance: memory.importance,
    })
    setIsAddModalOpen(true)
  }, [addForm])

  const handleModalOk = useCallback(async () => {
    try {
      const values = await addForm.validateFields()
      if (editingMemory) {
        await handleEditMemory(values)
      } else {
        await handleAddMemory(values)
      }
    } catch {}
  }, [addForm, editingMemory, handleEditMemory, handleAddMemory])

  const capacityPercent = stats ? Math.min(100, Math.round((stats.totalChars / MEMORY_CAPACITY_LIMIT) * 100)) : 0
  const capacityStatus: 'normal' | 'success' | 'exception' | 'active' | undefined = capacityPercent > 80 ? 'exception' : capacityPercent > 60 ? 'active' : 'success'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={t('employeeSettings.memoryTitle')}
        extra={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Switch
              checked={memoryEnabled}
              onChange={onMemoryEnabledChange}
              checkedChildren={t('employeeSettings.memoryOn')}
              unCheckedChildren={t('employeeSettings.memoryOff')}
            />
            {memoryEnabled && (
              <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal}>
                {t('employeeSettings.addMemory')}
              </Button>
            )}
          </div>
        }
      >
        {!memoryEnabled ? (
          <Alert
            type="info"
            title={t('employeeSettings.memoryDisabledHint')}
            showIcon
          />
        ) : (
          <>
            {stats && (
              <div style={{
                marginBottom: 16,
                padding: '12px 16px',
                borderRadius: 8,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('employeeSettings.memoryCapacity')}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {stats.totalChars} / {MEMORY_CAPACITY_LIMIT}
                  </Text>
                </div>
                <Progress
                  percent={capacityPercent}
                  status={capacityStatus}
                  size="small"
                  style={{ marginBottom: 8 }}
                />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Tag>{t('employeeSettings.memoryCount', { count: stats.count })}</Tag>
                  <Tag color="blue">{t('employeeSettings.memoryPinnedCount', { count: stats.pinnedCount })}</Tag>
                  <Tag color="orange">{t('employeeSettings.memoryAutoCount', { count: stats.autoCount })}</Tag>
                  <Tag color="purple">{t('employeeSettings.memoryManualCount', { count: stats.manualCount })}</Tag>
                  {stats.staleCount > 0 && (
                    <Tag color="red">{t('employeeSettings.memoryStaleCount', { count: stats.staleCount })}</Tag>
                  )}
                  <Button
                    size="small"
                    icon={<CompressOutlined />}
                    onClick={handleConsolidate}
                    loading={consolidating}
                    disabled={consolidating}
                  >
                    {t('employeeSettings.consolidateMemories')}
                  </Button>
                </div>
              </div>
            )}

            <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
              <Input
                placeholder={t('employeeSettings.searchMemory')}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onPressEnter={handleSearch}
                prefix={<SearchOutlined />}
                allowClear
                onClear={() => { setSearchQuery(''); loadMemories() }}
              />
              <Button onClick={handleSearch} loading={loading}>
                {t('employeeSettings.searchMemoryBtn')}
              </Button>
            </div>

            {memories.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {memories.map(m => (
                  <div
                    key={m.id}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 8,
                      border: `1px solid ${m.is_pinned ? token.colorPrimary : token.colorBorderSecondary}`,
                      background: m.is_pinned ? token.colorPrimaryBg : token.colorBgContainer,
                      transition: 'all 0.2s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                          <Tag color={TOPIC_COLORS[m.topic] || 'default'} style={{ margin: 0 }}>
                            {m.topic}
                          </Tag>
                          {m.source === 'auto' && (
                            <Tag style={{ margin: 0 }}>{t('employeeSettings.memorySourceAuto')}</Tag>
                          )}
                          {m.source === 'manual' && (
                            <Tag color="purple" style={{ margin: 0 }}>{t('employeeSettings.memorySourceManual')}</Tag>
                          )}
                          {m.importance === 'critical' && (
                            <Tag color="red" style={{ margin: 0 }}>{t('employeeSettings.memoryImportanceCritical')}</Tag>
                          )}
                          {m.importance === 'low' && (
                            <Tag style={{ margin: 0 }}>{t('employeeSettings.memoryImportanceLow')}</Tag>
                          )}
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {m.key}
                          </Text>
                        </div>
                        <Paragraph style={{ margin: 0 }} ellipsis={{ rows: 3, expandable: true, symbol: t('employeeSettings.expand') }}>
                          {m.content}
                        </Paragraph>
                      </div>
                      <Space size={4} style={{ flexShrink: 0 }}>
                        <Tooltip title={m.is_pinned ? t('employeeSettings.unpinMemory') : t('employeeSettings.pinMemory')}>
                          <Button
                            type="text"
                            size="small"
                            icon={m.is_pinned ? <PushpinFilled style={{ color: token.colorPrimary }} /> : <PushpinOutlined />}
                            onClick={() => handleTogglePin(m)}
                          />
                        </Tooltip>
                        <Tooltip title={t('common.edit')}>
                          <Button
                            type="text"
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => openEditModal(m)}
                          />
                        </Tooltip>
                        <Tooltip title={t('common.delete')}>
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => handleDeleteMemory(m)}
                          />
                        </Tooltip>
                      </Space>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description={t('employeeSettings.noMemories')} />
            )}
          </>
        )}
      </Card>

      <Modal
        title={editingMemory ? t('employeeSettings.editMemory') : t('employeeSettings.addMemory')}
        open={isAddModalOpen}
        onOk={handleModalOk}
        onCancel={() => { setIsAddModalOpen(false); setEditingMemory(null); addForm.resetFields() }}
        okText={editingMemory ? t('common.save') : t('common.add')}
        cancelText={t('common.cancel')}
      >
        <Form form={addForm} layout="vertical">
          <Form.Item
            name="key"
            label={t('employeeSettings.memoryKey')}
            rules={[{ required: true, message: t('employeeSettings.memoryKeyRequired') }]}
          >
            <Input placeholder={t('employeeSettings.memoryKeyPlaceholder')} disabled={!!editingMemory} />
          </Form.Item>
          <Form.Item
            name="topic"
            label={t('employeeSettings.memoryTopic')}
            rules={[{ required: true, message: t('employeeSettings.memoryTopicRequired') }]}
          >
            <Input placeholder={t('employeeSettings.memoryTopicPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="content"
            label={t('employeeSettings.memoryContent')}
            rules={[{ required: true, message: t('employeeSettings.memoryContentRequired') }]}
          >
            <Input.TextArea rows={4} placeholder={t('employeeSettings.memoryContentPlaceholder')} />
          </Form.Item>
          <Form.Item
            name="importance"
            label={t('employeeSettings.memoryImportance')}
            initialValue="normal"
          >
            <Select>
              <Select.Option value="critical">{t('employeeSettings.memoryImportanceCritical')}</Select.Option>
              <Select.Option value="normal">{t('employeeSettings.memoryImportanceNormal')}</Select.Option>
              <Select.Option value="low">{t('employeeSettings.memoryImportanceLow')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default React.memo(MemorySection)
