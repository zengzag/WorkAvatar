import { useState, useEffect, useMemo, useCallback, useRef, startTransition } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import 'katex/dist/katex.min.css'
import { Button, Typography, Spin, Tooltip, theme, App, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { MenuUnfoldOutlined, PlusOutlined, RobotOutlined, FolderOpenOutlined, FolderOutlined, SettingOutlined } from '@ant-design/icons'
import MessageList from '../components/workbench/MessageList'
import ChatInput from '../components/workbench/ChatInput'
import BackgroundShellBar from '../components/workbench/BackgroundShellBar'
import MultiChatPanel from '../components/workbench/MultiChatPanel'
import TaskSidebar, { formatTaskTime, type TaskViewMode, type TaskWithEmployee } from '../components/tasks/TaskSidebar'
import TaskWorkspacePanel from '../components/tasks/TaskWorkspacePanel'
import { useTaskPanelStore } from '../stores/task-panel.store'
import EmployeeSettingsDrawer from '../components/employee-settings/EmployeeSettingsDrawer'
import EmployeeAvatar from '../components/common/EmployeeAvatar'
import { useTranslation } from 'react-i18next'
import useEmployeeChat from '../hooks/useEmployeeChat'
import { getActiveBranchData } from '../hooks/chat-helpers'
import { getCachedSceneDefaultModel } from '../utils/default-model'
import { subscribePendingTaskJump } from '../utils/pending-task-jump'
import { getDirName } from '../utils/format'
import { PluginViewSlot } from '../plugins/view-slot'
import type { AttachedImage, ModelSelection } from '../components/workbench'
import type { AvailableSkill } from '../components/workbench/ChatInput'
import type { Employee, GeneratedFileInfo } from '../types'

const { Paragraph } = Typography

const HorizontalDotsIcon: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" style={style}>
    <circle cx="2.5" cy="8" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="13.5" cy="8" r="1.5" />
  </svg>
)

const SidePanelIcon: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.3" style={style}>
    <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" />
    <line x1="10.2" y1="2.6" x2="10.2" y2="13.4" />
  </svg>
)

const Tasks: React.FC = () => {
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { token } = theme.useToken()
  const { t } = useTranslation()

  const PAGE_SIZE = 20
  const VIEW_MODE_KEY = 'tasks:viewMode'

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeesLoaded, setEmployeesLoaded] = useState(false)
  const [globalTasks, setGlobalTasks] = useState<TaskWithEmployee[]>([])
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [selectedModels, setSelectedModels] = useState<ModelSelection[]>([])
  const [allCollections, setAllCollections] = useState<any[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showSidePanel, setShowSidePanel] = useState(true)

  // 右侧工作区面板（文件 / 终端 / 产物预览）
  const panelOpen = useTaskPanelStore((s) => s.open)
  const panelExpanded = useTaskPanelStore((s) => s.expanded)
  // 仅在面板打开时进入全屏布局：关闭面板后全屏状态仍保留，但需正常显示任务列表与对话栏
  const panelFullscreen = panelOpen && panelExpanded
  const openPanel = useTaskPanelStore((s) => s.openPanel)
  const closePanel = useTaskPanelStore((s) => s.closePanel)
  const resetPanel = useTaskPanelStore((s) => s.reset)

  // 分页相关状态
  const [loadedCount, setLoadedCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  // loadedCount 镜像：供 loadGlobalTasks 读取最新已加载条数，且不进入其依赖（避免刷新函数频繁变化）
  const loadedCountRef = useRef(0)
  useEffect(() => { loadedCountRef.current = loadedCount }, [loadedCount])

  // 任务模式：'new' = 新任务（居中输入框），'chat' = 对话模式
  const [taskMode, setTaskMode] = useState<'new' | 'chat'>('new')
  // 新任务时用户选择的员工
  const [newTaskEmployeeId, setNewTaskEmployeeId] = useState<string | null>(null)
  // 新任务时用户指定的工作区目录（null = 默认工作区，自动创建任务目录）
  const [newTaskWorkspacePath, setNewTaskWorkspacePath] = useState<string | null>(null)
  // 当前对话对应的员工ID（传给 useEmployeeChat）
  const [currentEmployeeId, setCurrentEmployeeId] = useState<string | undefined>(undefined)
  // 待选择的对话ID（跨员工切换时使用）
  const pendingSelectConvIdRef = useRef<string | null>(null)
  // 上一次 employee 加载状态，用于检测初始化完成
  const prevEmployeeLoadedRef = useRef(false)
  // currentEmployeeId 镜像（供事件回调读取最新值）
  const currentEmployeeIdRef = useRef<string | undefined>(currentEmployeeId)
  useEffect(() => { currentEmployeeIdRef.current = currentEmployeeId }, [currentEmployeeId])

  // 搜索
  const [searchQuery, setSearchQuery] = useState('')
  // 任务列表视图：列表（时间分组）/ 员工分组
  const [viewMode, setViewMode] = useState<TaskViewMode>(() => {
    try {
      const saved = localStorage.getItem(VIEW_MODE_KEY)
      return saved === 'employee' || saved === 'workspace' ? saved : 'list'
    } catch {
      return 'list'
    }
  })
  // 全文内容搜索匹配的任务 ID 集合（null = 未搜索，Set = 搜索结果）
  const [contentMatchIds, setContentMatchIds] = useState<Set<string> | null>(null)

  // 是否使用全量模式：有搜索或分组视图时使用全量加载，否则分页模式下初始加载20条，滚动加载更多
  // 分组视图需要拿到全部任务，才能让"每组只看最近5条"不受加载进度限制
  const useFullLoad = !!searchQuery.trim() || !!contentMatchIds || viewMode !== 'list'

  const handleViewModeChange = useCallback((mode: TaskViewMode) => {
    setViewMode(mode)
    try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch {}
  }, [])

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
        // 分页模式：保持当前已加载条数，避免刷新（如选中任务）后列表被截断回 PAGE_SIZE
        // 导致容器高度骤减、滚动位置被浏览器钳制而出现"弹跳"；reset 时按首页大小重新加载
        const limit = opts?.reset ? PAGE_SIZE : Math.max(PAGE_SIZE, loadedCountRef.current)
        const result = await window.electronAPI.conversation.listAll({ limit, offset: 0 })
        const arr = Array.isArray(result) ? result : []
        setGlobalTasks(arr)
        setLoadedCount(arr.length)
        setHasMore(arr.length === limit)
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

  // 全量模式（搜索/员工分组）与分页模式切换时重新加载列表：
  // 进入全量模式拉取全部；退回分页模式时按首页大小重载，相当于重新打开任务列表，避免一次渲染全部任务卡顿
  const prevFullLoadRef = useRef(useFullLoad)
  useEffect(() => {
    const wasFullLoad = prevFullLoadRef.current
    prevFullLoadRef.current = useFullLoad
    if (useFullLoad) {
      loadGlobalTasks({ forceFull: true, reset: true })
    } else if (wasFullLoad) {
      loadGlobalTasks({ reset: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useFullLoad])

  const loadAllCollections = useCallback(async () => {
    try {
      const result = await window.electronAPI.kms.listCollections()
      setAllCollections(Array.isArray(result) ? result : [])
    } catch {}
  }, [])

  // 稳定引用：loadGlobalTasks 依赖 useFullLoad，直接放进 effect 依赖会导致
  // 每次进入/退出搜索都重新拉员工与合集列表
  const loadGlobalTasksRef = useRef(loadGlobalTasks)
  useEffect(() => { loadGlobalTasksRef.current = loadGlobalTasks }, [loadGlobalTasks])

  useEffect(() => {
    loadEmployees()
    loadGlobalTasksRef.current()
    loadAllCollections()
  }, [loadEmployees, loadAllCollections])

  // 资料库合集增删改通知：实时刷新合集列表，避免新合集需重启才出现在输入框
  useEffect(() => {
    const unsub = window.electronAPI.kms.onCollectionsChanged(() => {
      loadAllCollections()
    })
    return () => { unsub?.() }
  }, [loadAllCollections])

  // 员工列表变更通知（增删改）：刷新列表 & 清理无效选中
  useEffect(() => {
    const unsub = window.electronAPI.employee.onChanged(async () => {
      await loadEmployees()
      await loadGlobalTasksRef.current()
    })
    return () => { unsub?.() }
  }, [loadEmployees])

  // 清理无效选中态：newTaskEmployeeId / currentEmployeeId 若不在员工列表中则重置
  useEffect(() => {
    if (!employeesLoaded) return
    const ids = new Set(employees.map(e => e.id))
    if (newTaskEmployeeId && !ids.has(newTaskEmployeeId)) {
      setNewTaskEmployeeId(null)
    }
    if (currentEmployeeId && !ids.has(currentEmployeeId)) {
      setCurrentEmployeeId(undefined)
    }
  }, [employees, employeesLoaded, newTaskEmployeeId, currentEmployeeId])

  // 新任务模式下自动选择第一个员工，避免未选员工时发送消息无效
  useEffect(() => {
    if (taskMode === 'new' && employees.length > 0 && !currentEmployeeId) {
      const firstEmpId = employees[0].id
      setNewTaskEmployeeId(firstEmpId)
      setCurrentEmployeeId(firstEmpId)
      prevEmployeeLoadedRef.current = false
    }
  }, [taskMode, employees, currentEmployeeId])

  // 全文内容搜索：输入框侧已做防抖，这里直接请求；请求序号用于丢弃过期结果
  const searchSeqRef = useRef(0)
  useEffect(() => {
    const trimmed = searchQuery.trim()
    if (!trimmed) {
      setContentMatchIds(null)
      return
    }
    const seq = ++searchSeqRef.current
    window.electronAPI.conversation.searchGlobal({
      query: trimmed,
      limit: 50,
    }).then((results) => {
      if (seq !== searchSeqRef.current) return
      // 检索结果作为低优先级更新，避免阻塞输入/流式渲染
      startTransition(() => {
        setContentMatchIds(new Set(Array.isArray(results) ? results.map((r: any) => r.conversationId) : []))
      })
    }).catch(() => {
      if (seq !== searchSeqRef.current) return
      startTransition(() => setContentMatchIds(new Set()))
    })
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
    getInputModels,
    setInputModels,
    inputDefaultModel,
    setInputDefaultModel,
    providers,
    selectedLlmProviderId,
    selectedLlmModelId,
    handleLlmChange,
    enableThinking,
    setEnableThinking,
    selectedCollectionIds,
    setSelectedCollectionIds,
    setPersistentCollectionIds,
    minimalMode,
    handleToggleMinimalMode,
    isComparisonMode,
    getComparisonMessages,
    handleCloseComparison,
    handleDeleteComparisonMessage,
    handleOpenComparison,
    chatContainerRef,
    handleScroll,
    handleSend,
    handleStop,
    selectConversation,
    clearActiveConversation,
    handleCopy,
    handleDeleteMessage,
    handleRegenerate,
    handleRetryMessage,
    handleSwitchModelRegenerate,
    handleEditAndResubmit,
    handleToggleSegment,
    handleSwitchBranch,
    handleBranchMessage,
    getToolDisplayName,
    isConversationStreaming,
    generateConversationTitle,
    contextStats,
    isCompacting,
    handleCompact,
  } = chatHook

  // 稳定的场景默认模型（workbench 全局默认），作为未绑定模型对话的回退值。
  // 不使用可变的员工级 selectedLlmProviderId，避免 A 任务设置的模型串扰到未绑定的 B 任务
  const sceneDefaultModel = useMemo(() => getCachedSceneDefaultModel('workbench'), [])

  // 当前任务（含任务工作区路径），供状态栏、工作区面板与打开目录使用
  const activeTask = useMemo(
    () => globalTasks.find(t => t.id === activeConversationId),
    [globalTasks, activeConversationId],
  )
  // 列表未包含当前任务（如通知跳转到分页外任务）时，单独取一次任务详情（工作区/标题）
  const [fetchedConv, setFetchedConv] = useState<any>(null)
  useEffect(() => {
    if (taskMode !== 'chat' || !activeConversationId || activeTask?.workspace_path) {
      setFetchedConv(null)
      return
    }
    let cancelled = false
    window.electronAPI.conversation.get(activeConversationId)
      .then((conversation: any) => { if (!cancelled) setFetchedConv(conversation || null) })
      .catch(() => { if (!cancelled) setFetchedConv(null) })
    return () => { cancelled = true }
  }, [taskMode, activeConversationId, activeTask])
  // 顶部状态栏展示信息：任务标题 / 数字员工名称 / 最后活动时间
  // activeTask 不在列表中时（通知/搜索跳转到分页外任务）回退到 fetchedConv
  const statusConv = activeTask || fetchedConv
  const statusEmployeeName = taskMode === 'chat'
    ? (statusConv?.employee_name || employee?.name || '')
    : (employees.find(e => e.id === newTaskEmployeeId)?.name || '')
  const statusTimeText = taskMode === 'chat' && statusConv
    ? formatTaskTime(statusConv.last_message_at ?? statusConv.created_at, t)
    : ''
  // 状态栏员工头像数据：对话模式用当前员工，新任务模式用所选员工
  const statusEmployee = taskMode === 'chat'
    ? employee
    : employees.find(e => e.id === newTaskEmployeeId)
  // 顶部状态栏工作区：任务指定目录取目录名，自动创建的目录归入默认工作区；新任务用待发送的工作区
  const statusWorkspacePath = taskMode === 'chat'
    ? (statusConv?.workspace_mode === 'custom' ? statusConv?.workspace_path : null)
    : newTaskWorkspacePath
  const statusWorkspaceLabel = statusWorkspacePath ? getDirName(statusWorkspacePath) : t('tasks.defaultWorkspace')
  // 工作区面板根目录：仅使用任务工作区（新任务或旧对话无目录时为空）
  const panelRootPath = useMemo(() => {
    if (taskMode === 'chat') {
      return activeTask?.workspace_path || fetchedConv?.workspace_path || null
    }
    return null
  }, [taskMode, activeTask, fetchedConv])
  // 状态栏工作区可打开的目录：任务模式打开任务工作区，新任务模式打开待发送的所选目录
  const statusWorkspaceOpenPath = taskMode === 'chat'
    ? (panelRootPath || undefined)
    : (statusWorkspacePath || undefined)
  // 终端会话按任务隔离：任务内 cd 状态与运行中命令互不干扰
  const terminalId = taskMode === 'chat' && activeConversationId
    ? `conv:${activeConversationId}`
    : `emp:${currentEmployeeId || 'none'}`

  // 侧边栏产物列表：聚合本任务消息中产物工具声明的文件，按最新调用倒序，同路径只保留最新一次
  const taskArtifacts = useMemo(() => {
    const latest = new Map<string, { file: GeneratedFileInfo; order: number; index: number }>()
    let order = 0
    for (const msg of messages) {
      const segments = getActiveBranchData(msg).segments
      if (!segments) continue
      for (const seg of segments) {
        const files = seg.generatedFiles?.length
          ? seg.generatedFiles
          : [...(seg.runResult?.generatedFiles || []), ...(seg.runResult?.autoDetectedFiles || [])]
        order++
        files.forEach((file, index) => latest.set(file.path, { file, order, index }))
      }
    }
    return Array.from(latest.values())
      .sort((a, b) => b.order - a.order || a.index - b.index)
      .map(item => item.file)
  }, [messages])

  // 切换任务时清理预览标签，避免面板展示上一个任务的文件
  useEffect(() => { resetPanel() }, [activeConversationId, taskMode, resetPanel])

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
    const load = () => {
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
    }
    load()
    // 技能安装/启停/分配变更后即时刷新技能下拉，无需重启
    const unsubscribe = window.electronAPI.skillRegistry.onChanged?.(load)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
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
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.employee_name || '').toLowerCase().includes(q) ||
        (contentMatchIds?.has(t.id) ?? false)
      )
    }
    return result
  }, [globalTasks, searchQuery, contentMatchIds])

  // 新建任务（保留当前已选员工，清除激活对话避免新消息发到旧对话）
  // 注意：不在此处清空草稿缓存，用户从任务切换回新任务时保留之前输入的草稿；
  // 发送成功后由 handleSendWithReset 的 clearNewTaskDraft 清理，保证新任务干净开始
  const handleNewTask = useCallback(() => {
    setTaskMode('new')
    const empId = currentEmployeeId || null
    setNewTaskEmployeeId(empId)
    pendingSelectConvIdRef.current = null
    setAttachedImages([])
    setSelectedModels([])
    clearActiveConversation()
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

  // 跨页面"定位任务"跳转消费（全局搜索 / 通知点击发起）
  useEffect(() => {
    return subscribePendingTaskJump((jump) => {
      setTaskMode('chat')
      if (jump.employeeId === currentEmployeeIdRef.current) {
        pendingSelectConvIdRef.current = null
        prevEmployeeLoadedRef.current = true
        selectConversation(jump.conversationId)
      } else {
        pendingSelectConvIdRef.current = jump.conversationId
        prevEmployeeLoadedRef.current = false
        setCurrentEmployeeId(jump.employeeId)
      }
    })
  }, [selectConversation])

  // 删除任务
  const handleDeleteTask = useCallback(async (taskId: string) => {
    try {
      const res: any = await window.electronAPI.conversation.delete(taskId)
      setGlobalTasks(prev => prev.filter(t => t.id !== taskId))
      if (taskId === activeConversationId) {
        handleNewTask()
      }
      message.success(t('workbench.deleteSuccess'))
      // 工作区目录非空时，询问是否一并删除工作区目录
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
      // 存在非空工作区目录时，询问是否一并删除
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

  // 新任务草稿 getter：直接读 localStorage，保证 ChatInput 重新挂载/员工首次确定时
  // 恢复的是新任务草稿，而不是上一个任务残留的编辑内容
  const getNewTaskDraft = useCallback(() => {
    if (!newTaskDraftKey) return ''
    try {
      const raw = localStorage.getItem(newTaskDraftKey)
      if (!raw) return ''
      const data = JSON.parse(raw)
      return typeof data.content === 'string' ? data.content : ''
    } catch {
      return ''
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

  // 对话模式下，监听模型变化并持久化到当前对话缓存（各任务独立存储模型选择）
  const handleChatModelsChange = useCallback((models: ModelSelection[]) => {
    setSelectedModels(models)
    setInputModels(models)
  }, [setSelectedModels, setInputModels])

  // 切换对话时恢复该对话自己的模型选择，避免上一个任务的模型串扰到当前任务
  useEffect(() => {
    setSelectedModels(getInputModels())
  }, [activeConversationId, getInputModels])

  // 新任务模式下，监听知识库变化并持久化
  const handleCollectionIdsChangeWithCache = useCallback((ids: string[]) => {
    setSelectedCollectionIds(ids)
    saveNewTaskDraft({ selectedCollectionIds: ids })
  }, [setSelectedCollectionIds, saveNewTaskDraft])

  // 发送消息
  const handleSendWithReset = useCallback(async (content: string, images: string[], models: ModelSelection[], options?: { highPermission?: boolean }) => {
    setAttachedImages([])
    setSelectedModels([])
    setInputModels([])
    clearNewTaskDraft()
    // 新建任务时把选定的工作区目录传给会话创建（null 表示默认工作区）
    const workspacePath = newTaskWorkspacePath || undefined
    setNewTaskWorkspacePath(null)
    await handleSend(content, images, models, { ...options, workspacePath })
    // 发送后切换到对话模式；任务列表由 activeConversationId/taskMode 变化触发的
    // useEffect 刷新（此时 sendMessage 已完成持久化，listAll 一定能查到新任务）
    if (taskMode === 'new') {
      setTaskMode('chat')
    }
  }, [handleSend, taskMode, clearNewTaskDraft, setInputModels, newTaskWorkspacePath])

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

  // 新任务工作区选择器的「最近使用」列表：取用户手动指定过的目录（任务列表按活跃时间倒序）
  const recentWorkspaces = useMemo(() => {
    const map = new Map<string, { path: string; label: string }>()
    for (const task of globalTasks) {
      if (task.workspace_mode !== 'custom' || !task.workspace_path) continue
      const path = task.workspace_path.replace(/[\\/]+$/, '')
      if (!path) continue
      // 路径大小写不敏感（Windows），统一小写去重
      const key = path.toLowerCase()
      if (!map.has(key)) map.set(key, { path, label: getDirName(path) })
    }
    return Array.from(map.values())
  }, [globalTasks])

  // 新任务：选择用户指定的工作区目录（选择后选择器切换到该目录，默认工作区不受影响）
  const handlePickWorkspace = useCallback(async () => {
    try {
      const result = await window.electronAPI.app.showOpenDialog({
        title: t('tasks.chooseWorkspaceDir'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths.length) return
      setNewTaskWorkspacePath(result.filePaths[0])
    } catch {
      message.error(t('tasks.selectWorkspaceFailed'))
    }
  }, [t, message])

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

  // 打开当前任务的工作区目录
  const handleOpenTaskWorkspace = useCallback(() => {
    openDirInExplorer(panelRootPath || undefined)
  }, [panelRootPath, openDirInExplorer])

  // 状态栏工作区标签：点击直接在系统文件管理器中打开
  const handleOpenStatusWorkspace = useCallback(() => {
    openDirInExplorer(statusWorkspaceOpenPath)
  }, [statusWorkspaceOpenPath, openDirInExplorer])

  // 打开执行当前任务的数字员工设置抽屉
  const handleOpenEmployeeSettings = useCallback(() => {
    const activeTask = globalTasks.find(t => t.id === activeConversationId)
    if (activeTask?.employee_id && activeTask.employee_id !== currentEmployeeId) {
      setCurrentEmployeeId(activeTask.employee_id)
    }
    setSettingsOpen(true)
  }, [globalTasks, activeConversationId, currentEmployeeId])

  const moreMenuItems = useMemo<MenuProps['items']>(() => {
    return [
      {
        key: 'openTaskWorkspace',
        icon: <FolderOpenOutlined />,
        label: t('workbench.openTaskWorkspace'),
        onClick: handleOpenTaskWorkspace,
      },
      {
        key: 'openEmployeeSettings',
        icon: <SettingOutlined />,
        label: t('workbench.openEmployeeSettings'),
        onClick: handleOpenEmployeeSettings,
      },
    ]
  }, [t, handleOpenTaskWorkspace, handleOpenEmployeeSettings])

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

  // 其他窗口（小秘书 / 自动化）创建、改名或删除任务：实时刷新列表，避免要等任务完成才能看到
  useEffect(() => {
    let timer: number | null = null
    const off = window.electronAPI.conversation.onChanged(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        loadGlobalTasksRef.current()
      }, 200)
    })
    return () => {
      if (timer) window.clearTimeout(timer)
      off?.()
    }
  }, [])

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
        {/* 全屏预览模式下隐藏任务列表与对话栏，侧边栏占满 */}
        {!panelFullscreen && showSidePanel && (
          <TaskSidebar
            tasks={filteredTasks}
            activeTaskId={taskMode === 'new' ? null : activeConversationId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            viewMode={viewMode}
            onViewModeChange={handleViewModeChange}
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

        {!panelFullscreen && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* 顶部状态栏：侧边栏展开/新建任务 + 任务标题/员工/时间 + 右侧操作区 */}
          <div className="wa-workbench-topbar" style={{
            flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', gap: 8,
            padding: '0 14px',
          }}>
            {!showSidePanel && (
              <>
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
              </>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
              <span title={statusConv?.title} style={{
                fontSize: 13.5, fontWeight: 620, color: token.colorText, letterSpacing: '-0.01em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
              }}>
                {statusConv?.title || t('tasks.newTask')}
              </span>
              {statusEmployeeName && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  {statusEmployee ? (
                    <EmployeeAvatar
                      avatarIcon={statusEmployee.avatar_icon}
                      avatarColor={statusEmployee.avatar_color}
                      avatarImage={statusEmployee.avatar_image}
                      avatarType={statusEmployee.avatar_type}
                      employeeId={statusEmployee.id}
                      source={statusEmployee.source}
                      size={15}
                    />
                  ) : (
                    <RobotOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
                  )}
                  <span style={{ fontSize: 12, color: token.colorTextSecondary }}>{statusEmployeeName}</span>
                </span>
              )}
              {statusTimeText && (
                <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0 }}>{statusTimeText}</span>
              )}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
              {/* 工作区目录：点击打开对应文件夹 */}
              <Tooltip title={statusWorkspaceOpenPath || statusWorkspaceLabel}>
                <span
                  className={statusWorkspaceOpenPath ? 'wa-topbar-workspace' : undefined}
                  onClick={handleOpenStatusWorkspace}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 200,
                    height: 22, padding: '0 8px', borderRadius: 6, lineHeight: 1,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    color: token.colorTextSecondary, fontSize: 12,
                    cursor: statusWorkspaceOpenPath ? 'pointer' : 'default',
                    flexShrink: 0,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {statusWorkspaceLabel}
                  </span>
                  <span style={{ width: 1, height: 12, background: token.colorBorderSecondary, flexShrink: 0 }} />
                  <FolderOutlined style={{ fontSize: 12 }} />
                </span>
              </Tooltip>
              {/* 插件视图注入点：任务对话页头部操作区 */}
              {taskMode === 'chat' && <PluginViewSlot view="chat.header" />}
              {taskMode === 'chat' && (
                <Dropdown menu={{ items: moreMenuItems }} trigger={['click']} placement="bottomRight">
                  <Button type="text" size="small"
                    icon={<HorizontalDotsIcon style={{ fontSize: 14 }} />}
                    style={{ color: token.colorTextSecondary, width: 28, height: 28, minWidth: 28, borderRadius: 6 }}
                  />
                </Dropdown>
              )}
              <Tooltip title={panelOpen ? t('workbench.closePanel') : t('workbench.panelOpen')}>
                <Button type="text" size="small"
                  icon={<SidePanelIcon style={{ fontSize: 15 }} />}
                  onClick={() => { panelOpen ? closePanel() : openPanel() }}
                  style={{
                    color: panelOpen ? token.colorPrimary : token.colorTextSecondary,
                    background: panelOpen ? token.colorFillSecondary : undefined,
                    width: 28, height: 28, minWidth: 28, borderRadius: 6,
                  }}
                />
              </Tooltip>
            </div>
          </div>
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
                getInitialDraft={getNewTaskDraft}
                draftRestoreKey={newTaskDraftKey}
                onDraftChange={handleDraftChangeWithCache}
                availableSkills={availableSkills}
                centerMode={true}
                showEmployeeSelector={true}
                workspaceSelector={{
                  path: newTaskWorkspacePath,
                  recent: recentWorkspaces,
                  onSelectDefault: () => setNewTaskWorkspacePath(null),
                  onSelectPath: setNewTaskWorkspacePath,
                  onPick: handlePickWorkspace,
                }}
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
                  className="wa-message-scroll"
                  style={{
                    flex: 1,
                    overflow: 'auto',
                    padding: '18px 3% 8px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 20,
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
                    onRetry={handleRetryMessage}
                    onSwitchModelRegenerate={handleSwitchModelRegenerate}
                    onEditAndResubmit={handleEditAndResubmit}
                    onToggleSegment={handleToggleSegment}
                    onSwitchBranch={handleSwitchBranch}
                    onBranch={handleBranchMessage}
                    onOpenComparison={handleOpenComparison}
                    getToolDisplayName={getToolDisplayName}
                    providers={providers}
                    contextStats={contextStats}
                    isCompacting={isCompacting}
                    onCompact={handleCompact}
                    assistantEmployee={employee}
                  />
                </div>
              )}
              {/* 后台长跑任务：agent 异常中止后用户仍可在此手动停止 */}
              <BackgroundShellBar conversationId={activeConversationId ?? undefined} />
              <ChatInput
                onSend={handleSendWithReset}
                onStop={handleStop}
                isStreaming={isStreaming}
                placeholder={t('workbench.inputPlaceholder')}
                providers={providers}
                attachedImages={attachedImages}
                onImagesChange={setAttachedImages}
                selectedModels={selectedModels}
                onModelsChange={handleChatModelsChange}
                selectedCollectionIds={selectedCollectionIds}
                onSelectedCollectionIdsChange={setPersistentCollectionIds}
                allCollections={allCollections}
                minimalMode={minimalMode}
                onMinimalModeChange={handleToggleMinimalMode}
                canToggleMinimalMode={messages.length === 0}
                conversationId={activeConversationId}
                getInitialDraft={getInputDraft}
                onDraftChange={setInputDraft}
                availableSkills={availableSkills}
                defaultProviderId={inputDefaultModel?.providerId || sceneDefaultModel?.provider_id || ''}
                defaultModelId={inputDefaultModel?.modelId || sceneDefaultModel?.model_id || ''}
                onDefaultModelChange={setInputDefaultModel}
                enableThinking={enableThinking}
                onThinkingChange={setEnableThinking}
                isCompacting={isCompacting}
              />
            </>
          )}
          </div>
        )}

        {panelOpen && (
          <TaskWorkspacePanel
            rootPath={panelRootPath}
            terminalId={terminalId}
            artifacts={taskArtifacts}
            onClose={closePanel}
          />
        )}
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
