import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button,
  Space,
  Typography,
  Tag,
  Spin,
  Tooltip,
  theme,
  App,
  Dropdown,
} from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DatabaseOutlined,
  BulbOutlined,
  BulbFilled,
  PlusOutlined,
} from '@ant-design/icons'
import LLMSelector from '../components/llm/LLMSelector'
import { ConversationSidebar, MessageBubble, ChatInput } from '../components/workbench'
import { useTranslation } from 'react-i18next'
import useEmployeeChat from '../hooks/useEmployeeChat'
import type { Employee } from '../types'

const { Text, Paragraph } = Typography

const AVATAR_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#722ed1',
  '#eb2f96', '#13c2c2', '#faad14', '#f5222d',
]

const EmployeeWorkbench: React.FC = () => {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { id: routeId } = useParams<{ id: string }>()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeListLoaded, setEmployeeListLoaded] = useState(false)

  useEffect(() => {
    loadEmployees()
  }, [])

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
      setEmployeeListLoaded(true)
    } catch {
      message.error(t('digitalEmployees.loadEmployeesFailed'))
    }
  }

  const isEmptyRoute = routeId === '_empty'
  const id = isEmptyRoute ? undefined : routeId

  useEffect(() => {
    if (id) {
      localStorage.setItem('employeeWorkbench:lastEmployeeId', id)
    }
  }, [id])

  const chatHook = useEmployeeChat({ id, message })

  const {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    inputValue,
    setInputValue,
    isStreaming,
    selectedLlmProviderId,
    setSelectedLlmProviderId,
    selectedLlmModelId,
    setSelectedLlmModelId,
    enableThinking,
    setEnableThinking,
    showSidePanel,
    setShowSidePanel,
    editingConversationId,
    editingTitle,
    setEditingTitle,
    messagesEndRef,
    chatContainerRef,
    handleScroll,
    handleSend,
    handleStop,
    selectConversation,
    deleteConversation,
    deleteSelectedConversations,
    startEditTitle,
    saveEditTitle,
    cancelEditTitle,
    handleEditKeyDown,
    startNewConversation,
    loadMoreConversations,
    handleConversationListScroll,
    handleCopy,
    handleDeleteMessage,
    handleToggleSegment,
    getToolDisplayName,
    isConversationStreaming,
  } = chatHook

  const handleEmployeeChange = (newEmployeeId: string) => {
    if (newEmployeeId === 'create-new') {
      navigate('/wizard')
      return
    }
    navigate(`/employee/${newEmployeeId}`)
  }

  if (!employeeListLoaded) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (employees.length === 0) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
        <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary }} />
        <Paragraph type="secondary" style={{ fontSize: 14 }}>{t('workbench.noEmployeeHint')}</Paragraph>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/wizard')}>
          {t('workbench.createEmployee')}
        </Button>
      </div>
    )
  }

  if (!employee && id) {
    const firstEmployee = employees[0]
    if (firstEmployee) {
      navigate(`/employee/${firstEmployee.id}`, { replace: true })
    }
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (!employee) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  const employeeSelectItems = [
    ...employees.map((emp, index) => ({
      key: emp.id,
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 24, height: 24, borderRadius: 6,
            background: `${AVATAR_COLORS[index % AVATAR_COLORS.length]}15`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <RobotOutlined style={{ fontSize: 12, color: AVATAR_COLORS[index % AVATAR_COLORS.length] }} />
          </div>
          <span>{emp.name}</span>
          {emp.id === id && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginLeft: 4 }}>Active</Tag>}
        </div>
      ),
      onClick: () => handleEmployeeChange(emp.id),
    })),
    { type: 'divider' as const },
    {
      key: 'create-new',
      label: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: token.colorPrimary }}>
          <PlusOutlined />
          <span>{t('workbench.createEmployee')}</span>
        </div>
      ),
      onClick: () => handleEmployeeChange('create-new'),
    },
  ]

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: token.colorBgContainer }}>
      <div style={{
        height: 48,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}>
        <Space size={12}>
          <Tooltip title={showSidePanel ? t('workbench.closePanel') : t('workbench.historyConv')}>
            <Button type="text"
              icon={showSidePanel ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setShowSidePanel(!showSidePanel)}
            />
          </Tooltip>
          <Dropdown menu={{ items: employeeSelectItems }} trigger={['click']}>
            <Button type="text" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', height: 'auto' }}>
              <div style={{
                width: 26, height: 26, borderRadius: 6,
                background: `${token.colorPrimary}15`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <RobotOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
              </div>
              <Text strong style={{ fontSize: 14 }}>{employee.name}</Text>
              <Tag color={employee.status === 'active' ? 'green' : employee.status === 'paused' ? 'orange' : 'default'}
                style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
                {employee.status === 'active' ? t('workbench.statusRunning') : employee.status === 'paused' ? t('workbench.statusPaused') : t('workbench.statusDraft')}
              </Tag>
            </Button>
          </Dropdown>
        </Space>
        <Space size={4}>
          <LLMSelector
            providerId={selectedLlmProviderId}
            modelId={selectedLlmModelId}
            onProviderChange={setSelectedLlmProviderId}
            onModelChange={setSelectedLlmModelId}
          />
          <Tooltip title={enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
            <Button
              type={enableThinking ? 'primary' : 'text'}
              icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
              size="small"
              onClick={() => setEnableThinking(!enableThinking)}
              style={enableThinking ? {} : { color: token.colorTextSecondary }}
            />
          </Tooltip>
          <Tooltip title={t('workbench.employeeConfig')}>
            <Button type="text" icon={<SettingOutlined />}
              onClick={() => navigate(`/employee/${id}/settings`)} />
          </Tooltip>
        </Space>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {showSidePanel && (
          <ConversationSidebar
            conversations={conversations}
            allConversations={allConversations}
            activeConversationId={activeConversationId}
            editingConversationId={editingConversationId}
            editingTitle={editingTitle}
            onSelect={selectConversation}
            onStartEdit={startEditTitle}
            onSaveEdit={saveEditTitle}
            onCancelEdit={cancelEditTitle}
            onEditTitleChange={(e) => setEditingTitle(e.target.value)}
            onEditKeyDown={handleEditKeyDown}
            onDelete={deleteConversation}
            onDeleteSelected={deleteSelectedConversations}
            onNewConversation={startNewConversation}
            onLoadMore={loadMoreConversations}
            onListScroll={handleConversationListScroll}
            isConversationStreaming={isConversationStreaming}
          />
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div ref={chatContainerRef} onScroll={handleScroll}
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '24px 10%',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}
          >
            {messages.length === 0 && activeConversationId && (
              <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
                <RobotOutlined style={{ fontSize: 48, color: token.colorTextQuaternary, marginBottom: 16 }} />
                <Paragraph type="secondary" style={{ fontSize: 14 }}>{t('workbench.startConvHint')}</Paragraph>
              </div>
            )}

            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                onCopy={handleCopy}
                onDeleteMessage={handleDeleteMessage}
                onToggleSegment={handleToggleSegment}
                getToolDisplayName={getToolDisplayName}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            padding: '0 0 4px',
          }}>
            <Tag color="green" style={{ cursor: 'pointer', fontSize: 12, borderRadius: 12 }}>
              <DatabaseOutlined /> {t('workbench.knowledgeBase')}
            </Tag>
          </div>

          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            placeholder={t('workbench.inputPlaceholder')}
          />
        </div>
      </div>

      <style>{`
        .cursor-blink { animation: blink 1s infinite; }
        @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
        .workbench-input::placeholder { color: ${token.colorTextQuaternary}; }
        .workbench-input:focus { outline: none; }
        .workbench-input {
          background: transparent !important;
        }
        .workbench-input:hover, .workbench-input:focus {
          background: transparent !important;
        }
        .ant-input-textarea-focused {
          background: transparent !important;
        }
        .markdown-content h1, .markdown-content h2, .markdown-content h3,
        .markdown-content h4, .markdown-content h5, .markdown-content h6 {
          margin-top: 16px;
          margin-bottom: 8px;
          font-weight: 600;
          line-height: 1.4;
        }
        .markdown-content h1 { font-size: 1.4em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 6px; }
        .markdown-content h2 { font-size: 1.25em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 5px; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content p { margin: 0 0 8px; }
        .markdown-content p:last-child { margin-bottom: 0; }
        .markdown-content ul, .markdown-content ol { padding-left: 24px; margin: 0 0 8px; }
        .markdown-content li { margin-bottom: 4px; }
        .markdown-content code {
          background: ${token.colorBgTextHover};
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 0.9em;
          font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
        }
        .markdown-content pre {
          background: ${token.colorBgTextHover};
          padding: 12px 16px;
          border-radius: 8px;
          overflow-x: auto;
          margin: 8px 0;
          border: 1px solid ${token.colorBorderSecondary};
        }
        .markdown-content pre code {
          background: transparent;
          padding: 0;
          border-radius: 0;
          font-size: 0.85em;
          line-height: 1.6;
        }
        .markdown-content blockquote {
          border-left: 3px solid ${token.colorPrimary};
          margin: 8px 0;
          padding: 4px 12px;
          color: ${token.colorTextSecondary};
          background: ${token.colorPrimaryBg};
          border-radius: 0 6px 6px 0;
        }
        .markdown-content table {
          border-collapse: collapse;
          width: 100%;
          margin: 8px 0;
        }
        .markdown-content th, .markdown-content td {
          border: 1px solid ${token.colorBorderSecondary};
          padding: 6px 12px;
          text-align: left;
        }
        .markdown-content th {
          background: ${token.colorBgTextHover};
          font-weight: 600;
        }
        .markdown-content a {
          color: ${token.colorPrimary};
          text-decoration: none;
        }
        .markdown-content a:hover {
          text-decoration: underline;
        }
        .markdown-content hr {
          border: none;
          border-top: 1px solid ${token.colorBorderSecondary};
          margin: 16px 0;
        }
        .markdown-content img {
          max-width: 100%;
          border-radius: 6px;
        }
      `}</style>
    </div>
  )
}

export default EmployeeWorkbench
