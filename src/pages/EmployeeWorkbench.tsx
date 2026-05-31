import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import 'katex/dist/katex.min.css'
import {
  Button,
  Space,
  Typography,
  Tag,
  Spin,
  Tooltip,
  theme,
  App,
  Input,
  Popover,
  Checkbox,
} from 'antd'
import {
  RobotOutlined,
  SettingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BulbOutlined,
  BulbFilled,
  PlusOutlined,
  SearchOutlined,
  DeleteOutlined,
  FolderOutlined,
  FolderOpenOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import LLMSelector from '../components/llm/LLMSelector'
import { ConversationSidebar, MessageBubble, ChatInput, MultiChatPanel } from '../components/workbench'
import type { AttachedImage, ModelSelection } from '../components/workbench'
import { useTranslation } from 'react-i18next'
import useEmployeeChat from '../hooks/useEmployeeChat'
import type { Employee } from '../types'

const { Text, Paragraph } = Typography

const AVATAR_COLORS = [
  '#1677ff', '#52c41a', '#fa8c16', '#722ed1',
  '#eb2f96', '#13c2c2', '#faad14', '#f5222d',
]

const EmployeeWorkbench: React.FC = () => {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { id: routeId } = useParams<{ id: string }>()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeListLoaded, setEmployeeListLoaded] = useState(false)
  const [employeeSearchText, setEmployeeSearchText] = useState('')
  const [employeeSelectorOpen, setEmployeeSelectorOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ emp: Employee; x: number; y: number } | null>(null)
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [selectedModels, setSelectedModels] = useState<ModelSelection[]>([])
  const [allKBs, setAllKBs] = useState<any[]>([])

  useEffect(() => {
    loadEmployees()
    loadAllKBs()
  }, [])

  useEffect(() => {
    if (!employeeSelectorOpen) {
      setContextMenu(null)
      setEmployeeSearchText('')
    }
  }, [employeeSelectorOpen])

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
      setEmployeeListLoaded(true)
    } catch {
      message.error(t('digitalEmployees.loadEmployeesFailed'))
    }
  }

  const loadAllKBs = async () => {
    try {
      const result = await window.electronAPI.kb.list()
      setAllKBs(result)
    } catch {}
  }

  const isEmptyRoute = routeId === '_empty'
  const id = isEmptyRoute ? undefined : routeId

  const filteredEmployees = useMemo(() => {
    if (!employeeSearchText.trim()) return employees
    const search = employeeSearchText.toLowerCase()
    return employees.filter(emp => emp.name.toLowerCase().includes(search))
  }, [employees, employeeSearchText])

  useEffect(() => {
    if (id) {
      localStorage.setItem('employeeWorkbench:lastEmployeeId', id)
    }
  }, [id])

  const handleDeleteEmployee = useCallback(async (emp: Employee) => {
    let deleteWorkspace = false
    const workspacePath = emp.workspace_path

    let tasks: any[] = []
    let schedules: any[] = []
    try {
      tasks = await window.electronAPI.employeeTask.list(emp.id)
      schedules = await window.electronAPI.employeeTask.listSchedules(emp.id)
    } catch {}

    const hasBoundTasks = tasks.length > 0 || schedules.length > 0

    const handleOpenExplorer = (path: string) => {
      window.electronAPI.workspace.openInExplorer({ path }).catch(() => {})
    }

    modal.confirm({
      title: t('employeeSettings.confirmDeleteEmployee'),
      icon: null,
      width: 520,
      content: (
        <div>
          <Text>{t('employeeSettings.deleteEmployeeDesc')}</Text>
          {workspacePath && (
            <div style={{
              marginTop: 8,
              padding: '6px 10px',
              background: token.colorFillTertiary,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <FolderOutlined style={{ color: token.colorPrimary, flexShrink: 0 }} />
              <Tooltip title={workspacePath}>
                <Text
                  style={{
                    fontSize: 13,
                    color: token.colorTextSecondary,
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('employeeSettings.workspacePath')}: {workspacePath}
                </Text>
              </Tooltip>
              <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => handleOpenExplorer(workspacePath)}
                style={{ flexShrink: 0, padding: 0 }}
              />
            </div>
          )}
          {hasBoundTasks && (
            <div style={{
              marginTop: 12,
              padding: '10px 12px',
              background: token.colorWarningBg,
              border: `1px solid ${token.colorWarningBorder}`,
              borderRadius: 6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 6, color: token.colorWarningText, display: 'flex', alignItems: 'center', gap: 6 }}>
                <WarningOutlined />
                {t('employeeSettings.boundTasksWarning')}
              </div>
              {tasks.length > 0 && (
                <div style={{ fontSize: 13, color: token.colorTextSecondary }}>
                  {t('employeeSettings.boundTaskCount', { count: tasks.length })}
                  {tasks.length <= 5 && (
                    <span style={{ marginLeft: 4 }}>
                      ({tasks.map((t: any) => t.name).join(', ')})
                    </span>
                  )}
                </div>
              )}
              {schedules.length > 0 && (
                <div style={{ fontSize: 13, color: token.colorTextSecondary, marginTop: 2 }}>
                  {t('employeeSettings.boundScheduleCount', { count: schedules.length })}
                  {schedules.length <= 5 && (
                    <span style={{ marginLeft: 4 }}>
                      ({schedules.map((s: any) => s.name).join(', ')})
                    </span>
                  )}
                </div>
              )}
              <div style={{ fontSize: 12, marginTop: 6, color: token.colorTextTertiary }}>
                {t('employeeSettings.boundTasksDeleteHint')}
              </div>
            </div>
          )}
          {workspacePath && (
            <Checkbox
              onChange={(e) => { deleteWorkspace = e.target.checked }}
              style={{ marginTop: 12 }}
            >
              {t('employeeSettings.alsoDeleteWorkspace')}
            </Checkbox>
          )}
        </div>
      ),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await window.electronAPI.employee.delete({
            id: emp.id,
            delete_workspace: deleteWorkspace,
          })
          message.success(t('common.deleted'))
          await loadEmployees()
          if (emp.id === id) {
            setEmployeeSelectorOpen(false)
          }
        } catch {
          message.error(t('common.deleteFailed'))
        }
      },
    })
  }, [id, modal, message, t, token])

  const chatHook = useEmployeeChat({ id, message })

  const {
    employee,
    conversations,
    allConversations,
    activeConversationId,
    messages,
    isStreaming,
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedKbIds,
    setSelectedKbIds,
    showSidePanel,
    setShowSidePanel,
    isComparisonMode,
    handleCloseComparison,
    handleOpenComparison,
    getComparisonMessages,
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
    handleRegenerate,
    handleSwitchModelRegenerate,
    handleEditAndResubmit,
    handleCommand,
    handleExportConversation,
    handleSwitchBranch,
    handleToggleSegment,
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
  } = chatHook

  const workbenchStyle = useMemo(() => `
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
      `, [token])

  const handleEmployeeChange = (newEmployeeId: string) => {
    if (newEmployeeId === 'create-new') {
      navigate('/wizard')
      return
    }
    navigate(`/employee/${newEmployeeId}`)
  }

  useEffect(() => {
    if (!employee && id && employees.length > 0) {
      const firstEmployee = employees[0]
      if (firstEmployee) {
        navigate(`/employee/${firstEmployee.id}`, { replace: true })
      }
    }
  }, [employee, id, employees])

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

  if (!employee) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  const employeeSelectorContent = (
    <div style={{ width: 260 }}>
      <Input
        placeholder={t('workbench.searchEmployee')}
        prefix={<SearchOutlined style={{ color: token.colorTextQuaternary }} />}
        value={employeeSearchText}
        onChange={(e) => setEmployeeSearchText(e.target.value)}
        allowClear
        variant="borderless"
        style={{ marginBottom: 4, padding: '4px 8px' }}
      />
      {filteredEmployees.length === 0 && (
        <div style={{ padding: '24px 0', textAlign: 'center', color: token.colorTextQuaternary, fontSize: 13 }}>
          {employeeSearchText ? t('workbench.noMatchingEmployee') : t('digitalEmployees.noEmployees')}
        </div>
      )}
      <div style={{ maxHeight: 300, overflowY: 'auto' }}>
        {filteredEmployees.map((emp, idx) => {
          const color = AVATAR_COLORS[idx % AVATAR_COLORS.length]
          const isActive = emp.id === id
          return (
            <div
              key={emp.id}
              onClick={() => {
                setEmployeeSelectorOpen(false)
                handleEmployeeChange(emp.id)
              }}
              onContextMenu={(e) => {
                if (isActive) return
                e.preventDefault()
                setContextMenu({ emp, x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 8px', borderRadius: 6,
                cursor: 'pointer',
                background: isActive ? token.colorPrimaryBg : 'transparent',
                transition: 'background 0.2s',
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = token.colorBgTextHover
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = 'transparent'
              }}
            >
              <div style={{
                width: 28, height: 28, borderRadius: 6,
                background: `${color}18`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <RobotOutlined style={{ fontSize: 14, color }} />
              </div>
              <span style={{
                flex: 1,
                fontWeight: isActive ? 600 : 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {emp.name}
              </span>
              {isActive && (
                <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', margin: 0 }}>
                  Active
                </Tag>
              )}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 4, marginTop: 4 }}>
        <Button
          type="text"
          icon={<PlusOutlined />}
          style={{ width: '100%', justifyContent: 'flex-start', color: token.colorPrimary }}
          onClick={() => {
            setEmployeeSelectorOpen(false)
            handleEmployeeChange('create-new')
          }}
        >
          {t('workbench.createEmployee')}
        </Button>
      </div>

      {contextMenu && (
        <>
          <div
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1050 }}
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null) }}
          />
          <div style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1051,
            background: token.colorBgElevated,
            borderRadius: 8,
            boxShadow: token.boxShadowSecondary,
            padding: 4,
            minWidth: 140,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}>
            <div
              style={{
                padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
                color: token.colorError, display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13,
              }}
              onClick={() => {
                setContextMenu(null)
                handleDeleteEmployee(contextMenu.emp)
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = token.colorErrorBg }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <DeleteOutlined />
              <span>{t('workbench.deleteEmployee')}</span>
            </div>
          </div>
        </>
      )}
    </div>
  )

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
          <Popover
            content={employeeSelectorContent}
            trigger="click"
            open={employeeSelectorOpen}
            onOpenChange={setEmployeeSelectorOpen}
            placement="bottomLeft"
            arrow={false}
            styles={{ container: { padding: 8 } }}
          >
            <Button type="text" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', height: 'auto' }}>
              <div style={{
                width: 26, height: 26, borderRadius: 6,
                background: `${token.colorPrimary}15`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <RobotOutlined style={{ fontSize: 14, color: token.colorPrimary }} />
              </div>
              <Text strong style={{ fontSize: 14 }}>{employee.name}</Text>
            </Button>
          </Popover>
        </Space>
        <Space size={4}>
          <LLMSelector
            providerId={selectedLlmProviderId}
            modelId={selectedLlmModelId}
            onChange={handleLlmChange}
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
            onGenerateTitle={async (conv) => {
              try {
                const fullConv = await window.electronAPI.conversation.get(conv.id)
                if (fullConv?.messages_json) {
                  const msgs = JSON.parse(fullConv.messages_json)
                  const firstUserMsg = msgs.find((m: any) => m.role === 'user')
                  if (firstUserMsg?.content) {
                    generateConversationTitle(conv.id, firstUserMsg.content)
                  }
                }
              } catch {}
            }}
            onExport={handleExportConversation}
          />
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {isComparisonMode ? (
            <MultiChatPanel
              comparisonMessages={getComparisonMessages()}
              providers={providers}
              onClose={handleCloseComparison}
              onToggleSegment={handleToggleSegment}
              onCopy={handleCopy}
              getToolDisplayName={getToolDisplayName}
            />
          ) : (
          <div ref={chatContainerRef} onScroll={handleScroll}
            style={{
              flex: 1,
              overflow: 'auto',
              padding: '24px 4%',
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
                onRegenerate={handleRegenerate}
                onSwitchModelRegenerate={handleSwitchModelRegenerate}
                onEditAndResubmit={handleEditAndResubmit}
                onToggleSegment={handleToggleSegment}
                onSwitchBranch={handleSwitchBranch}
                onOpenComparison={handleOpenComparison}
                getToolDisplayName={getToolDisplayName}
                providers={providers}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>
          )}

          <ChatInput
            onSend={(content, images, models) => {
              setAttachedImages([])
              setSelectedModels([])
              handleSend(content, images, models)
            }}
            onStop={handleStop}
            onCommand={handleCommand}
            isStreaming={isStreaming}
            placeholder={t('workbench.inputPlaceholder')}
            providers={providers}
            attachedImages={attachedImages}
            onImagesChange={setAttachedImages}
            selectedModels={selectedModels}
            onModelsChange={setSelectedModels}
            selectedKbIds={selectedKbIds}
            onSelectedKbIdsChange={setSelectedKbIds}
            allKBs={allKBs}
          />
        </div>
      </div>

      <style>{workbenchStyle}</style>
    </div>
  )
}

export default EmployeeWorkbench
