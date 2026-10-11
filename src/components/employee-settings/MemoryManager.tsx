import React, { useState, useEffect, useCallback, useMemo } from 'react'
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
  Spin,
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
  RestOutlined,
} from '@ant-design/icons'
import { getSceneDefaultModel } from '../../utils/default-model'

const { Text, Paragraph } = Typography

type MemoryScope = 'employee' | 'global'

interface MemoryItem {
  id: string
  employee_id: string | null
  scope: MemoryScope
  key: string
  topic: string
  content: string
  is_pinned: number
  source: 'auto' | 'manual'
  importance: 'critical' | 'normal' | 'low'
  created_at: number
  updated_at: number
  last_referenced_at: number | null
  deleted_at: number | null
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

export interface MemoryManagerProps {
  /** 作用域：employee=员工记忆（需 employeeId）；global=全局记忆 */
  scope: MemoryScope
  employeeId?: string
  /** 只读模式（注册员工）：列表只读（开关仍可切换） */
  readonly?: boolean
  /** 是否展示启用开关（仅员工记忆使用） */
  showEnableSwitch?: boolean
  enabled?: boolean
  onEnabledChange?: (enabled: boolean) => void
  /** 卡片标题；不传使用默认「跨任务记忆」 */
  title?: string
  /** 卡片下方说明文案 */
  hint?: string
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

// 常驻注入上限（与后端 employee-memory-types 保持一致）
const MEMORY_ALWAYS_ON_MAX_COUNT = 12
const MEMORY_ALWAYS_ON_MAX_CHARS = 1500
// 记忆库总量上限（仅用于触发精炼，不再约束注入）
const MEMORY_MAX_COUNT = 100
const MEMORY_MAX_CHARS = 8000
const IMPORTANCE_ORDER: Record<MemoryItem['importance'], number> = {
  critical: 0,
  normal: 1,
  low: 2,
}

/**
 * 记忆管理面板（共享组件）：
 * 员工记忆（员工设置抽屉「记忆」Tab）与全局记忆（设置页「记忆」Tab）复用同一套
 * 列表 / 搜索 / 增删改 / 回收站 / 精炼逻辑，仅作用域参数不同。
 */
const MemoryManager: React.FC<MemoryManagerProps> = ({
  scope,
  employeeId,
  readonly,
  showEnableSwitch = false,
  enabled = true,
  onEnabledChange,
  title,
  hint,
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
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashMemories, setTrashMemories] = useState<MemoryItem[]>([])
  const [trashLoading, setTrashLoading] = useState(false)

  /** 作用域参数：全局记忆不带 employee_id */
  const scopeParams = useMemo(
    () => (scope === 'global'
      ? { scope: 'global' as const }
      : { scope: 'employee' as const, employee_id: employeeId }),
    [scope, employeeId]
  )

  const active = showEnableSwitch ? enabled : true

  const loadMemories = useCallback(async () => {
    if (!active) return
    setLoading(true)
    try {
      const [memResult, statsResult] = await Promise.all([
        window.electronAPI.employee.listMemories(scopeParams),
        window.electronAPI.employee.getMemoryStats(scopeParams),
      ])
      setMemories(memResult || [])
      setStats(statsResult || null)
    } catch {
      message.error(t('employeeSettings.memoryLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [active, scopeParams, message, t])

  useEffect(() => {
    if (active) {
      loadMemories()
    }
  }, [loadMemories, active])

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      loadMemories()
      return
    }
    setLoading(true)
    try {
      const result = await window.electronAPI.employee.searchMemories({
        ...scopeParams,
        query: searchQuery,
      })
      setMemories(result || [])
    } catch {
      message.error(t('employeeSettings.memorySearchFailed'))
    } finally {
      setLoading(false)
    }
  }, [scopeParams, searchQuery, loadMemories, message, t])

  const handleAddMemory = useCallback(async (values: any) => {
    try {
      await window.electronAPI.employee.createMemory({
        ...scopeParams,
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
  }, [scopeParams, message, t, addForm, loadMemories])

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
      // 优先使用「记忆提取」场景模型，回退到「工作台」场景模型
      const sceneModel = await getSceneDefaultModel('memory')
        || await getSceneDefaultModel('workbench')
      if (sceneModel?.provider_id) {
        providerId = sceneModel.provider_id
        modelId = sceneModel.model_id
      } else {
        // 最终回退：第一个 provider
        const providers = await window.electronAPI.llm.getProviders()
        const defaultProvider = (providers && providers.length > 0)
          ? providers[0]
          : null
        if (defaultProvider) {
          providerId = defaultProvider.id
          modelId = defaultProvider.model
        }
      }
    } catch {}

    if (!providerId) {
      message.warning(t('employeeSettings.memoryNoProvider'))
      return
    }
    setConsolidating(true)
    try {
      const result = await window.electronAPI.employee.consolidateMemories({
        ...scopeParams,
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
  }, [scopeParams, message, t, loadMemories])

  const loadTrash = useCallback(async () => {
    setTrashLoading(true)
    try {
      const result = await window.electronAPI.employee.listTrashedMemories(scopeParams)
      setTrashMemories(result || [])
    } catch {
      message.error(t('employeeSettings.memoryLoadFailed'))
    } finally {
      setTrashLoading(false)
    }
  }, [scopeParams, message, t])

  const handleRestoreMemory = useCallback(async (id: string) => {
    try {
      await window.electronAPI.employee.restoreMemory(id)
      message.success(t('employeeSettings.memoryRestored'))
      loadTrash()
      loadMemories()
    } catch {
      message.error(t('employeeSettings.operationFailed'))
    }
  }, [message, t, loadTrash, loadMemories])

  const handlePurgeMemory = useCallback((memory: MemoryItem) => {
    modal.confirm({
      title: t('employeeSettings.memoryPurge'),
      content: memory.content,
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.purgeMemory(memory.id)
          message.success(t('employeeSettings.memoryPurged'))
          loadTrash()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [modal, message, t, loadTrash])

  const handleEmptyTrash = useCallback(() => {
    modal.confirm({
      title: t('employeeSettings.memoryEmptyTrash'),
      content: t('employeeSettings.memoryConfirmEmptyTrash'),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.emptyTrash(scopeParams)
          message.success(t('employeeSettings.memoryTrashEmptied'))
          loadTrash()
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [modal, message, t, scopeParams, loadTrash])

  const openTrash = useCallback(() => {
    setTrashOpen(true)
    loadTrash()
  }, [loadTrash])

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

  // 常驻分组：与后端 selectAlwaysOnMemories 同规则（置顶或关键，按置顶/重要性/更新时间取前 12）
  const alwaysOnList = useMemo(() => {
    return memories
      .filter(m => m.is_pinned === 1 || m.importance === 'critical')
      .sort((a, b) => {
        if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned
        if (IMPORTANCE_ORDER[a.importance] !== IMPORTANCE_ORDER[b.importance]) {
          return IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance]
        }
        return b.updated_at - a.updated_at
      })
      .slice(0, MEMORY_ALWAYS_ON_MAX_COUNT)
  }, [memories])
  const onDemandList = useMemo(() => {
    const alwaysOnIds = new Set(alwaysOnList.map(m => m.id))
    return memories.filter(m => !alwaysOnIds.has(m.id))
  }, [memories, alwaysOnList])
  const alwaysOnChars = useMemo(
    () => alwaysOnList.reduce((sum, m) => sum + m.content.length + 3, 0),
    [alwaysOnList]
  )
  const alwaysOnPercent = Math.min(100, Math.round((alwaysOnChars / MEMORY_ALWAYS_ON_MAX_CHARS) * 100))
  const capacityPercent = stats ? Math.min(100, Math.round((stats.totalChars / MEMORY_MAX_CHARS) * 100)) : 0
  const capacityStatus: 'normal' | 'success' | 'exception' | 'active' | undefined = capacityPercent > 80 ? 'exception' : capacityPercent > 60 ? 'active' : 'success'

  const renderMemoryItem = (m: MemoryItem) => (
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
              disabled={readonly}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEditModal(m)}
              disabled={readonly}
            />
          </Tooltip>
          <Tooltip title={t('common.delete')}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() => handleDeleteMemory(m)}
              disabled={readonly}
            />
          </Tooltip>
        </Space>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title={title || t('employeeSettings.memoryTitle')}
        extra={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {showEnableSwitch && (
              <Switch
                checked={enabled}
                onChange={onEnabledChange}
                checkedChildren={t('employeeSettings.memoryOn')}
                unCheckedChildren={t('employeeSettings.memoryOff')}
              />
            )}
            {active && (
              <>
                <Tooltip title={t('employeeSettings.memoryTrashHint')}>
                  <Button icon={<DeleteOutlined />} onClick={openTrash} disabled={readonly}>
                    {t('employeeSettings.memoryTrash')}
                  </Button>
                </Tooltip>
                <Button type="primary" icon={<PlusOutlined />} onClick={openAddModal} disabled={readonly}>
                  {t('employeeSettings.addMemory')}
                </Button>
              </>
            )}
          </div>
        }
      >
        {!active ? (
          <Alert
            type="info"
            title={t('employeeSettings.memoryDisabledHint')}
            showIcon
          />
        ) : (
          <>
            {hint && (
              <Alert
                type="info"
                title={hint}
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}
            {stats && (
              <div style={{
                marginBottom: 16,
                padding: '12px 16px',
                borderRadius: 8,
                border: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
              }}>
                {/* 常驻块：受每轮注入上限约束 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('employeeSettings.memoryAlwaysOnUsage')}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('employeeSettings.memoryUsageValue', {
                      count: alwaysOnList.length,
                      maxCount: MEMORY_ALWAYS_ON_MAX_COUNT,
                      chars: alwaysOnChars,
                      maxChars: MEMORY_ALWAYS_ON_MAX_CHARS,
                    })}
                  </Text>
                </div>
                <Progress percent={alwaysOnPercent} size="small" showInfo={false} style={{ marginBottom: 4 }} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('employeeSettings.memoryAlwaysOnHint')}
                </Text>

                {/* 记忆库：不自动注入，仅受总量上限约束 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 4px' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('employeeSettings.memoryLibraryUsage')}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('employeeSettings.memoryUsageValue', {
                      count: stats.count,
                      maxCount: MEMORY_MAX_COUNT,
                      chars: stats.totalChars,
                      maxChars: MEMORY_MAX_CHARS,
                    })}
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
                    disabled={consolidating || readonly}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <Text strong>{t('employeeSettings.memorySectionAlwaysOn')}</Text>
                    <Tag color="blue" style={{ margin: 0 }}>{alwaysOnList.length}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('employeeSettings.memorySectionAlwaysOnDesc')}
                    </Text>
                  </div>
                  {alwaysOnList.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {alwaysOnList.map(renderMemoryItem)}
                    </div>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('employeeSettings.memorySectionAlwaysOnEmpty')}
                    </Text>
                  )}
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <Text strong>{t('employeeSettings.memorySectionOnDemand')}</Text>
                    <Tag style={{ margin: 0 }}>{onDemandList.length}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('employeeSettings.memorySectionOnDemandDesc')}
                    </Text>
                  </div>
                  {onDemandList.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {onDemandList.map(renderMemoryItem)}
                    </div>
                  ) : (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {t('employeeSettings.memorySectionOnDemandEmpty')}
                    </Text>
                  )}
                </div>
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

      <Modal
        title={t('employeeSettings.memoryTrashTitle')}
        open={trashOpen}
        onCancel={() => setTrashOpen(false)}
        footer={trashMemories.length > 0 ? (
          <Space>
            <Button onClick={() => setTrashOpen(false)}>{t('common.close')}</Button>
            <Button danger icon={<DeleteOutlined />} onClick={handleEmptyTrash}>
              {t('employeeSettings.memoryEmptyTrash')}
            </Button>
          </Space>
        ) : (
          <Button onClick={() => setTrashOpen(false)}>{t('common.close')}</Button>
        )}
        width={640}
      >
        <div style={{ marginBottom: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('employeeSettings.memoryTrashHint')}
          </Text>
        </div>
        {trashLoading ? (
          <div style={{ padding: 24, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : trashMemories.length === 0 ? (
          <Empty description={t('employeeSettings.memoryTrashEmpty')} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 400, overflowY: 'auto' }}>
            {trashMemories.map(m => (
              <div
                key={m.id}
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: token.colorBgContainer,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <Tag color={TOPIC_COLORS[m.topic] || 'default'} style={{ margin: 0 }}>{m.topic}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>{m.key}</Text>
                      {m.deleted_at && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {t('employeeSettings.memoryDeletedAt')}: {new Date(m.deleted_at * 1000).toLocaleString()}
                        </Text>
                      )}
                    </div>
                    <Paragraph style={{ margin: 0 }} ellipsis={{ rows: 2, expandable: true, symbol: t('employeeSettings.expand') }}>
                      {m.content}
                    </Paragraph>
                  </div>
                  <Space size={4} style={{ flexShrink: 0 }}>
                    <Tooltip title={t('employeeSettings.memoryRestore')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<RestOutlined />}
                        onClick={() => handleRestoreMemory(m.id)}
                      />
                    </Tooltip>
                    <Tooltip title={t('employeeSettings.memoryPurge')}>
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => handlePurgeMemory(m)}
                      />
                    </Tooltip>
                  </Space>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  )
}

export default React.memo(MemoryManager)
