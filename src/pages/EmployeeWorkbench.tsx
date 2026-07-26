import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import 'katex/dist/katex.min.css'
import {
  Button,
  Space,
  Typography,
  Spin,
  Tooltip,
  theme,
  App,
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
  FolderOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons'
import LLMSelector from '../components/llm/LLMSelector'
import EmployeeSelector from '../components/workbench/EmployeeSelector'
import MessageList from '../components/workbench/MessageList'
import { ConversationSidebar, ChatInput, MultiChatPanel } from '../components/workbench'
import type { AttachedImage, ModelSelection } from '../components/workbench'
import { useTranslation } from 'react-i18next'
import useEmployeeChat from '../hooks/useEmployeeChat'
import type { Employee, Conversation } from '../types'

const { Text, Paragraph } = Typography

const LAST_USED_KEY = 'employeeWorkbench:lastUsedAt'

function getLastUsedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LAST_USED_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function updateEmployeeLastUsed(employeeId: string): void {
  try {
    const map = getLastUsedMap()
    map[employeeId] = Date.now()
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(map))
  } catch {
    // ignore
  }
}

function sortEmployeesByLastUsed(employees: Employee[]): Employee[] {
  const lastUsedMap = getLastUsedMap()
  return [...employees].sort((a, b) => {
    const aTime = lastUsedMap[a.id] || 0
    const bTime = lastUsedMap[b.id] || 0
    if (bTime !== aTime) return bTime - aTime
    return (b.updated_at || 0) - (a.updated_at || 0)
  })
}

const EmployeeWorkbench: React.FC = () => {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { id: routeId } = useParams<{ id: string }>()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeListLoaded, setEmployeeListLoaded] = useState(false)
  const [employeeSelectorOpen, setEmployeeSelectorOpen] = useState(false)
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [selectedModels, setSelectedModels] = useState<ModelSelection[]>([])
  const [allCollections, setAllCollections] = useState<any[]>([])

  useEffect(() => {
    loadEmployees()
    loadAllCollections()
  }, [])

  const loadEmployees = async () => {
    try {
      const result = await window.electronAPI.employee.list()
      const sorted = sortEmployeesByLastUsed(result)
      setEmployees(sorted)
      setEmployeeListLoaded(true)
    } catch {
      message.error(t('digitalEmployees.loadEmployeesFailed'))
    }
  }

  const loadAllCollections = async () => {
    try {
      const result = await window.electronAPI.kms.listCollections()
      // safeHandle 异常时返回 { error }（truthy 但非数组），需 Array.isArray 兜底
      setAllCollections(Array.isArray(result) ? result : [])
    } catch {}
  }

  const isEmptyRoute = routeId === '_empty'
  const id = isEmptyRoute ? undefined : routeId

  useEffect(() => {
    if (id) {
      localStorage.setItem('employeeWorkbench:lastEmployeeId', id)
      updateEmployeeLastUsed(id)
      setEmployees(prev => sortEmployeesByLastUsed(prev))
    }
  }, [id])

  const handleDeleteEmployee = useCallback(async (emp: Employee) => {
    let deleteWorkspace = false
    const workspacePath = emp.workspace_path

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
                <Text style={{
                  fontSize: 13,
                  color: token.colorTextSecondary,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {t('employeeSettings.workspacePath')}: {workspacePath}
                </Text>
              </Tooltip>
              <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => window.electronAPI.workspace.openInExplorer({ path: workspacePath }).catch(() => {})}
                style={{ flexShrink: 0, padding: 0 }}
              />
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
    loadingConversationId,
    inputDraft,
    setInputDraft,
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedCollectionIds,
    setSelectedCollectionIds,
    minimalMode,
    handleToggleMinimalMode,
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
      margin-top: 14px;
      margin-bottom: 6px;
      font-weight: 600;
      line-height: 1.4;
    }
    .markdown-content h1 { font-size: 1.35em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 4px; }
    .markdown-content h2 { font-size: 1.2em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 3px; }
    .markdown-content h3 { font-size: 1.08em; }
    .markdown-content p { margin: 0 0 6px; }
    .markdown-content p:last-child { margin-bottom: 0; }
    .markdown-content ul, .markdown-content ol { padding-left: 22px; margin: 0 0 6px; }
    .markdown-content li { margin-bottom: 3px; }
    .markdown-content code {
      background: ${token.colorBgTextHover};
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.88em;
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    }
    .markdown-content pre {
      background: ${token.colorBgTextHover};
      padding: 10px 14px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 6px 0;
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
      margin: 6px 0;
      padding: 3px 10px;
      color: ${token.colorTextSecondary};
      background: ${token.colorPrimaryBg};
      border-radius: 0 4px 4px 0;
    }
    .markdown-content table {
      border-collapse: collapse;
      width: 100%;
      margin: 6px 0;
    }
    .markdown-content th, .markdown-content td {
      border: 1px solid ${token.colorBorderSecondary};
      padding: 5px 10px;
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
      margin: 12px 0;
    }
    .markdown-content img {
      max-width: 100%;
      border-radius: 4px;
    }
    .open-workspace-btn:hover {
      background: ${token.colorFillSecondary} !important;
      color: ${token.colorPrimary} !important;
    }
  `, [token])

  const handleEmployeeSelect = useCallback((newEmployeeId: string) => {
    if (newEmployeeId === 'create-new') {
      navigate('/wizard')
      return
    }
    updateEmployeeLastUsed(newEmployeeId)
    navigate(`/employee/${newEmployeeId}`)
  }, [navigate])

  useEffect(() => {
    if (id && employees.length > 0 && !employees.some(e => e.id === id)) {
      const firstEmployee = employees[0]
      if (firstEmployee) {
        navigate(`/employee/${firstEmployee.id}`, { replace: true })
      }
    }
  }, [id, employees, navigate])

  const handleEditTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingTitle(e.target.value)
  }, [setEditingTitle])

  const handleGenerateTitle = useCallback(async (conv: any) => {
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
  }, [generateConversationTitle])

  const handleExtractMemory = useCallback(async (conv: Conversation) => {
    const hide = message.loading(t('workbench.extractingMemory'), 0)
    try {
      const result = await window.electronAPI.employee.extractConversationMemories({ conversation_id: conv.id })
      hide()
      if (result?.success) {
        message.success(t('workbench.extractMemorySuccess'))
      } else {
        message.error(t('workbench.extractMemoryFailed'))
      }
    } catch {
      hide()
      message.error(t('workbench.extractMemoryFailed'))
    }
  }, [message, t])

  const handleSendWithReset = useCallback((content: string, images: string[], models: ModelSelection[], options?: { highPermission?: boolean }) => {
    setAttachedImages([])
    setSelectedModels([])
    handleSend(content, images, models, options)
  }, [handleSend])

  const handleOpenWorkspace = useCallback(async () => {
    const workspacePath = employee?.workspace_path
    if (!workspacePath) {
      message.warning(t('workbench.workspaceNotSet'))
      return
    }
    try {
      const result = await window.electronAPI.workspace.openInExplorer({ path: workspacePath })
      if (result && result.success === false) {
        message.error(t('workbench.openWorkspaceFailed', { error: result.error || '' }))
      }
    } catch {
      message.error(t('workbench.openWorkspaceFailed', { error: '' }))
    }
  }, [employee?.workspace_path, message, t])

  if (!employeeListLoaded) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (employees.length === 0) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
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
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
      <div style={{
        height: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}>
        <Space size={8}>
          <Tooltip title={showSidePanel ? t('workbench.closePanel') : t('workbench.historyConv')}>
            <Button type="text" size="small"
              icon={showSidePanel ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setShowSidePanel(!showSidePanel)}
            />
          </Tooltip>
          <Popover
            content={
              <EmployeeSelector
                open={employeeSelectorOpen}
                onOpenChange={setEmployeeSelectorOpen}
                employees={employees}
                activeEmployeeId={id}
                onSelect={handleEmployeeSelect}
                onCreateNew={() => handleEmployeeSelect('create-new')}
                onDeleteEmployee={handleDeleteEmployee}
              />
            }
            trigger="click"
            open={employeeSelectorOpen}
            onOpenChange={setEmployeeSelectorOpen}
            placement="bottomLeft"
            arrow={false}
            styles={{ container: { padding: 8 } }}
          >
            <Button type="text" size="small" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px', height: 'auto' }}>
              <div style={{
                width: 22, height: 22, borderRadius: 5,
                background: `${token.colorPrimary}15`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <RobotOutlined style={{ fontSize: 12, color: token.colorPrimary }} />
              </div>
              <Text strong style={{ fontSize: 13 }}>{employee.name}</Text>
            </Button>
          </Popover>
        </Space>
        <Space size={6}>
          {employee?.workspace_path && (
            <Tooltip
              title={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span>{t('workbench.openWorkspace')}</span>
                  <span style={{ fontSize: 11, opacity: 0.75, fontFamily: 'monospace' }}>
                    {employee.workspace_path}
                  </span>
                </div>
              }
              placement="bottom"
            >
              <Button
                type="default"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={handleOpenWorkspace}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '0 10px',
                  height: 26,
                  borderRadius: 4,
                  fontSize: 12,
                  color: token.colorText,
                  borderColor: token.colorBorder,
                }}
                className="open-workspace-btn"
              >
                {t('workbench.workspace')}
              </Button>
            </Tooltip>
          )}
          <LLMSelector
            providerId={selectedLlmProviderId}
            modelId={selectedLlmModelId}
            onChange={handleLlmChange}
          />
          <Tooltip title={enableThinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
            <Button
              type={enableThinking ? 'primary' : 'text'}
              size="small"
              icon={enableThinking ? <BulbFilled /> : <BulbOutlined />}
              onClick={() => setEnableThinking(!enableThinking)}
              style={enableThinking ? {} : { color: token.colorTextSecondary }}
            />
          </Tooltip>
          <Tooltip title={t('workbench.employeeConfig')}>
            <Button type="text" size="small" icon={<SettingOutlined />}
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
            onEditTitleChange={handleEditTitleChange}
            onEditKeyDown={handleEditKeyDown}
            onDelete={deleteConversation}
            onDeleteSelected={deleteSelectedConversations}
            onNewConversation={startNewConversation}
            onLoadMore={loadMoreConversations}
            onListScroll={handleConversationListScroll}
            isConversationStreaming={isConversationStreaming}
            onGenerateTitle={handleGenerateTitle}
            onExport={handleExportConversation}
            onExtractMemory={handleExtractMemory}
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
                padding: '16px 6%',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
              }}
            >
              <MessageList
                messages={messages}
                loadingConversationId={loadingConversationId}
                activeConversationId={activeConversationId}
                chatContainerRef={chatContainerRef as React.RefObject<HTMLDivElement | null>}
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
              <div ref={messagesEndRef} />
            </div>
          )}

          <ChatInput
            onSend={handleSendWithReset}
            onStop={handleStop}
            onCommand={handleCommand}
            isStreaming={isStreaming}
            placeholder={t('workbench.inputPlaceholder')}
            providers={providers}
            attachedImages={attachedImages}
            onImagesChange={setAttachedImages}
            selectedModels={selectedModels}
            onModelsChange={setSelectedModels}
            selectedCollectionIds={selectedCollectionIds}
            onSelectedCollectionIdsChange={setSelectedCollectionIds}
            allCollections={allCollections}
            minimalMode={minimalMode}
            onMinimalModeChange={handleToggleMinimalMode}
            canToggleMinimalMode={messages.length === 0}
            value={inputDraft}
            onChange={setInputDraft}
          />
        </div>
      </div>

      <style>{workbenchStyle}</style>
    </div>
  )
}

export default EmployeeWorkbench
