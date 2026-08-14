import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import 'katex/dist/katex.min.css'
import { Button, Typography, Spin, Tooltip, theme, App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { MenuUnfoldOutlined, PlusOutlined, RobotOutlined, FolderOpenOutlined } from '@ant-design/icons'
import MessageList from '../components/workbench/MessageList'
import ChatInput from '../components/workbench/ChatInput'
import MultiChatPanel from '../components/workbench/MultiChatPanel'
import TaskSidebar, { type TaskWithEmployee } from '../components/tasks/TaskSidebar'
import EmployeeSettingsDrawer from '../components/employee-settings/EmployeeSettingsDrawer'
import { useTranslation } from 'react-i18next'
import useEmployeeChat from '../hooks/useEmployeeChat'
import type { AttachedImage, ModelSelection } from '../components/workbench'
import type { AvailableSkill } from '../components/workbench/ChatInput'
import type { Employee } from '../types'

const { Paragraph } = Typography

const HorizontalDotsIcon: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" style={style}>
    <circle cx="2.5" cy="8" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="13.5" cy="8" r="1.5" />
  </svg>
)

const Tasks: React.FC = () => {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const PAGE_SIZE = 20

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeesLoaded, setEmployeesLoaded] = useState(false)
  const [globalTasks, setGlobalTasks] = useState<TaskWithEmployee[]>([])
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [selectedModels, setSelectedModels] = useState<ModelSelection[]>([])
  const [allCollections, setAllCollections] = useState<any[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showSidePanel, setShowSidePanel] = useState(true)

  // 分页相关状态
  const [loadedCount, setLoadedCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // 任务模式：'new' = 新任务（居中输入框），'chat' = 对话模式
  const [taskMode, setTaskMode] = useState<'new' | 'chat'>('new')
  // 新任务时用户选择的员工
  const [newTaskEmployeeId, setNewTaskEmployeeId] = useState<string | null>(null)
  // 当前对话对应的员工ID（传给 useEmployeeChat）
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | undefined>(undefined)
  // 待选择的对话ID（跨员工切换时使用）
  const pendingSelectConvIdRef = useRef<string | null>(null)
  // 上一次 employee 加载状态，用于检测初始化完成
  const prevEmployeeLoadedRef = useRef(false)

  // 搜索与筛选
  const [searchQuery, setSearchQuery] = useState('')
  const [filterEmployeeId, setFilterEmployeeId] = useState<string | null>(null)
  // 全文内容搜索匹配的任务 ID 集合（null = 未搜索，Set = 搜索结果）
  const [contentMatchIds, setContentMatchIds] = useState<Set<string> | null>(null)

  // 是否使用全量模式：有搜索或筛选时使用全量加载，否则分页模式下初始加载20条，滚动加载更多
  const useFullLoad = !!searchQuery.trim() || !!filterEmployeeId || !!contentMatchIds

  const loadEmployees = useCallback(async () => {
    try {
      const result = await window.electronAPI.employee.list()
      setEmployees(result)
      setEmployeesLoaded(true)
    } catch {
      message.error(t('digitalEmployees.loadEmployeesFailed'))
      setEmployeesLoaded(true)
    }
  }, [message, t])

  // 加载任务列表：支持全量模式和分页模式
  const loadGlobalTasks = useCallback(async (opts?: { reset?: boolean; forceFull?: boolean }) => {
    const forceFull = !!opts?.forceFull
    try {
      const full = forceFull || useFullLoad
      if (full) {
        // 全量模式：一次加载所有
        const result = await window.electronAPI.conversation.listAll()
        const arr = Array.isArray(result) ? result : []
        setGlobalTasks(arr)
        setLoadedCount(arr.length)
        setHasMore(false)
      } else {
        // 分页模式：加载 PAGE_SIZE 条
        const result = await window.electronAPI.conversation.listAll({ limit: PAGE_SIZE, offset: 0 })
        const arr = Array.isArray(result) ? result : []
        setGlobalTasks(arr)
        setLoadedCount(arr.length)
        setHasMore(arr.length === PAGE_SIZE)
      }
    } catch {
      setGlobalTasks([])
      setLoadedCount(0)
      setHasMore(false)
    }
  }, [PAGE_SIZE, useFullLoad])

  // 加载更多（仅在分页模式下使用）
  const loadMoreTasks = useCallback(async () => {
    if (loadingMore || useFullLoad) return
    setLoadingMore(true)
    try {
      const result = await window.electronAPI.conversation.listAll({ limit: PAGE_SIZE, offset: loadedCount })
      const arr = Array.isArray(result) ? result : []
      if (arr.length > 0) {
        setGlobalTasks(prev => {
          const existingIds = new Set(prev.map(t => t.id))
          const newOnes = arr.filter(t => !existingIds.has(t.id))
          return [...prev, ...newOnes]
        })
        setLoadedCount(prev => prev + arr.length)
      }
      setHasMore(arr.length === PAGE_SIZE)
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [PAGE_SIZE, loadedCount, loadingMore, useFullLoad])

  // 搜索/筛选模式切换时：如果从分页模式切换到全量模式，需要重新全量加载
  useEffect(() => {
    if (useFullLoad) {
      loadGlobalTasks({ forceFull: true, reset: true })
    }
    // 仅在 useFullLoad 切换为 true 时触发；切换为 false 时由其他 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFullLoad])

  const loadAllCollections = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.listCollections()
      setAllCollections(Array.isArray(result) ? result : [])
    } catch {}
  }, [])

  useEffect(() => {
    loadEmployees()
    loadGlobalTasks()
    loadAllCollections()
  }, [loadEmployees, loadGlobalTasks, loadAllCollections])

  // 员工列表变更通知（增删改）：刷新列表 & 清理无效选中
  useEffect(() => {
    const unsub = window.electronAPI.employee.onChanged(async () => {
      await loadEmployees()
      await loadGlobalTasks()
    })
    return () => { unsub?.() }
  }, [loadEmployees, loadGlobalTasks])

  // 清理无效筛选选中态：filterEmployeeId / newTaskEmployeeId / currentEmployeeId  若不在员工列表中则重置
  useEffect(() => {
    if (!employeesLoaded) return
    const ids = new Set(employees.map(e => e.id))
    if (filterEmployeeId && !ids.has(filterEmployeeId)) {
      setFilterEmployeeId(null)
    }
    if (newTaskEmployeeId && !ids.has(newTaskEmployeeId)) {
      setNewTaskEmployeeId(null)
    }
    if (currentEmployeeId && !ids.has(currentEmployeeId)) {
      setCurrentEmployeeId(undefined)
    }
  }, [employees, employeesLoaded, filterEmployeeId, newTaskEmployeeId, currentEmployeeId])

  // 新任务模式下自动选择第一个员工，避免未选员工时发送消息无效
  useEffect(() => {
    if (taskMode === 'new' && employees.length > 0 && !currentEmployeeId) {
      const firstEmpId = employees[0].id
      setNewTaskEmployeeId(firstEmpId)
      setCurrentEmployeeId(firstEmpId)
      prevEmployeeLoadedRef.current = false
    }
  }, [taskMode, employees, currentEmployeeId])

  // 全文内容搜索：防抖 300ms 调用 searchGlobal
  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (!trimmed) {
      setContentMatchIds(null)
      return
    }
    const timer = setTimeout(async () => {
      try {
        const results = await window.electronAPI.conversation.searchGlobal({
          query: trimmed,
          limit: 50,
        })
        setContentMatchIds(new Set(Array.isArray(results) ? results.map((r: any) => r.conversationId) : []))
      } catch {
        setContentMatchIds(new Set())
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // 使用 useEmployeeChat，传入 skipAutoInit 避免自动选择对话
  const chatHook = useEmployeeChat({ id: currentEmployeeId, message, skipAutoInit: true })

  const {
    employee,
    activeConversationId,
    messages,
    isStreaming,
    loadingConversationId,
    getInputDraft,
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
    isComparisonMode,
    getComparisonMessages,
    handleCloseComparison,
    handleDeleteComparisonMessage,
    handleOpenComparison,
    messagesEndRef,
    chatContainerRef,
    handleScroll,
    handleSend,
    handleStop,
    selectConversation,
    clearActiveConversation,
    handleCopy,
    handleDeleteMessage,
    handleRegenerate,
    handleSwitchModelRegenerate,
    handleEditAndResubmit,
    handleToggleSegment,
    handleSwitchBranch,
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
    contextStats,
    isCompacting,
    handleCompact,
  } = chatHook

  // 从数字员工"快速任务"跳转而来：?new=1&employee=<id> → 打开新任务模式并预选员工
  const appliedQueryRef = useRef<string | null>(null)
  useEffect(() => {
    const newParam = searchParams.get('new')
    const empId = searchParams.get('employee')
    const key = `${newParam}|${empId}`
    if (newParam === '1' && empId && key !== appliedQueryRef.current) {
      if (employees.length > 0 && !employees.some(e => e.id === empId)) {
        return // 员工尚未加载或不存在，等待下次触发
      }
      appliedQueryRef.current = key
      setNewTaskEmployeeId(empId)
      setCurrentEmployeeId(empId)
      setTaskMode('new')
      prevEmployeeLoadedRef.current = false
      pendingSelectConvIdRef.current = null
      clearActiveConversation()
    }
  }, [searchParams, employees, clearActiveConversation])

  // 已启用 skills
  const [availableSkills, setAvailableSkills] = useState<AvailableSkill[]>([])
  useEffect(() => {
    if (!currentEmployeeId) {
      setAvailableSkills([])
      return
    }
    let cancelled = false
    window.electronAPI.skillRegistry.getEmployeeSkills({ employee_id: currentEmployeeId })
      .then((result: any) => {
        if (cancelled) return
        const skills: AvailableSkill[] = (result?.enabled || []).map((s: any) => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
          userInvocable: s.userInvocable !== false,
        }))
        setAvailableSkills(skills)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [currentEmployeeId])

  // 检测 employee 加载完成，执行待选择的对话
  useEffect(() => {
    if (employee && !prevEmployeeLoadedRef.current && pendingSelectConvIdRef.current) {
      const convId = pendingSelectConvIdRef.current
      pendingSelectConvIdRef.current = null
      selectConversation(convId)
    }
    prevEmployeeLoadedRef.current = !!employee
  }, [employee, selectConversation])

  // 过滤后的任务列表（支持标题/员工名匹配 + 全文内容搜索）
  const filteredTasks = useMemo(() => {
    let result = globalTasks
    if (filterEmployeeId) {
      result = result.filter(t => t.employee_id === filterEmployeeId)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.employee_name || '').toLowerCase().includes(q) ||
        (contentMatchIds?.has(t.id) ?? false)
      )
    }
    return result
  }, [globalTasks, filterEmployeeId, searchQuery, contentMatchIds])

  // 新建任务（保留当前已选员工，清除激活对话避免新消息发到旧对话）
  // 注意：用户主动点击"新建任务"时，也清空草稿缓存（给用户一个干净的新开始）
  const handleNewTask = useCallback(() => {
    setTaskMode('new')
    const empId = currentEmployeeId || null
    setNewTaskEmployeeId(empId)
    pendingSelectConvIdRef.current = null
    setAttachedImages([])
    setSelectedModels([])
    clearActiveConversation()
    // 清除当前员工的新任务草稿缓存
    if (empId) {
      try { localStorage.removeItem(`tasks:newTaskDraft:${empId}`) } catch {}
    }
  }, [currentEmployeeId, clearActiveConversation])

  // 选择已有任务
  const handleSelectTask = useCallback((taskId: string) => {
    const task = globalTasks.find(t => t.id === taskId)
    if (!task) return

    setTaskMode('chat')
    if (task.employee_id === currentEmployeeId) {
      selectConversation(taskId)
    } else {
      pendingSelectConvIdRef.current = taskId
      prevEmployeeLoadedRef.current = false
      setCurrentEmployeeId(task.employee_id)
    }
  }, [globalTasks, currentEmployeeId, selectConversation])

  // 删除任务
  const handleDeleteTask = useCallback(async (taskId: string) => {
    try {
      const res: any = await window.electronAPI.conversation.delete(taskId)
      setGlobalTasks(prev => prev.filter(t => t.id !== taskId))
      if (taskId === activeConversationId) {
        handleNewTask()
      }
      message.success(t('workbench.deleteSuccess'))
      // 任务目录非空时，询问是否一并删除任务目录
      if (res?.taskDirNonEmpty && res?.taskDir) {
        modal.confirm({
          title: t('workbench.deleteTaskDirTitle'),
          content: t('workbench.deleteTaskDirContent', { path: res.taskDir }),
          okText: t('workbench.deleteTaskDirOk'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
          onOk: async () => {
            await window.electronAPI.workspace.deleteTaskDir(res.taskDir)
          },
        })
      }
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }, [activeConversationId, handleNewTask, message, modal, t])

  // 批量删除任务
  const handleDeleteMany = useCallback(async (taskIds: string[]) => {
    try {
      const nonEmptyDirs: string[] = []
      for (const taskId of taskIds) {
        const res: any = await window.electronAPI.conversation.delete(taskId)
        if (res?.taskDirNonEmpty && res?.taskDir) {
          nonEmptyDirs.push(res.taskDir)
        }
      }
      setGlobalTasks(prev => prev.filter(t => !taskIds.includes(t.id)))
      if (activeConversationId && taskIds.includes(activeConversationId)) {
        handleNewTask()
      }
      message.success(t('workbench.deleteSuccess'))
      // 存在非空任务目录时，询问是否一并删除
      if (nonEmptyDirs.length > 0) {
        modal.confirm({
          title: t('workbench.deleteTaskDirManyTitle'),
          content: t('workbench.deleteTaskDirManyContent', { count: nonEmptyDirs.length }),
          okText: t('workbench.deleteTaskDirOk'),
          cancelText: t('common.cancel'),
          okButtonProps: { danger: true },
          onOk: async () => {
            for (const dir of nonEmptyDirs) {
              await window.electronAPI.workspace.deleteTaskDir(dir)
            }
          },
        })
      }
    } catch {
      message.error(t('workbench.deleteFailed'))
    }
  }, [activeConversationId, handleNewTask, message, modal, t])

  // 新任务草稿 localStorage 缓存 key（按员工区分）
  const newTaskDraftKey = newTaskEmployeeId ? `tasks:newTaskDraft:${newTaskEmployeeId}` : null

  // 清除新任务草稿缓存
  const clearNewTaskDraft = useCallback(() => {
    if (newTaskDraftKey) {
      try { localStorage.removeItem(newTaskDraftKey) } catch {}
    }
  }, [newTaskDraftKey])

  // 保存新任务草稿到 localStorage
  const saveNewTaskDraft = useCallback((patch: Partial<{
    content: string
    attachedImages: AttachedImage[]
    selectedModels: ModelSelection[]
    selectedCollectionIds: string[]
  }>) => {
    if (taskMode !== 'new' || !newTaskDraftKey) return
    try {
      const prevRaw = localStorage.getItem(newTaskDraftKey)
      const prev = prevRaw ? JSON.parse(prevRaw) : {}
      const next = { ...prev, ...patch }
      localStorage.setItem(newTaskDraftKey, JSON.stringify(next))
    } catch {}
  }, [taskMode, newTaskDraftKey])

  // 组件挂载 & 新任务模式 / 员工切换时，从 localStorage 恢复草稿
  // 若新员工没有缓存，则清空旧员工残留的图片/模型/知识库，避免内容混淆
  useEffect(() => {
    if (taskMode !== 'new' || !newTaskDraftKey) return
    try {
      const raw = localStorage.getItem(newTaskDraftKey)
      if (raw) {
        const data = JSON.parse(raw)
        if (typeof data.content === 'string') {
          setInputDraft(data.content)
        } else {
          setInputDraft('')
        }
        setAttachedImages(Array.isArray(data.attachedImages) ? data.attachedImages : [])
        setSelectedModels(Array.isArray(data.selectedModels) ? data.selectedModels : [])
        setSelectedCollectionIds(Array.isArray(data.selectedCollectionIds) ? data.selectedCollectionIds : [])
      } else {
        // 无缓存：全部重置为空
        setInputDraft('')
        setAttachedImages([])
        setSelectedModels([])
        setSelectedCollectionIds([])
      }
    } catch {
      // 解析失败：安全起见清空
      setInputDraft('')
      setAttachedImages([])
      setSelectedModels([])
      setSelectedCollectionIds([])
    }
    // 仅在切换到新任务模式或切换员工时恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskMode, newTaskDraftKey])

  // 新任务模式下，监听输入内容变化并持久化
  const handleDraftChangeWithCache = useCallback((value: string) => {
    setInputDraft(value)
    saveNewTaskDraft({ content: value })
  }, [setInputDraft, saveNewTaskDraft])

  // 新任务模式下，监听图片变化并持久化
  const handleImagesChangeWithCache = useCallback((images: AttachedImage[]) => {
    setAttachedImages(images)
    saveNewTaskDraft({ attachedImages: images })
  }, [setAttachedImages, saveNewTaskDraft])

  // 新任务模式下，监听模型变化并持久化
  const handleModelsChangeWithCache = useCallback((models: ModelSelection[]) => {
    setSelectedModels(models)
    saveNewTaskDraft({ selectedModels: models })
  }, [setSelectedModels, saveNewTaskDraft])

  // 新任务模式下，监听知识库变化并持久化
  const handleCollectionIdsChangeWithCache = useCallback((ids: string[]) => {
    setSelectedCollectionIds(ids)
    saveNewTaskDraft({ selectedCollectionIds: ids })
  }, [setSelectedCollectionIds, saveNewTaskDraft])

  // 发送消息
  const handleSendWithReset = useCallback(async (content: string, images: string[], models: ModelSelection[], options?: { highPermission?: boolean }) => {
    setAttachedImages([])
    setSelectedModels([])
    clearNewTaskDraft()
    await handleSend(content, images, models, options)
    // 发送后切换到对话模式；任务列表由 activeConversationId/taskMode 变化触发的
    // useEffect 刷新（此时 sendMessage 已完成持久化，listAll 一定能查到新任务）
    if (taskMode === 'new') {
      setTaskMode('chat')
    }
  }, [handleSend, taskMode, clearNewTaskDraft])

  // 从 chat 切回 new 时，用 localStorage 的草稿同步到 inputDraft（供 ChatInput 重新挂载时读取）
  // 切换员工时不再恢复草稿，保留当前编辑器内容
  const prevTaskModeRef = useRef<'new' | 'chat'>('new')
  useEffect(() => {
    if (prevTaskModeRef.current === 'chat' && taskMode === 'new') {
      // 从 chat 切回 new 时，用 localStorage 的草稿覆盖 chat 残留的 inputDraft
      try {
        if (newTaskDraftKey) {
          const raw = localStorage.getItem(newTaskDraftKey)
          if (raw) {
            const data = JSON.parse(raw)
            if (typeof data.content === 'string') setInputDraft(data.content)
          } else {
            setInputDraft('')
          }
        }
      } catch {}
    }
    prevTaskModeRef.current = taskMode
  }, [taskMode, newTaskDraftKey, setInputDraft])

  // 选择新任务员工
  const handleSelectEmployee = useCallback((empId: string) => {
    setNewTaskEmployeeId(empId)
    setCurrentEmployeeId(empId)
    prevEmployeeLoadedRef.current = false
  }, [])

  // 生成标题（适用于任意任务，不限于当前激活任务）
  const handleGenerateTitle = useCallback(async (taskId: string) => {
    try {
      const fullConv = await window.electronAPI.conversation.get(taskId)
      if (fullConv?.messages_json) {
        const msgs = JSON.parse(fullConv.messages_json)
        const firstUserMsg = msgs.find((m: any) => m.role === 'user')
        if (firstUserMsg?.content) {
          generateConversationTitle(taskId, firstUserMsg.content)
          setTimeout(() => loadGlobalTasks(), 1000)
        }
      }
    } catch {}
  }, [generateConversationTitle, loadGlobalTasks])

  // 导出对话（适用于任意任务）
  const handleExport = useCallback(async (taskId: string) => {
    try {
      const fullConv = await window.electronAPI.conversation.get(taskId)
      if (!fullConv?.messages_json) return
      const msgs = JSON.parse(fullConv.messages_json)
      if (!Array.isArray(msgs) || msgs.length === 0) return
      const lines: string[] = []
      for (const msg of msgs) {
        const role = msg.role === 'user' ? '👤 User' : '🤖 Assistant'
        lines.push(`### ${role}\n`)
        lines.push(msg.content || '')
        lines.push('')
      }
      const content = lines.join('\n')
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `conversation-${taskId}.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch {}
  }, [])

  // 重命名任务（TaskSidebar 内联编辑调用）
  const handleRename = useCallback(async (taskId: string, newTitle: string): Promise<boolean> => {
    try {
      await window.electronAPI.conversation.update({ id: taskId, title: newTitle })
      setGlobalTasks(prev => prev.map(t => t.id === taskId ? { ...t, title: newTitle } : t))
      message.success(t('workbench.renameSuccess'))
      return true
    } catch {
      message.error(t('workbench.renameFailed'))
      return false
    }
  }, [t, message])

  // 提取记忆
  const handleExtractMemory = useCallback(async (taskId: string) => {
    const hide = message.loading(t('workbench.extractingMemory'), 0)
    try {
      const result = await window.electronAPI.employee.extractConversationMemories({ conversation_id: taskId })
      hide()
      if (result?.success) {
        message.success(t('workbench.extractMemorySuccess'))
      } else {
        message.error(result?.error || t('workbench.extractMemoryFailed'))
      }
    } catch {
      hide()
      message.error(t('workbench.extractMemoryFailed'))
    }
  }, [message, t])

  // 在系统文件管理器中打开指定目录
  const openDirInExplorer = useCallback(async (dirPath?: string) => {
    if (!dirPath) {
      message.warning(t('workbench.workspaceNotSet'))
      return
    }
    try {
      const res = await window.electronAPI.workspace.openInExplorer({ path: dirPath })
      if (res && (res as any).error) {
        message.error(t('workbench.openWorkspaceFailed', { error: (res as any).error }))
      }
    } catch (e: any) {
      message.error(t('workbench.openWorkspaceFailed', { error: e?.message || String(e) }))
    }
  }, [message, t])

  // 打开当前员工的工作区目录
  const handleOpenWorkspace = useCallback(() => {
    openDirInExplorer(employee?.workspace_path)
  }, [employee, openDirInExplorer])

  // 打开当前任务的工作区目录
  const handleOpenTaskWorkspace = useCallback(() => {
    const activeTask = globalTasks.find(t => t.id === activeConversationId)
    openDirInExplorer(activeTask?.workspace_path)
  }, [globalTasks, activeConversationId, openDirInExplorer])

  const moreMenuItems = useMemo<MenuProps['items']>(() => {
    return [
      {
        key: 'openTaskWorkspace',
        icon: <FolderOpenOutlined />,
        label: t('workbench.openTaskWorkspace'),
        onClick: handleOpenTaskWorkspace,
      },
      {
        key: 'openWorkspace',
        icon: <FolderOpenOutlined />,
        label: t('workbench.openWorkspace'),
        onClick: handleOpenWorkspace,
      },
    ]
  }, [t, handleOpenWorkspace, handleOpenTaskWorkspace])

  const workbenchStyle = useMemo(() => `
    .cursor-blink { animation: blink 1s infinite; }
    @keyframes blink { 0%,50%{opacity:1} 51%,100%{opacity:0} }
    .workbench-input::placeholder { color: ${token.colorTextQuaternary}; }
    .workbench-input:focus { outline: none; }
    .workbench-input { background: transparent !important; }
    .workbench-input:hover, .workbench-input:focus { background: transparent !important; }
    .ant-input-textarea-focused { background: transparent !important; }
    .markdown-content h1, .markdown-content h2, .markdown-content h3,
    .markdown-content h4, .markdown-content h5, .markdown-content h6 {
      margin-top: 14px; margin-bottom: 6px; font-weight: 600; line-height: 1.4;
    }
    .markdown-content h1 { font-size: 1.35em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 4px; }
    .markdown-content h2 { font-size: 1.2em; border-bottom: 1px solid ${token.colorBorderSecondary}; padding-bottom: 3px; }
    .markdown-content h3 { font-size: 1.08em; }
    .markdown-content p { margin: 0 0 6px; }
    .markdown-content p:last-child { margin-bottom: 0; }
    .markdown-content ul, .markdown-content ol { padding-left: 22px; margin: 0 0 6px; }
    .markdown-content li { margin-bottom: 3px; }
    .markdown-content code {
      background: ${token.colorBgTextHover}; padding: 1px 5px; border-radius: 3px;
      font-size: 0.88em; font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    }
    .markdown-content pre {
      background: ${token.colorBgTextHover}; padding: 10px 14px; border-radius: 6px;
      overflow-x: auto; margin: 6px 0; border: 1px solid ${token.colorBorderSecondary};
    }
    .markdown-content pre code { background: transparent; padding: 0; border-radius: 0; font-size: 0.85em; line-height: 1.6; }
    .markdown-content blockquote {
      border-left: 3px solid ${token.colorPrimary}; margin: 6px 0; padding: 3px 10px;
      color: ${token.colorTextSecondary}; background: ${token.colorPrimaryBg}; border-radius: 0 4px 4px 0;
    }
    .markdown-content table { border-collapse: collapse; width: 100%; margin: 6px 0; }
    .markdown-content th, .markdown-content td { border: 1px solid ${token.colorBorderSecondary}; padding: 5px 10px; text-align: left; }
    .markdown-content th { background: ${token.colorBgTextHover}; font-weight: 600; }
    .markdown-content a { color: ${token.colorPrimary}; text-decoration: none; }
    .markdown-content a:hover { text-decoration: underline; }
    .markdown-content hr { border: none; border-top: 1px solid ${token.colorBorderSecondary}; margin: 12px 0; }
    .markdown-content img { max-width: 100%; border-radius: 4px; }
  `, [token])

  // 监听 activeConversationId 变化，刷新全局列表
  useEffect(() => {
    if (activeConversationId && taskMode === 'chat') {
      loadGlobalTasks()
    }
  }, [activeConversationId, taskMode, loadGlobalTasks])

  // 监听对话标题生成完成，刷新任务列表让新标题立即可见
  useEffect(() => {
    const handler = () => loadGlobalTasks()
    window.addEventListener('conversation-title-updated', handler)
    return () => window.removeEventListener('conversation-title-updated', handler)
  }, [loadGlobalTasks])

  if (!employeesLoaded) {
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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
      {/* 主体 */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {showSidePanel && (
          <TaskSidebar
            tasks={filteredTasks}
            activeTaskId={taskMode === 'new' ? null : activeConversationId}
            employees={employees}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            filterEmployeeId={filterEmployeeId}
            onFilterChange={setFilterEmployeeId}
            onSelect={handleSelectTask}
            onDelete={handleDeleteTask}
            onDeleteMany={handleDeleteMany}
            onNewTask={handleNewTask}
            onCollapse={() => setShowSidePanel(false)}
            onExport={handleExport}
            onGenerateTitle={handleGenerateTitle}
            onRename={handleRename}
            onExtractMemory={handleExtractMemory}
            isTaskStreaming={isConversationStreaming}
            hasMore={hasMore && !useFullLoad}
            loadingMore={loadingMore}
            onLoadMore={loadMoreTasks}
          />
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, position: 'relative' }}>
          {!showSidePanel && (
            <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 20, display: 'flex', gap: 6 }}>
              <Tooltip title={t('workbench.historyConv')}>
                <Button type="text" size="small"
                  icon={<MenuUnfoldOutlined style={{ fontSize: 14 }} />}
                  onClick={() => setShowSidePanel(true)}
                  style={{ color: token.colorTextSecondary, width: 28, height: 28, minWidth: 28, borderRadius: 6 }}
                />
              </Tooltip>
              <Tooltip title={t('tasks.newTask')}>
                <Button type="text" size="small"
                  icon={<PlusOutlined style={{ fontSize: 14 }} />}
                  onClick={handleNewTask}
                  style={{ color: token.colorTextSecondary, width: 28, height: 28, minWidth: 28, borderRadius: 6 }}
                />
              </Tooltip>
            </div>
          )}
          {taskMode === 'chat' && (
            <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 20, display: 'flex', gap: 6, alignItems: 'center' }}>
              <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomRight">
                <Button type="text" size="small"
                  icon={<HorizontalDotsIcon style={{ fontSize: 14 }} />}
                  style={{ color: token.colorTextSecondary, width: 28, height: 28, minWidth: 28, borderRadius: 6 }}
                />
              </Dropdown>
            </div>
          )}
          {taskMode === 'new' ? (
            // 新任务模式：居中输入框（使用带缓存的回调，切换页面回来可恢复）
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '20px',
              overflowY: 'auto',
            }}>
              <ChatInput
                onSend={handleSendWithReset}
                onStop={handleStop}
                isStreaming={isStreaming}
                placeholder={t('tasks.inputPlaceholder')}
                providers={providers}
                attachedImages={attachedImages}
                onImagesChange={handleImagesChangeWithCache}
                selectedModels={selectedModels}
                onModelsChange={handleModelsChangeWithCache}
                selectedCollectionIds={selectedCollectionIds}
                onSelectedCollectionIdsChange={handleCollectionIdsChangeWithCache}
                allCollections={allCollections}
                minimalMode={minimalMode}
                onMinimalModeChange={handleToggleMinimalMode}
                canToggleMinimalMode={true}
                conversationId={activeConversationId}
                getInitialDraft={getInputDraft}
                onDraftChange={handleDraftChangeWithCache}
                availableSkills={availableSkills}
                centerMode={true}
                showEmployeeSelector={true}
                employees={employees}
                selectedEmployeeId={newTaskEmployeeId || undefined}
                onSelectEmployee={handleSelectEmployee}
                defaultProviderId={selectedLlmProviderId}
                defaultModelId={selectedLlmModelId}
                onDefaultModelChange={handleLlmChange}
                enableThinking={enableThinking}
                onThinkingChange={setEnableThinking}
                isCompacting={isCompacting}
              />
            </div>
          ) : (
            // 对话模式
            <>
              {isComparisonMode ? (
                <MultiChatPanel
                  comparisonMessages={getComparisonMessages()}
                  providers={providers}
                  onClose={handleCloseComparison}
                  onToggleSegment={handleToggleSegment}
                  onCopy={handleCopy}
                  getToolDisplayName={getToolDisplayName}
                  onDelete={handleDeleteComparisonMessage}
                />
              ) : (
                <div ref={chatContainerRef} onScroll={handleScroll}
                  style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '16px 3%',
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
                    contextStats={contextStats}
                    isCompacting={isCompacting}
                    onCompact={handleCompact}
                  />
                  <div ref={messagesEndRef} />
                </div>
              )}
              <ChatInput
                onSend={handleSendWithReset}
                onStop={handleStop}
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
                conversationId={activeConversationId}
                getInitialDraft={getInputDraft}
                onDraftChange={setInputDraft}
                availableSkills={availableSkills}
                defaultProviderId={selectedLlmProviderId}
                defaultModelId={selectedLlmModelId}
                onDefaultModelChange={handleLlmChange}
                enableThinking={enableThinking}
                onThinkingChange={setEnableThinking}
                isCompacting={isCompacting}
              />
            </>
          )}
        </div>
      </div>

      <style>{workbenchStyle}</style>

      <EmployeeSettingsDrawer
        open={settingsOpen}
        employeeId={currentEmployeeId}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

export default Tasks
