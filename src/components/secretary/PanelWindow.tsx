import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Badge, Button, Dropdown, Tooltip, theme } from 'antd'
import {
  CloseOutlined,
  PaperClipOutlined,
  SendOutlined,
  SwapOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SettingOutlined,
  EyeInvisibleOutlined,
  StopOutlined,
  BulbOutlined,
  BulbFilled,
  RobotOutlined,
  CheckOutlined,
  BellOutlined,
  UnorderedListOutlined,
  ExportOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import EmployeeAvatar, { resolveEmployeeAvatarIcon } from '../common/EmployeeAvatar'
import { getCachedSceneDefaultModel } from '../../utils/default-model'
import { generateId } from '../../utils/format'
import { getProviderModels, supportsReasoningEffort, supportsThinking } from '../../utils/llm'
import type { Employee, LLMProvider, ThinkingLevel } from '../../types'
import {
  useSecretaryStore,
  selectRunningTasks,
  selectFinishedTasks,
  selectUnreadNotices,
  type SecretaryTask,
  type SecretaryNotice,
} from './secretary.store'
import {
  startSecretaryTask,
  continueSecretaryTask,
  abortSecretaryTask,
  broadcastSecretaryState,
  installSecretaryRunner,
} from './secretary-runner'
import { syncRemoteTasks, abortRemoteTask, dismissRemoteTask } from './secretary-remote'
import { postSecretaryMessage, subscribeSecretaryBus, SECRETARY_PENDING_FILES_KEY } from './secretary-bus'
import { selectModalRequest, useInteractionStore, type InteractionRequest } from '../../stores/interaction.store'
import UnifiedInteractionModal from '../common/UnifiedInteractionModal'
import SecretaryComposer, { type ComposerFile, type ComposerHandle } from './SecretaryComposer'
import SecretaryChat from './SecretaryChat'
import './secretary.css'

const EMPLOYEE_KEY = 'wa.secretary.employeeId'
/** 面板上选中的模型与思考开关（会话级偏好，落 localStorage 供两个窗口共享） */
const MODEL_PROVIDER_KEY = 'wa.secretary.providerId'
const MODEL_ID_KEY = 'wa.secretary.modelId'
const THINKING_KEY = 'wa.secretary.thinking'
/** 小秘书默认开启思考（支持时） */
const DEFAULT_THINKING: ThinkingLevel = 'high'
/** 面板固定尺寸：进入不同页面不再随内容跳变，用户可拖拽边缘调整（与主进程 clamp 保持一致） */
const PANEL_DEFAULT_WIDTH = 372
const PANEL_MIN_WIDTH = 300
const PANEL_MAX_WIDTH = 640
const PANEL_DEFAULT_HEIGHT = 420
const PANEL_MIN_HEIGHT = 320
const PANEL_MAX_HEIGHT = 900

/** 面板可拖拽的边缘与角 */
type ResizeEdge = 'left' | 'right' | 'top' | 'bottom'
  | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** 从路径里取文件名 */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 读取本地保存的思考强度；未保存过用默认（开启） */
function readStoredThinking(): ThinkingLevel {
  const stored = localStorage.getItem(THINKING_KEY)
  if (stored === 'false') return false
  if (stored === 'low' || stored === 'medium' || stored === 'high') return stored
  return DEFAULT_THINKING
}

/** 面板主体视图：任务 / 通知两个常驻 Tab，对话从任务行进入 */
type PanelTab = 'tasks' | 'notices'
type PanelView = PanelTab | 'chat' | 'employee' | 'settings'

/** 通知弹出卡片停留时长：超时后收起面板，通知保留在通知列表 */
const NOTICE_POPUP_TIMEOUT_MS = 10000
/** 用户交互确认框在小秘书里的自动收起时长：只收起面板，请求仍保留，可下次重新打开继续处理 */
const INTERACTION_AUTO_HIDE_MS = 20000

/** 上次关闭时的 Tab，重新打开面板时回到这里；对话不恢复，默认回到任务面板 */
const VIEW_KEY = 'wa.secretary.panelView'

function readStoredTab(): PanelTab {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
    // 兼容旧版：overlay 为 tasks / notices 时沿用，其余一律回到任务
    return (parsed?.tab ?? parsed?.overlay) === 'notices' ? 'notices' : 'tasks'
  } catch {
    return 'tasks'
  }
}

/** 面板窗：以对话为主体，任务与通知收纳在头部入口里 */
const SecretaryPanel: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string>(() => localStorage.getItem(EMPLOYEE_KEY) || '')
  const [sending, setSending] = useState(false)
  const [dropping, setDropping] = useState(false)
  /** 挂载时读取上次停留的 Tab（任务/通知），对话不恢复 */
  const [view, setView] = useState<PanelView>(readStoredTab)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modelProviderId, setModelProviderId] = useState(
    () => localStorage.getItem(MODEL_PROVIDER_KEY) || getCachedSceneDefaultModel('workbench')?.provider_id || '',
  )
  const [modelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_ID_KEY) || getCachedSceneDefaultModel('workbench')?.model_id || '',
  )
  const [thinking, setThinking] = useState<ThinkingLevel>(readStoredThinking)
  /** 正在查看的任务（对话视图）；空 = 任务面板 */
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  /** 从员工/设置页返回时回到进入前的视图 */
  const overlayReturnRef = useRef<PanelView>('tasks')
  /** 主窗口失焦时的通知弹窗卡片；超时或「知道了」后收起 */
  const [popup, setPopup] = useState<SecretaryNotice | null>(null)
  const popupTimerRef = useRef(0)
  /** 面板当前是否可见：确认框的自动收起倒计时只在可见时进行 */
  const [panelVisible, setPanelVisible] = useState(false)
  /** 同步可见性：IPC 事件回调里要立即读到「请求到达前面板是否已打开」 */
  const panelVisibleRef = useRef(false)
  const updatePanelVisible = useCallback((open: boolean) => {
    panelVisibleRef.current = open
    setPanelVisible(open)
  }, [])
  /** 本次确认框是否由小秘书自动弹出（请求到达前面板未打开）：处理完自动收起面板 */
  const interactionAutoOpenedRef = useRef(false)
  /** 程序主动收起（确认框超时 / 处理完成），跳过「有确认框时拒绝收起」的保护 */
  const autoHidingRef = useRef(false)
  /** 从通知列表显式打开确认框：用户已主动开始处理，不再倒计时自动隐藏 */
  const [manualInteractionId, setManualInteractionId] = useState<string | null>(null)
  /** 上一次可见的确认框 id：用于判断交互队列是否已清空 */
  const prevInteractionIdRef = useRef<string | undefined>(undefined)
  /** 拖拽边缘调整宽高时的起点 */
  const resizeOriginRef = useRef<{ edge: ResizeEdge; x: number; y: number; width: number; height: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  /** 是否有待处理的权限 / ask_user 弹窗（弹窗挂在本窗口，收起面板会让它看不见） */
  const pendingRef = useRef(false)

  const employee = useMemo(
    () => employees.find((e) => e.id === employeeId) || employees[0],
    [employees, employeeId],
  )

  const tasks = useSecretaryStore((s) => s.tasks)
  const remoteTasks = useSecretaryStore((s) => s.remoteTasks)
  const markViewed = useSecretaryStore((s) => s.markViewed)
  const removeTask = useSecretaryStore((s) => s.removeTask)
  const notices = useSecretaryStore((s) => s.notices)
  const addNotice = useSecretaryStore((s) => s.addNotice)
  const markNoticeViewed = useSecretaryStore((s) => s.markNoticeViewed)
  const removeNotice = useSecretaryStore((s) => s.removeNotice)
  /** 本地任务 + 主窗口任务镜像：面板里统一展示，来源只影响点击/停止/完成的行为 */
  const allTasks = useMemo(() => [...remoteTasks, ...tasks], [remoteTasks, tasks])
  const running = useMemo(
    () => selectRunningTasks(allTasks).sort((a, b) => b.startedAt - a.startedAt),
    [allTasks],
  )
  const finished = useMemo(
    () => selectFinishedTasks(allTasks).sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
    [allTasks],
  )
  const unreadNoticeCount = useMemo(() => selectUnreadNotices(notices).length, [notices])
  const activeTask = useMemo(() => {
    const task = activeTaskId ? allTasks.find((t) => t.id === activeTaskId) : undefined
    // 对话必须属于当前员工：切换员工后不会把上一个员工的会话挂在这个身份下
    if (task && employee && task.employee.id !== employee.id) return undefined
    return task
  }, [allTasks, activeTaskId, employee])
  /** 头部状态：对话态看当前任务，列表态看最近一条执行中任务（与挂件头顶信息一致） */
  const headTask = view === 'chat' ? activeTask : running[0]
  /** 对话态且当前任务在跑：输入框先停下来，避免同一会话并发提问；任务/通知列表态仍可派新任务 */
  const busy = sending
    || (view === 'chat' && (activeTask?.status === 'running' || activeTask?.status === 'waiting'))

  /** 收起通知弹窗；hide=true 时同时收起面板（「知道了」/超时） */
  const clearPopup = useCallback((hide = false) => {
    if (popupTimerRef.current) {
      window.clearTimeout(popupTimerRef.current)
      popupTimerRef.current = 0
    }
    setPopup(null)
    if (hide) window.electronAPI.secretary.hidePanel()
  }, [])

  /** 主窗口不在前台时直接弹出通知卡片，10s 无操作自动收起（通知留在列表里） */
  const showNoticePopup = useCallback((notice: SecretaryNotice) => {
    setPopup(notice)
    if (popupTimerRef.current) window.clearTimeout(popupTimerRef.current)
    popupTimerRef.current = window.setTimeout(() => {
      popupTimerRef.current = 0
      setPopup(null)
      // 收起后下次打开直接落到通知列表，方便回看
      setView('notices')
      window.electronAPI.secretary.hidePanel()
    }, NOTICE_POPUP_TIMEOUT_MS)
  }, [])

  /** 主窗口任务镜像：员工信息用于头像/配色，事件回调取最新值，避免重复订阅 */
  const employeesRef = useRef<Employee[]>([])
  const syncRemote = useCallback(() => {
    void syncRemoteTasks(employeesRef.current)
  }, [])

  // 主窗口任务的新增/改名/删除、以及运行会话变化时刷新镜像
  useEffect(() => {
    let timer: number | null = null
    const scheduleSync = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        syncRemote()
      }, 250)
    }
    const off = window.electronAPI.conversation.onChanged?.((data) => {
      if (data.action === 'create' || data.action === 'update') {
        scheduleSync()
        return
      }
      const state = useSecretaryStore.getState()
      for (const task of state.tasks) {
        const hit = data.action === 'delete'
          ? task.conversationId === data.id
          : task.employee.id === data.id
        if (!hit) continue
        // 会话已被删除：在跑的任务一并停掉，避免后台继续消耗模型调用
        if (task.status === 'running' || task.status === 'waiting') void abortSecretaryTask(task.id)
        state.removeTask(task.id)
      }
      for (const task of state.remoteTasks) {
        const hit = data.action === 'delete'
          ? task.conversationId === data.id
          : task.employee.id === data.id
        if (!hit) continue
        if (task.status === 'running' || task.status === 'waiting') void abortRemoteTask(task)
        state.removeRemoteTask(task.id)
      }
      scheduleSync()
    })
    const offStarted = window.electronAPI.llm.onSessionStarted?.(() => scheduleSync())
    return () => {
      if (timer) window.clearTimeout(timer)
      off?.()
      offStarted?.()
    }
  }, [syncRemote])

  // 首次挂载先按会话列表拉一次；员工列表加载完成后带着头像信息再同步
  useEffect(() => { syncRemote() }, [syncRemote])

  useEffect(() => {
    employeesRef.current = employees
    if (employees.length > 0) syncRemote()
  }, [employees, syncRemote])

  const hasRemoteRunning = useMemo(
    () => remoteTasks.some((t) => t.status === 'running' || t.status === 'waiting'),
    [remoteTasks],
  )

  // 主窗口任务运行期间高频轮询活跃会话；空闲时低频兜底（原地续跑等不经过 session-started 的会话也能被发现）
  useEffect(() => {
    const timer = window.setInterval(syncRemote, hasRemoteRunning ? 3000 : 15000)
    return () => window.clearInterval(timer)
  }, [hasRemoteRunning, syncRemote])

  // 面板（重新）创建时清理会话已被删除的历史任务（小秘书关闭期间主窗口删除的情况）
  useEffect(() => {
    const snapshot = useSecretaryStore.getState().tasks
    if (snapshot.length === 0) return
    let cancelled = false
    void Promise.all(snapshot.map(async (task) => {
      if (!task.conversationId) return null
      try {
        const conversation = await window.electronAPI.conversation.get(task.conversationId)
        return conversation ? null : task.id
      } catch {
        // 查询失败时保留任务，避免网络/DB 异常导致误删
        return null
      }
    })).then((ids) => {
      if (cancelled) return
      for (const id of ids) if (id) useSecretaryStore.getState().removeTask(id)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    // 面板可能在渲染端重建时已经处于显示状态：先取一次真实可见性，确认框倒计时才不会误判
    window.electronAPI.secretary.getState()
      .then((state) => updatePanelVisible(!!state.panelOpen))
      .catch(() => {})
  }, [updatePanelVisible])

  // 交互请求到达：面板此前未打开说明是本次交互自动弹出的，处理完后要恢复隐藏
  useEffect(() => {
    const off = window.electronAPI.interaction.onRequest((request: InteractionRequest) => {
      // 主进程转交的请求直接带判定结果，避免可见性事件与请求的到达顺序造成误判
      const autoOpened = request.panelAutoOpened !== undefined
        ? request.panelAutoOpened
        : !panelVisibleRef.current
      if (autoOpened) interactionAutoOpenedRef.current = true
    })
    return () => { off() }
  }, [])

  // 主窗口发起的任务也要显示执行细节：面板常驻，挂载即接管会话流事件
  useEffect(() => {
    installSecretaryRunner()
    void window.electronAPI.llm.observeSessionEvents?.().catch(() => {})
    return () => { void window.electronAPI.llm.unobserveSessionEvents?.().catch(() => {}) }
  }, [])

  const loadEmployees = useCallback(() => {
    window.electronAPI.employee.list()
      .then((list) => {
        const enabled = (Array.isArray(list) ? list : []).filter((e) => e.is_enabled !== false)
        setEmployees(enabled)
        setEmployeeId((prev) => {
          const stored = localStorage.getItem(EMPLOYEE_KEY)
          const next = enabled.find((e) => e.id === stored) || enabled.find((e) => e.id === prev) || enabled[0]
          return next ? next.id : prev
        })
      })
      .catch(() => {})
  }, [])

  const loadProviders = useCallback(() => {
    window.electronAPI.llm.getProviders()
      .then((list) => setProviders(Array.isArray(list) ? (list as LLMProvider[]) : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    loadEmployees()
    loadProviders()
    // 面板窗常驻不销毁：每次重新打开都刷新员工与模型列表，新建员工/模型后无需重启
    const off = window.electronAPI.secretary.onPanelVisibility((open) => {
      if (open) {
        autoHidingRef.current = false
        updatePanelVisible(true)
        loadEmployees()
        loadProviders()
        // 不重置页面：面板挂载时已恢复上次关闭的浮层/对话，隐藏期间状态也一直保留
        return
      }
      updatePanelVisible(false)
      // 确认框还挂着时拒绝收起（挂件点击/快捷键/托盘都可能触发），否则弹窗跟着被藏起来，任务只能等超时；
      // 确认框自身超时自动收起是例外，此时请求仍保留，下次打开可继续处理
      if (pendingRef.current && !autoHidingRef.current) {
        window.electronAPI.secretary.showPanel()
        return
      }
      autoHidingRef.current = false
      // 面板收起后不保留通知卡片，避免下次打开时再次弹出旧通知
      clearPopup()
    })
    return () => { off() }
  }, [loadEmployees, loadProviders, clearPopup, updatePanelVisible])

  // 记住当前 Tab（任务/通知），下次打开面板回到同一页；对话不恢复
  useEffect(() => {
    if (view !== 'tasks' && view !== 'notices') return
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ tab: view }))
    } catch { /* ignore */ }
  }, [view])

  // 正在看的任务被删除 / 归属员工变更：回到任务面板，避免停在空对话
  useEffect(() => {
    if (view === 'chat' && !activeTask) setView('tasks')
  }, [view, activeTask])

  // 面板卸载时清掉通知卡片计时器
  useEffect(() => () => {
    if (popupTimerRef.current) window.clearTimeout(popupTimerRef.current)
  }, [])

  // 员工信息变更（如更换头像）：面板常驻时实时刷新，避免需重启才生效
  useEffect(() => {
    const off = window.electronAPI.employee.onChanged(() => { loadEmployees() })
    return () => { off?.() }
  }, [loadEmployees])

  // 宿主通知改由小秘书承接：记录到通知列表（挂件由 PetWindow 自己弹气泡）
  useEffect(() => {
    const off = window.electronAPI.secretary.onNotify((payload) => {
      const pluginId = payload.source?.startsWith('plugin:') ? payload.source.slice('plugin:'.length) : undefined
      const localize = (textKey?: string, fallback?: string): string => {
        if (!textKey) return fallback || ''
        return String(t(textKey, {
          ...(payload.i18nParams || {}),
          defaultValue: fallback || textKey,
          ...(pluginId ? { ns: pluginId } : {}),
        }))
      }
      const notice: SecretaryNotice = {
        id: generateId(),
        title: localize(payload.i18nTitleKey, payload.title) || payload.title,
        body: localize(payload.i18nKey, payload.body),
        source: payload.source,
        clickTarget: payload.clickTarget,
        clickId: payload.clickId,
        createdAt: payload.createdAt || Date.now(),
        viewed: false,
      }
      addNotice(notice)
      // 主窗口不在前台：面板直接弹出这张通知卡片，用户可一键「知道了」或在 10s 后自动收起
      // 确认框打开时不抢焦点，通知只进列表
      if (payload.autoPopup && !pendingRef.current) showNoticePopup(notice)
    })
    // 监听注册完成后再上报，主进程据此补发窗口加载期间积压的通知
    window.electronAPI.secretary.notifyReady('panel')
    return () => { off() }
  }, [addNotice, showNoticePopup, t])

  // 交互请求已在其他窗口（主窗口 / 任务页）处理：撤回对应提醒，避免重复展示同一条待确认通知
  useEffect(() => {
    const off = window.electronAPI.secretary.onNotifyDismiss?.(({ clickId }) => {
      if (!clickId) return
      const state = useSecretaryStore.getState()
      for (const notice of state.notices) {
        if (notice.clickTarget === 'ask_user' && notice.clickId === clickId) state.removeNotice(notice.id)
      }
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    if (employeeId) localStorage.setItem(EMPLOYEE_KEY, employeeId)
  }, [employeeId])

  // 选中员工变化时同步挂件身份（robot 屏幕脸默认显示员工头像，屏幕配色跟随头像色）
  useEffect(() => {
    postSecretaryMessage({
      type: 'face',
      payload: employee
        ? {
          avatarImage: employee.avatar_image,
          avatarIcon: resolveEmployeeAvatarIcon(employee.avatar_icon, employee.avatar_type, employee.source),
          avatarColor: employee.avatar_color,
        }
        : {},
    })
  }, [employee])

  // 思考能力：与主窗口一致，支持 reasoning_effort 的提供商给出 4 档，只支持开关的给出开/关
  const thinkingCapability = useMemo(() => {
    const provider = providers.find((p) => p.id === modelProviderId)
    if (supportsReasoningEffort(provider?.provider_type)) {
      return { visible: true, levels: [false, 'low', 'medium', 'high'] as ThinkingLevel[], effortSupported: true }
    }
    if (supportsThinking(provider?.provider_type)) {
      return { visible: true, levels: [false, 'high'] as ThinkingLevel[], effortSupported: false }
    }
    return { visible: false, levels: [] as ThinkingLevel[], effortSupported: false }
  }, [providers, modelProviderId])

  const thinkingLevelLabel = useCallback((level?: ThinkingLevel) => t(
    !level
      ? 'workbench.thinkingLevelOff'
      : level === 'low' ? 'workbench.thinkingLevelLow'
        : level === 'medium' ? 'workbench.thinkingLevelMedium'
          : 'workbench.thinkingLevelHigh'
  ), [t])

  const handleModelChange = useCallback((providerId: string, nextModelId: string) => {
    setModelProviderId(providerId)
    setModelId(nextModelId)
    localStorage.setItem(MODEL_PROVIDER_KEY, providerId)
    localStorage.setItem(MODEL_ID_KEY, nextModelId)
  }, [])

  const handleThinkingChange = useCallback((level: ThinkingLevel) => {
    setThinking(level)
    localStorage.setItem(THINKING_KEY, String(level))
  }, [])

  // 模型菜单：按提供商分组，菜单项只显示模型名（与主窗口输入框的模型选择一致）
  const modelGroups = useMemo(
    () => providers
      .map((provider) => ({
        provider,
        models: getProviderModels(provider).filter((m) => (m.category || 'chat') === 'chat'),
      }))
      .filter((g) => g.models.length > 0),
    [providers],
  )

  const currentModelLabel = useMemo(() => {
    const group = modelGroups.find((g) => g.provider.id === modelProviderId)
    return group?.models.find((m) => m.model === modelId)?.name || modelId
  }, [modelGroups, modelProviderId, modelId])

  const modelMenu = useMemo(() => ({
    selectable: true,
    selectedKeys: [`${modelProviderId}::${modelId}`],
    onClick: ({ key }: { key: string }) => {
      const i = key.indexOf('::')
      if (i < 0) return
      handleModelChange(key.slice(0, i), key.slice(i + 2))
    },
    items: modelGroups.length > 0
      ? modelGroups.map((g) => ({
        type: 'group' as const,
        label: g.provider.name,
        children: g.models.map((m) => ({ key: `${g.provider.id}::${m.model}`, label: m.name })),
      }))
      : [{ key: '__none', label: t('secretary.noProvider'), disabled: true }],
  }), [modelGroups, modelProviderId, modelId, handleModelChange, t])

  // 与主窗口一致的思考灯泡：4 档提供商点开选强度，其余点一下开关
  const thinkingTrigger = (
    <Tooltip title={thinkingCapability.effortSupported
      ? `${t('workbench.thinkingLevel')}: ${thinkingLevelLabel(thinking)}`
      : thinking ? t('workbench.thinkingEnabled') : t('workbench.thinkingDisabled')}>
      <Button
        type="text"
        size="small"
        onClick={thinkingCapability.effortSupported
          ? undefined
          : () => handleThinkingChange(thinking ? false : DEFAULT_THINKING)}
        style={{ color: token.colorTextSecondary, padding: '0 4px 0 0', height: 18, minWidth: 18, borderRadius: 4 }}
      >
        {thinking ? <BulbFilled style={{ fontSize: 12 }} /> : <BulbOutlined style={{ fontSize: 12 }} />}
      </Button>
    </Tooltip>
  )

  // 权限 / ask_user：面板窗是发起窗口，弹窗挂在这里。
  // 面板平时是隐藏的，请求到达时必须把面板拉出来，否则用户看不到确认框（任务会一直等到超时被拒）。
  const interactionRequest = useInteractionStore(selectModalRequest)
  const modalOpen = !!interactionRequest

  /** 拖拽边缘/角调整面板宽高；鼠标位移按保持不动的那条边换算 */
  const startResize = useCallback((edge: ResizeEdge) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeOriginRef.current = {
      edge,
      x: e.screenX,
      y: e.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  }, [])

  const resizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const origin = resizeOriginRef.current
    if (!origin) return
    const dx = e.screenX - origin.x
    const dy = e.screenY - origin.y
    const fromLeft = origin.edge.includes('left')
    const fromRight = origin.edge.includes('right')
    const fromTop = origin.edge.includes('top')
    const fromBottom = origin.edge.includes('bottom')
    const rawWidth = fromLeft ? origin.width - dx : fromRight ? origin.width + dx : origin.width
    const rawHeight = fromTop ? origin.height - dy : fromBottom ? origin.height + dy : origin.height
    const width = Math.min(Math.max(Math.round(rawWidth), PANEL_MIN_WIDTH), PANEL_MAX_WIDTH)
    const height = Math.min(Math.max(Math.round(rawHeight), PANEL_MIN_HEIGHT), PANEL_MAX_HEIGHT)
    window.electronAPI.secretary.setPanelSize({
      width,
      height,
      // anchor 是保持不动的那条边：拖左/上边缘时右/下边缘固定
      anchorX: fromLeft ? 'right' : 'left',
      anchorY: fromTop ? 'bottom' : 'top',
    })
  }, [])

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeOriginRef.current) return
    resizeOriginRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }, [])

  /** 双击边缘：恢复默认宽高 */
  const resetPanelSize = useCallback(() => {
    window.electronAPI.secretary.setPanelSize({
      width: PANEL_DEFAULT_WIDTH,
      height: PANEL_DEFAULT_HEIGHT,
      anchorX: 'left',
      anchorY: 'top',
    })
  }, [])

  // 请求到达后把对应任务标记为“等待确认”（挂件据此进入等待态），结束后恢复执行中
  const waitingTaskRef = useRef<string | null>(null)
  useEffect(() => {
    pendingRef.current = !!interactionRequest
    const state = useSecretaryStore.getState()
    const conversationId = interactionRequest?.conversationId || null

    // 上一个等待中的任务若已不是当前请求的会话，先恢复为执行中
    const prevId = waitingTaskRef.current
    if (prevId) {
      const prev = state.tasks.find((t) => t.id === prevId)
      if (prev?.status === 'waiting' && (!conversationId || prev.conversationId !== conversationId)) {
        state.patchTask(prevId, { status: 'running' })
        waitingTaskRef.current = null
      }
    }
    if (!interactionRequest || !conversationId) return

    const target = state.tasks.find((t) => t.conversationId === conversationId
      && (t.status === 'running' || t.status === 'waiting'))
    if (!target) return
    waitingTaskRef.current = target.id
    if (target.status === 'running') state.patchTask(target.id, { status: 'waiting' })
    window.electronAPI.secretary.showPanel()
  }, [interactionRequest])

  /** 收起当前确认框：请求保留并落到通知列表，面板隐藏；下次点通知再继续处理 */
  const pendingInteractionId = interactionRequest?.id
  const hideInteraction = useCallback((requestId?: string) => {
    const id = requestId || pendingInteractionId
    if (!id) return
    const request = useInteractionStore.getState().requests.find((r) => r.id === id)
    if (!request) return
    const state = useSecretaryStore.getState()
    const hasNotice = state.notices.some((n) => n.clickTarget === 'ask_user' && n.clickId === request.id)
    if (!hasNotice) {
      state.addNotice({
        id: generateId(),
        title: request.title || String(t('interaction.defaultTitle')),
        body: request.message,
        clickTarget: 'ask_user',
        clickId: request.id,
        createdAt: Date.now(),
        viewed: false,
      })
    }
    // 收起后不再自动弹回确认框：后续打开面板回到通知列表，用户点通知才继续处理
    useInteractionStore.getState().suppress(request.id)
    setView('notices')
    autoHidingRef.current = true
    window.electronAPI.secretary.hidePanel()
  }, [pendingInteractionId, t])

  // 确认框在小秘书里长时间无操作：自动收起，保留请求；从通知显式打开的确认框不自动收起
  useEffect(() => {
    if (!pendingInteractionId || !panelVisible || pendingInteractionId === manualInteractionId) return
    const timer = window.setTimeout(() => hideInteraction(pendingInteractionId), INTERACTION_AUTO_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [pendingInteractionId, panelVisible, manualInteractionId, hideInteraction])

  // 请求已处理 / 失效 / 切换到下一个请求：清掉手动处理标记
  useEffect(() => {
    if (manualInteractionId && interactionRequest?.id !== manualInteractionId) setManualInteractionId(null)
  }, [interactionRequest?.id, manualInteractionId])

  // 自动弹出的确认框全部处理完后，恢复面板原来的隐藏状态
  useEffect(() => {
    const prev = prevInteractionIdRef.current
    const next = interactionRequest?.id
    prevInteractionIdRef.current = next
    if (!prev || prev === next) return
    if (next || !interactionAutoOpenedRef.current) return
    interactionAutoOpenedRef.current = false
    autoHidingRef.current = true
    window.electronAPI.secretary.hidePanel()
  }, [interactionRequest?.id])

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 弹窗打开时 Esc 不能收起面板，否则确认框会被一起藏起来
      if (interactionRequest) return
      // Esc 依次收：通知卡片 → 对话/浮层 → 面板
      if (popup) {
        clearPopup()
        return
      }
      if (view === 'chat') {
        setView('tasks')
        return
      }
      if (view === 'employee' || view === 'settings') {
        setView(overlayReturnRef.current)
        return
      }
      window.electronAPI.secretary.hidePanel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [popup, view, interactionRequest, clearPopup])

  /** 顶部 Tab 切换：任务 / 通知；顺手收起通知卡片 */
  const openTab = useCallback((tab: PanelTab) => {
    clearPopup()
    setView(tab)
  }, [clearPopup])

  /** 从对话返回任务面板 */
  const backFromChat = useCallback(() => setView('tasks'), [])

  /** 员工切换 / 设置页：记住进入前的视图，关闭后回到原处 */
  const openOverlay = useCallback((target: 'employee' | 'settings') => {
    if (view === target) {
      setView(overlayReturnRef.current === target ? 'tasks' : overlayReturnRef.current)
      return
    }
    overlayReturnRef.current = view
    setView(target)
  }, [view])

  /** 在对话里发送：没有任务就创建，已有任务就在同一会话继续追问，回答直接流式显示在面板里 */
  const handleSend = useCallback(async (text: string, files: ComposerFile[]) => {
    if (!employee || busy) return
    // 任务/通知面板输入当作派发新任务；只有对话视图才继续当前会话
    const continuingTask = view === 'chat' ? activeTask : undefined
    if (continuingTask?.origin === 'main') return
    const prompt = text.trim()
    if (!prompt && files.length === 0) {
      composerRef.current?.focus()
      return
    }
    setSending(true)
    try {
      if (continuingTask) {
        await continueSecretaryTask({
          taskId: continuingTask.id,
          prompt: prompt || files[0]?.name || '',
          attachmentPaths: files.map((f) => f.path),
          providerId: modelProviderId,
          modelId,
          enableThinking: thinking,
        })
      } else {
        const taskId = await startSecretaryTask({
          employee,
          prompt: prompt || files[0]?.name || '',
          attachmentPaths: files.map((f) => f.path),
          providerId: modelProviderId,
          modelId,
          enableThinking: thinking,
        })
        setActiveTaskId(taskId)
        setView('chat')
      }
      composerRef.current?.clear()
      // 面板保持打开：回答在对话区流式呈现，关掉面板也不影响任务继续执行
    } catch (err: any) {
      if (err?.message === 'NO_PROVIDER') message.warning(t('secretary.noProvider'))
      else message.error(continuingTask ? t('secretary.replyFailed') : t('secretary.sendFailed'))
    } finally {
      setSending(false)
    }
  }, [employee, busy, activeTask, view, message, t, modelProviderId, modelId, thinking])

  /** 任务行点击：进入对话视图（执行中的任务也能实时看） */
  const openTask = useCallback((task: SecretaryTask) => {
    if (!task.conversationId) return
    // 任务可能属于其他员工：先把身份切过去，对话与头部才一致
    if (employee && task.employee.id !== employee.id) setEmployeeId(task.employee.id)
    setActiveTaskId(task.id)
    setView('chat')
    if (!task.viewed) markViewed(task.id)
    if (task.origin !== 'main') window.setTimeout(() => composerRef.current?.focus(), 60)
  }, [employee, markViewed])

  /** 「完成」按钮：该任务从面板消失（主窗口的任务列表不受影响） */
  const dismissTask = useCallback((task: SecretaryTask) => {
    if (task.origin === 'main') dismissRemoteTask(task)
    else removeTask(task.id)
    // 收掉正在看的对话后回到任务面板，不要自动跳到另一条历史任务
    if (activeTaskId === task.id) {
      setActiveTaskId(null)
      setView('tasks')
    }
  }, [removeTask, activeTaskId])

  /** 停止任务：主窗口发起的任务用它的运行会话中止 */
  const stopTask = useCallback((task: SecretaryTask) => {
    if (task.origin === 'main') void abortRemoteTask(task)
    else void abortSecretaryTask(task.id)
  }, [])

  const openInMain = useCallback((task: SecretaryTask) => {
    if (!task.conversationId) return
    window.electronAPI.secretary.openTask({
      employeeId: task.employee.id,
      conversationId: task.conversationId,
    })
    window.electronAPI.secretary.hidePanel()
  }, [])

  /** 文件 → 行内令牌（与主窗口新任务编辑器一致，不再在底部堆附件条） */
  const insertPaths = useCallback((paths: string[]) => {
    const files: ComposerFile[] = paths
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => ({ path: p, name: baseName(p) }))
    if (files.length === 0) return
    composerRef.current?.insertFiles(files)
  }, [])

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return
    const paths: string[] = []
    for (let i = 0; i < fileList.length; i++) {
      try {
        const p = window.electronAPI.getPathForFile(fileList[i])
        if (p) paths.push(p)
      } catch { /* ignore */ }
    }
    insertPaths(paths)
  }

  // 挂件窗拖入的文件（只带路径）：直接补进编辑区；挂件请求状态时补发当前身份与任务状态
  useEffect(() => subscribeSecretaryBus((msg) => {
    if (msg.type === 'request-state') {
      broadcastSecretaryState()
      if (employee) {
        postSecretaryMessage({
          type: 'face',
          payload: {
            avatarImage: employee.avatar_image,
            avatarIcon: resolveEmployeeAvatarIcon(employee.avatar_icon, employee.avatar_type, employee.source),
            avatarColor: employee.avatar_color,
          },
        })
      }
      return
    }
    if (msg.type !== 'files') return
    try { localStorage.removeItem(SECRETARY_PENDING_FILES_KEY) } catch { /* ignore */ }
    insertPaths(msg.paths)
    window.setTimeout(() => composerRef.current?.focus(), 60)
  }), [insertPaths, employee])

  // 首次打开面板：消费挂件窗在面板创建前暂存的拖入文件
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SECRETARY_PENDING_FILES_KEY)
      if (!raw) return
      localStorage.removeItem(SECRETARY_PENDING_FILES_KEY)
      const paths = JSON.parse(raw)
      if (!Array.isArray(paths)) return
      insertPaths(paths.filter((p: unknown): p is string => typeof p === 'string'))
      window.setTimeout(() => composerRef.current?.focus(), 80)
    } catch { /* ignore */ }
  }, [insertPaths])

  /** 通知条目点击：待确认交互重新拉起面板，其余标记已读并跳转主窗口对应目标 */
  const openNotice = useCallback((notice: SecretaryNotice) => {
    // 确认框超时收起后仍保留在交互 store 里：点击通知直接回到小秘书继续处理，
    // 同时移除这条通知（确认框已重新展示；再次收起时会重新生成未读通知）
    if (notice.clickTarget === 'ask_user' && notice.clickId
      && useInteractionStore.getState().requests.some((r) => r.id === notice.clickId)) {
      removeNotice(notice.id)
      useInteractionStore.getState().unsuppress(notice.clickId)
      // 用户从通知里主动打开：视为开始处理，不再倒计时自动隐藏，处理完也不强制收起面板
      interactionAutoOpenedRef.current = false
      setManualInteractionId(notice.clickId)
      window.electronAPI.secretary.showPanel()
      return
    }
    if (!notice.viewed) markNoticeViewed(notice.id)
    if (!notice.clickTarget) return
    window.electronAPI.secretary.openNotice({
      clickTarget: notice.clickTarget,
      clickId: notice.clickId,
      source: notice.source,
    })
    window.electronAPI.secretary.hidePanel()
  }, [markNoticeViewed, removeNotice])

  /** 通知弹出卡片：知道了 = 该通知完成并从列表移除 */
  const ackPopup = useCallback(() => {
    if (popup) removeNotice(popup.id)
    clearPopup(true)
  }, [popup, removeNotice, clearPopup])

  /** 通知弹出卡片：查看目标（标记已读并交给主窗口跳转） */
  const viewPopup = useCallback(() => {
    if (!popup) return
    const target = popup
    clearPopup()
    openNotice(target)
  }, [popup, clearPopup, openNotice])

  const noticeRow = (notice: SecretaryNotice) => (
    <div
      key={notice.id}
      className="secretary-task-row"
      role="button"
      tabIndex={0}
      onClick={() => openNotice(notice)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openNotice(notice) }}
      style={{ color: token.colorText }}
    >
      <BellOutlined style={{ color: token.colorPrimary }} />
      <span className="secretary-task-main">
        <span className="secretary-task-title">{notice.title}</span>
        <span className="secretary-task-meta">{notice.body}</span>
      </span>
      {!notice.viewed && <span className="secretary-unread-dot" />}
      <button
        type="button"
        className="secretary-task-complete"
        title={t('secretary.complete')}
        onClick={(e) => {
          e.stopPropagation()
          removeNotice(notice.id)
        }}
        style={{ color: token.colorTextTertiary }}
      >
        {t('secretary.complete')}
      </button>
    </div>
  )

  const taskRow = (task: SecretaryTask) => (
    <div
      key={task.id}
      className="secretary-task-row"
      role="button"
      tabIndex={0}
      onClick={() => openTask(task)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openTask(task) }}
      style={{ color: token.colorText }}
    >
      {task.status === 'running' && <span className="secretary-spin" style={{ borderTopColor: token.colorPrimary }} />}
      {task.status === 'waiting' && <ExclamationCircleOutlined style={{ color: token.colorWarning }} />}
      {task.status === 'done' && <CheckCircleOutlined style={{ color: token.colorSuccess }} />}
      {task.status === 'failed' && <CloseCircleOutlined style={{ color: token.colorError }} />}
      <span className="secretary-task-main">
        <span className="secretary-task-title" title={task.title}>{task.title}</span>
        <span className="secretary-task-meta">
          {task.employee.name}
          {(task.status === 'running' || task.status === 'waiting') && (
            <> · {task.status === 'waiting' ? t('secretary.waiting') : (task.step || t('secretary.working'))}</>
          )}
        </span>
      </span>
      {!task.viewed && (task.status === 'done' || task.status === 'failed') && (
        <span className="secretary-unread-dot" />
      )}
      {task.status === 'running' && (
        <button
          type="button"
          className="secretary-task-stop"
          title={t('secretary.stop')}
          onClick={(e) => {
            e.stopPropagation()
            stopTask(task)
          }}
          style={{ color: token.colorTextTertiary }}
        >
          <StopOutlined />
        </button>
      )}
      {(task.status === 'done' || task.status === 'failed') && (
        <button
          type="button"
          className="secretary-task-complete"
          title={t('secretary.complete')}
          onClick={(e) => {
            e.stopPropagation()
            dismissTask(task)
          }}
          style={{ color: token.colorTextTertiary }}
        >
          {t('secretary.complete')}
        </button>
      )}
    </div>
  )

  /** 头部员工身份：任务对话里只做展示（不可切换），其他页面可点击切换员工 */
  const headIdentity = (
    <>
      {employee && (
        <EmployeeAvatar
          employeeId={employee.id}
          avatarIcon={employee.avatar_icon}
          avatarColor={employee.avatar_color}
          avatarImage={employee.avatar_image}
          avatarType={employee.avatar_type}
          source={employee.source}
          size={26}
          shape="square"
        />
      )}
      <span className="secretary-head-name" style={{ color: token.colorText }}>
        {employee?.name || t('secretary.title')}
      </span>
    </>
  )

  return (
    <>
      <div
        className={`secretary-panel${modalOpen ? ' is-modal-open' : ''}`}
        style={{ background: token.colorBgElevated }}
        onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          // 主窗口任务的对话是只读的：不要把文件塞进隐藏的输入框
          if (activeTask?.origin !== 'main') addFiles(e.dataTransfer.files)
        }}
      >
      <div
        className="secretary-panel-inner"
        style={{ outline: dropping ? `1px dashed ${token.colorPrimary}` : 'none', outlineOffset: -6, borderRadius: 16 }}
      >
        {/* 头部：返回 / 员工 / 状态 / 任务·通知切换 / 设置 / 关闭，单行紧凑排布 */}
        <div className="secretary-head">
          {view === 'chat' && (
            <Tooltip title={t('secretary.back')}>
              <Button
                type="text"
                size="small"
                icon={<ArrowLeftOutlined />}
                data-testid="secretary-back"
                style={{ color: token.colorTextSecondary, marginLeft: -4, paddingInline: 4 }}
                onClick={backFromChat}
              />
            </Tooltip>
          )}
          {view === 'chat' ? (
            <div className="secretary-head-id is-static" title={employee?.name || t('secretary.title')}>
              {headIdentity}
            </div>
          ) : (
            <button
              type="button"
              className="secretary-head-id"
              title={t('secretary.switchEmployee')}
              onClick={() => openOverlay('employee')}
            >
              {headIdentity}
              <SwapOutlined
                style={{
                  color: token.colorTextTertiary,
                  fontSize: 12,
                  flexShrink: 0,
                }}
              />
            </button>
          )}
          {(headTask?.status === 'running' || headTask?.status === 'waiting') && (
            <span
              className="secretary-head-status"
              style={{ color: headTask.status === 'waiting' ? token.colorWarning : token.colorTextTertiary }}
            >
              <span
                className="secretary-status-dot"
                style={{ background: headTask.status === 'waiting' ? token.colorWarning : token.colorPrimary }}
              />
              <span className="secretary-head-status-text">
                {headTask.status === 'waiting' ? t('secretary.waiting') : (headTask.step || t('secretary.working'))}
              </span>
            </span>
          )}
          <div className="secretary-head-actions">
            <Tooltip title={t('secretary.tasks')}>
              <Badge
                count={running.length + finished.length}
                size="small"
                color={running.length > 0 ? token.colorPrimary : token.colorTextSecondary}
                offset={[-3, 2]}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<UnorderedListOutlined />}
                  data-testid="secretary-open-tasks"
                  aria-pressed={view === 'tasks' || view === 'chat'}
                  style={{
                    color: view === 'tasks' || view === 'chat' ? token.colorText : token.colorTextTertiary,
                    background: view === 'tasks' || view === 'chat' ? token.colorFillTertiary : 'transparent',
                  }}
                  onClick={() => openTab('tasks')}
                />
              </Badge>
            </Tooltip>
            <Tooltip title={t('secretary.notices')}>
              <Badge
                count={unreadNoticeCount > 0 ? unreadNoticeCount : notices.length}
                size="small"
                color={unreadNoticeCount > 0 ? undefined : token.colorTextSecondary}
                offset={[-3, 2]}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<BellOutlined />}
                  data-testid="secretary-open-notices"
                  aria-pressed={view === 'notices'}
                  style={{
                    color: view === 'notices' ? token.colorText : token.colorTextTertiary,
                    background: view === 'notices' ? token.colorFillTertiary : 'transparent',
                  }}
                  onClick={() => openTab('notices')}
                />
              </Badge>
            </Tooltip>
            <Tooltip title={t('secretary.settings')}>
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                aria-pressed={view === 'settings'}
                style={{
                  color: view === 'settings' ? token.colorText : token.colorTextTertiary,
                  background: view === 'settings' ? token.colorFillTertiary : 'transparent',
                }}
                onClick={() => openOverlay('settings')}
              />
            </Tooltip>
            <Tooltip title={t('common.close')}>
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                style={{ color: token.colorTextTertiary }}
                onClick={() => window.electronAPI.secretary.hidePanel()}
              />
            </Tooltip>
          </div>
        </div>


        {/* 主体：通知卡片 / 对话 / 员工·设置 / 任务·通知列表，固定窗口内自适应布局 */}
        {popup ? (
          <div className="secretary-stage">
            <div key={popup.id} className="secretary-notice-popup" style={{ borderColor: token.colorBorderSecondary }}>
              {/* 倒计时进度条贴卡片顶边：播完自动收起面板，通知保留在通知列表 */}
              <div className="wa-countdown-bar is-overlay" style={{ background: token.colorFillSecondary }}>
                <div
                  className="wa-countdown-bar-fill"
                  style={{ background: token.colorPrimary, animationDuration: `${NOTICE_POPUP_TIMEOUT_MS}ms` }}
                />
              </div>
              <div className="secretary-notice-popup-head">
                <BellOutlined style={{ color: token.colorPrimary }} />
                <span className="secretary-notice-popup-title" style={{ color: token.colorText }}>{popup.title}</span>
              </div>
              {popup.body && (
                <div className="secretary-notice-popup-body" style={{ color: token.colorTextSecondary }}>
                  {popup.body}
                </div>
              )}
              <div className="secretary-notice-popup-actions">
                {popup.clickTarget && (
                  <Button
                    size="small"
                    type="text"
                    style={{ color: token.colorTextSecondary }}
                    onClick={viewPopup}
                  >
                    {t('secretary.noticeView')}
                  </Button>
                )}
                <Button size="small" type="primary" onClick={ackPopup}>
                  {t('secretary.noticeAck')}
                </Button>
              </div>
            </div>
          </div>
        ) : view === 'chat' && activeTask ? (
          <div className="secretary-stage">
            <SecretaryChat task={activeTask} onOpenInMain={openInMain} />
          </div>
        ) : view === 'employee' || view === 'settings' ? (
          <div className="secretary-stage">
            <div className="secretary-overlay">
              <div className="secretary-overlay-head">
                <span className="secretary-overlay-title" style={{ color: token.colorText }}>
                  {view === 'employee' ? t('secretary.switchEmployee') : t('secretary.settings')}
                </span>
                <Button
                  type="text"
                  size="small"
                  icon={<ArrowLeftOutlined />}
                  style={{ color: token.colorTextTertiary }}
                  onClick={() => setView(overlayReturnRef.current)}
                />
              </div>
              <div className={`secretary-overlay-body${view === 'employee' ? ' is-fixed' : ''}`}>
                {view === 'employee' && employees.map((emp) => (
                  <button
                    key={emp.id}
                    className={`secretary-menu-item ${emp.id === employee?.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setEmployeeId(emp.id)
                      setView('tasks')
                      setActiveTaskId(null)
                      composerRef.current?.clear()
                      window.setTimeout(() => composerRef.current?.focus(), 60)
                    }}
                    style={{ color: token.colorText }}
                  >
                    <EmployeeAvatar
                      employeeId={emp.id}
                      avatarIcon={emp.avatar_icon}
                      avatarColor={emp.avatar_color}
                      avatarImage={emp.avatar_image}
                      avatarType={emp.avatar_type}
                      source={emp.source}
                      size={20}
                      shape="square"
                    />
                    <span style={{ flexShrink: 0, maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {emp.name}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, marginLeft: 8, fontSize: 11, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {emp.description}
                    </span>
                    {emp.id === employee?.id && <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />}
                  </button>
                ))}

                {view === 'settings' && (
                  <button
                    className="secretary-menu-item"
                    style={{ color: token.colorText }}
                    onClick={async () => {
                      setView('tasks')
                      await window.electronAPI.secretary.setSettings({ enabled: false }).catch(() => {})
                      window.electronAPI.secretary.hidePanel()
                    }}
                  >
                    <EyeInvisibleOutlined style={{ color: token.colorTextTertiary }} />
                    <span>{t('secretary.hidePet')}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="secretary-stage">
            <div className="secretary-overlay">
              <div className="secretary-overlay-body is-fixed">
                {view === 'tasks' && (running.length === 0 && finished.length === 0 ? (
                  <div className="secretary-empty" style={{ color: token.colorTextQuaternary }}>
                    <UnorderedListOutlined style={{ fontSize: 18, opacity: .55 }} />
                    <span>{t('secretary.noTasks')}</span>
                  </div>
                ) : (
                  <>
                    {running.map(taskRow)}
                    {finished.map(taskRow)}
                  </>
                ))}

                {view === 'notices' && (notices.length === 0 ? (
                  <div className="secretary-empty" style={{ color: token.colorTextQuaternary }}>
                    <BellOutlined style={{ fontSize: 18, opacity: .55 }} />
                    <span>{t('secretary.noNotices')}</span>
                  </div>
                ) : notices.map(noticeRow))}
              </div>
            </div>
          </div>
        )}

        {/* 底部输入条：任务面板发起新任务 / 对话续聊 / 主窗口任务只读 */}
        {!popup && (view === 'tasks' || view === 'chat') && (
          view === 'chat' && activeTask?.origin === 'main' ? (
          <div
            className="secretary-composer is-readonly"
            style={{ borderColor: token.colorBorderSecondary }}
          >
            <span className="secretary-readonly-hint" style={{ color: token.colorTextQuaternary }}>
              {t('secretary.mainTaskHint')}
            </span>
            {(activeTask.status === 'running' || activeTask.status === 'waiting') && (
              <Tooltip title={t('secretary.stop')}>
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={() => stopTask(activeTask)}
                />
              </Tooltip>
            )}
            <Button
              type="primary"
              size="small"
              icon={<ExportOutlined />}
              style={{ borderRadius: 999 }}
              onClick={() => openInMain(activeTask)}
            >
              {t('secretary.openInMain')}
            </Button>
          </div>
        ) : (
          <div
            className="secretary-composer"
            style={{ borderColor: token.colorBorderSecondary }}
          >
            <SecretaryComposer
              ref={composerRef}
              placeholder={view === 'chat' && activeTask
                ? t('secretary.replyPlaceholder')
                : t('secretary.placeholder', { name: employee?.name || '' })}
              onSend={handleSend}
            />
            <div className="secretary-composer-bar">
              <Tooltip title={t('secretary.attach')}>
                <Button
                  type="text"
                  size="small"
                  icon={<PaperClipOutlined />}
                  style={{ color: token.colorTextTertiary }}
                  onClick={() => fileRef.current?.click()}
                />
              </Tooltip>
              <Tooltip title={t('secretary.inputHint')}>
                <span className="secretary-composer-hint" style={{ color: token.colorTextQuaternary }}>
                  {view === 'chat' && activeTask?.status === 'waiting'
                    ? t('secretary.waiting')
                    : busy ? t('secretary.responding') : t('secretary.inputHint')}
                </span>
              </Tooltip>
              {/* 模型名与思考灯泡：与主窗口输入框一致的紧凑排布，中间不留额外间距 */}
              <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <Dropdown trigger={['click']} placement="topRight" menu={modelMenu}>
                  <Button
                    type="text"
                    size="small"
                    title={currentModelLabel || undefined}
                    style={{
                      color: token.colorTextSecondary,
                      padding: '0 5px',
                      height: 18,
                      maxWidth: 110,
                      minWidth: 18,
                      borderRadius: 4,
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, fontSize: 11 }}>
                      {currentModelLabel
                        ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentModelLabel}</span>
                        : <RobotOutlined style={{ fontSize: 11 }} />}
                    </span>
                  </Button>
                </Dropdown>
                {thinkingCapability.visible && (
                  thinkingCapability.effortSupported ? (
                    <Dropdown
                      trigger={['click']}
                      placement="topRight"
                      menu={{
                        items: thinkingCapability.levels.map((level) => ({
                          key: String(level),
                          label: <span style={{ fontSize: 12 }}>{thinkingLevelLabel(level)}</span>,
                          icon: thinking === level
                            ? <CheckOutlined style={{ fontSize: 11 }} />
                            : <span style={{ display: 'inline-block', width: 11 }} />,
                        })),
                        onClick: ({ key }) => handleThinkingChange(key === 'false' ? false : key as ThinkingLevel),
                        selectable: true,
                        selectedKeys: [String(thinking)],
                      }}
                    >
                      {thinkingTrigger}
                    </Dropdown>
                  ) : thinkingTrigger
                )}
              </div>
              {view === 'chat' && activeTask && (activeTask.status === 'running' || activeTask.status === 'waiting') && (
                <Tooltip title={t('secretary.stop')}>
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    onClick={() => stopTask(activeTask)}
                  />
                </Tooltip>
              )}
              <Button
                type="primary"
                size="small"
                loading={sending}
                disabled={busy}
                icon={<SendOutlined />}
                onClick={() => composerRef.current?.submit()}
                style={{ borderRadius: 999 }}
              >
                {t('secretary.send')}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        ))}
      </div>
      {/* 边缘/角拖拽柄：宽高都可调，双击恢复默认尺寸 */}
      {(['left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((edge) => (
        <div
          key={edge}
          className={`secretary-resize-edge is-${edge}`}
          title={t('secretary.resizeHint')}
          onPointerDown={startResize(edge)}
          onPointerMove={resizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={resetPanelSize}
          style={{ color: token.colorTextTertiary }}
        />
      ))}
      </div>
      {/* 权限 / ask_user：交互会话绑定本窗口，弹窗必须挂在这里；小窗宽度有限，用紧凑版弹窗 */}
      <UnifiedInteractionModal
        compact
        autoHideMs={INTERACTION_AUTO_HIDE_MS}
        active={panelVisible && interactionRequest?.id !== manualInteractionId}
        onHide={() => hideInteraction()}
      />
    </>
  )
}

export default SecretaryPanel
