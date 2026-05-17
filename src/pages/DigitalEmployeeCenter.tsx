import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Row, Col, Input, Button, Tag, Modal, Select, Space, Typography, Empty, theme, App, Checkbox } from 'antd'
import {
  RobotOutlined,
  PlusOutlined,
  MessageOutlined,
  ThunderboltOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import dayjs from 'dayjs'
import type { Employee } from '../types'
import { EMPLOYEE_STATUS_COLOR_MAP, getEmployeeStatusTextMap } from '../utils/status'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import LLMSelector from '../components/llm/LLMSelector'

const { Text, Title, Paragraph } = Typography

interface RecentConversation {
  id: string
  employee_id: string
  title: string
  message_count: number
  status: string
  created_at: number
  updated_at: number
  employee_name: string | null
}

function formatRelativeTime(timestamp: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const ms = timestamp * 1000
  const now = Date.now()
  const diff = now - ms
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return t('digitalEmployees.justNow')
  if (minutes < 60) return t('digitalEmployees.minutesAgo', { count: minutes })
  if (hours < 24) return t('digitalEmployees.hoursAgo', { count: hours })
  if (days < 7) return t('digitalEmployees.daysAgo', { count: days })
  return dayjs(ms).format('YYYY-MM-DD HH:mm')
}

const AVATAR_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#722ed1',
  '#eb2f96', '#13c2c2', '#faad14', '#f5222d',
]

function getAvatarColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length]
}

const DigitalEmployeeCenter: React.FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [recentConversations, setRecentConversations] = useState<RecentConversation[]>([])
  const [searchText, setSearchText] = useState('')
  const [quickChatOpen, setQuickChatOpen] = useState(false)
  const [quickChatProviderId, setQuickChatProviderId] = useState('')
  const [quickChatModel, setQuickChatModel] = useState('')
  const [quickChatName, setQuickChatName] = useState('')
  const [quickChatKbIds, setQuickChatKbIds] = useState<string[]>([])
  const [kbList, setKbList] = useState<any[]>([])
  const [quickChatLoading, setQuickChatLoading] = useState(false)

  useEffect(() => {
    loadEmployees()
    loadRecentConversations()
    loadKBs()
  }, [])

  useEffect(() => {
    const defaultModel = getCachedSceneDefaultModel('workbench')
    if (defaultModel) {
      setQuickChatProviderId(defaultModel.provider_id)
      setQuickChatModel(defaultModel.model_id)
    }
  }, [])

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
    } catch (error) {
      console.error('Failed to load employees:', error)
      message.error(t('digitalEmployees.loadEmployeesFailed'))
    }
  }

  const loadRecentConversations = async () => {
    try {
      const result = await window.electronAPI.conversation.recentList({ limit: 10 })
      setRecentConversations(result)
    } catch (error) {
      console.error('Failed to load recent conversations:', error)
    }
  }

  const loadKBs = async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setKbList(result)
    } catch (error) {
      console.error('Failed to load knowledge bases:', error)
    }
  }

  const filteredEmployees = useMemo(() => {
    if (!searchText.trim()) return employees
    const lower = searchText.toLowerCase()
    return employees.filter(e => e.name.toLowerCase().includes(lower))
  }, [employees, searchText])

  const statusTextMap = getEmployeeStatusTextMap(t)

  const handleStartQuickChat = async () => {
    if (!quickChatProviderId) {
      message.warning(t('workbench.noLlmProvider'))
      return
    }
    setQuickChatLoading(true)
    try {
      const name = quickChatName.trim() || t('digitalEmployees.quickChatNameDefault')
      const employee = await window.electronAPI.employee.create({
        name,
      })
      await window.electronAPI.employee.update({
        id: employee.id,
        llm_provider_id: quickChatProviderId,
        llm_model: quickChatModel,
        status: 'active',
      })
      for (const kbId of quickChatKbIds) {
        await window.electronAPI.employee.linkKB({ employee_id: employee.id, kb_id: kbId })
      }
      setQuickChatOpen(false)
      navigate(`/employee/${employee.id}`)
    } catch (error) {
      console.error('Failed to create quick chat employee:', error)
      message.error(t('common.createFailed'))
    } finally {
      setQuickChatLoading(false)
    }
  }

  const openQuickChatModal = () => {
    setQuickChatName(t('digitalEmployees.quickChatNameDefault'))
    setQuickChatKbIds([])
    setQuickChatOpen(true)
  }

  const handleDeleteEmployee = (emp: Employee) => {
    let deleteWorkspace = false
    Modal.confirm({
      title: t('digitalEmployees.confirmDelete'),
      content: (
        <div>
          <p>{t('digitalEmployees.deleteDesc')}</p>
          {emp.workspace_path && (
            <Checkbox
              onChange={(e) => { deleteWorkspace = e.target.checked }}
              style={{ marginTop: 8 }}
            >
              {t('digitalEmployees.alsoDeleteWorkspace')}
            </Checkbox>
          )}
        </div>
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.delete({
            id: emp.id,
            delete_workspace: deleteWorkspace,
          })
          setEmployees(employees.filter((e) => e.id !== emp.id))
          message.success(t('digitalEmployees.deleteSuccess'))
        } catch (error) {
          console.error('Failed to delete employee:', error)
          message.error(t('digitalEmployees.deleteFailed'))
        }
      },
    })
  }

  if (employees.length === 0 && !searchText) {
    return (
      <div style={{ padding: '16px 24px 24px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty
          image={<RobotOutlined style={{ fontSize: 64, color: token.colorTextDisabled }} />}
          description={
            <div>
              <Paragraph style={{ marginBottom: 8, fontSize: 16, fontWeight: 500 }}>
                {t('digitalEmployees.noEmployees')}
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 13 }}>
                {t('digitalEmployees.noEmployeesDesc')}
              </Text>
            </div>
          }
        >
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/wizard')}>
              {t('digitalEmployees.createFirstEmployee')}
            </Button>
            <Button icon={<ThunderboltOutlined />} onClick={openQuickChatModal}>
              {t('digitalEmployees.quickChat')}
            </Button>
          </Space>
        </Empty>

        <Modal
          open={quickChatOpen}
          title={t('digitalEmployees.quickChatModal')}
          okText={t('digitalEmployees.startChat')}
          cancelText={t('common.cancel')}
          onOk={handleStartQuickChat}
          onCancel={() => setQuickChatOpen(false)}
          confirmLoading={quickChatLoading}
          width={480}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
            <Text type="secondary">{t('digitalEmployees.quickChatDesc')}</Text>
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatModel')}</div>
              <LLMSelector
                providerId={quickChatProviderId}
                modelId={quickChatModel}
                onProviderChange={setQuickChatProviderId}
                onModelChange={setQuickChatModel}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatKb')}</div>
              <Select
                mode="multiple"
                style={{ width: '100%' }}
                placeholder={t('digitalEmployees.quickChatKb')}
                value={quickChatKbIds}
                onChange={setQuickChatKbIds}
                options={kbList.map((kb: any) => ({ value: kb.id, label: kb.name }))}
                allowClear
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatName')}</div>
              <Input
                value={quickChatName}
                onChange={e => setQuickChatName(e.target.value)}
                placeholder={t('digitalEmployees.quickChatNameDefault')}
              />
            </div>
          </div>
        </Modal>
      </div>
    )
  }

  return (
    <div style={{ padding: '16px 24px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>{t('digitalEmployees.title')}</Title>
          <Text type="secondary">{t('digitalEmployees.subtitle')}</Text>
        </div>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={openQuickChatModal}>
          {t('digitalEmployees.quickChat')}
        </Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Input.Search
          placeholder={t('digitalEmployees.searchPlaceholder')}
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          onSearch={value => setSearchText(value)}
          style={{ maxWidth: 320 }}
          allowClear
        />
        <Button icon={<PlusOutlined />} onClick={() => navigate('/wizard')}>
          {t('digitalEmployees.createEmployee')}
        </Button>
      </div>

      {recentConversations.length > 0 && (
        <Card
          title={t('digitalEmployees.recentConversations')}
          style={{ marginBottom: 24 }}
          styles={{ body: { padding: '0 16px' } }}
        >
          {recentConversations.map(conv => (
            <div
              key={conv.id}
              onClick={() => navigate(`/employee/${conv.employee_id}`)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 0',
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
                cursor: 'pointer',
                transition: 'background 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = token.colorBgTextHover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: token.colorPrimaryBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <MessageOutlined style={{ fontSize: 16, color: token.colorPrimary }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                    <Text strong style={{ fontSize: 14 }}>{conv.employee_name || t('common.noDescription')}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block' }} ellipsis>
                    {conv.title || t('common.noDescription')}
                  </Text>
                </div>
              </div>
              <Text type="secondary" style={{ fontSize: 12, flexShrink: 0, marginLeft: 12 }}>
                {formatRelativeTime(conv.updated_at, t)}
              </Text>
            </div>
          ))}
        </Card>
      )}

      <div style={{ marginBottom: 12 }}>
        <Title level={5} style={{ marginBottom: 0 }}>{t('digitalEmployees.myEmployees')}</Title>
      </div>
      <Row gutter={[16, 16]}>
        {filteredEmployees.map((emp, index) => (
          <Col key={emp.id} xs={24} sm={12} md={8} lg={6}>
            <Card
              hoverable
              onClick={() => navigate(`/employee/${emp.id}`)}
              style={{ height: '100%' }}
              styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', height: '100%' } }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: `${getAvatarColor(index)}15`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <RobotOutlined style={{ fontSize: 22, color: getAvatarColor(index) }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <Text strong ellipsis style={{ fontSize: 14, flex: 1, minWidth: 0 }}>{emp.name}</Text>
                    <Tag color={EMPLOYEE_STATUS_COLOR_MAP[emp.status]} style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', flexShrink: 0 }}>
                      {statusTextMap[emp.status]}
                    </Tag>
                  </div>
                  <Paragraph
                    type="secondary"
                    style={{ fontSize: 12, marginBottom: 0 }}
                    ellipsis={{ rows: 2, tooltip: emp.description || t('common.noDescription') }}
                  >
                    {emp.description || t('common.noDescription')}
                  </Paragraph>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto', paddingTop: 8 }}>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteEmployee(emp)
                  }}
                />
              </div>
            </Card>
          </Col>
        ))}
        <Col xs={24} sm={12} md={8} lg={6}>
          <Card
            hoverable
            onClick={() => navigate('/wizard')}
            style={{
              height: '100%',
              borderStyle: 'dashed',
              borderColor: token.colorBorder,
            }}
            styles={{ body: { padding: 16 } }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 80 }}>
              <PlusOutlined style={{ fontSize: 24, color: token.colorTextSecondary, marginBottom: 8 }} />
              <Text type="secondary">{t('digitalEmployees.newEmployeeCard')}</Text>
            </div>
          </Card>
        </Col>
      </Row>

      <Modal
        open={quickChatOpen}
        title={t('digitalEmployees.quickChatModal')}
        okText={t('digitalEmployees.startChat')}
        cancelText={t('common.cancel')}
        onOk={handleStartQuickChat}
        onCancel={() => setQuickChatOpen(false)}
        confirmLoading={quickChatLoading}
        width={480}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
          <Text type="secondary">{t('digitalEmployees.quickChatDesc')}</Text>
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatModel')}</div>
            <LLMSelector
              providerId={quickChatProviderId}
              modelId={quickChatModel}
              onProviderChange={setQuickChatProviderId}
              onModelChange={setQuickChatModel}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatKb')}</div>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder={t('digitalEmployees.quickChatKb')}
              value={quickChatKbIds}
              onChange={setQuickChatKbIds}
              options={kbList.map((kb: any) => ({ value: kb.id, label: kb.name }))}
              allowClear
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{t('digitalEmployees.quickChatName')}</div>
            <Input
              value={quickChatName}
              onChange={e => setQuickChatName(e.target.value)}
              placeholder={t('digitalEmployees.quickChatNameDefault')}
            />
          </div>
        </div>
      </Modal>
    </div>
  )
}

export default DigitalEmployeeCenter
