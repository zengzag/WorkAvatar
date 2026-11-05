import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Tooltip, theme } from 'antd'
import {
  CloseOutlined,
  PaperClipOutlined,
  SwapOutlined,
  SendOutlined,
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
import { startSecretaryTask, abortSecretaryTask, broadcastSecretaryState } from './secretary-runner'
import { syncRemoteTasks, abortRemoteTask, dismissRemoteTask } from './secretary-remote'
import { postSecretaryMessage, subscribeSecretaryBus, SECRETARY_PENDING_FILES_KEY } from './secretary-bus'
import { useInteractionStore } from '../../stores/interaction.store'
import UnifiedInteractionModal from '../common/UnifiedInteractionModal'
import SecretaryComposer, { type ComposerFile, type ComposerHandle } from './SecretaryComposer'
import SecretaryTaskDetail from './SecretaryTaskDetail'
import './secretary.css'

const EMPLOYEE_KEY = 'wa.secretary.employeeId'
/** 面板上选中的模型与思考开关（会话级偏好，落 localStorage 供两个窗口共享） */
const MODEL_PROVIDER_KEY = 'wa.secretary.providerId'
const MODEL_ID_KEY = 'wa.secretary.modelId'
const THINKING_KEY = 'wa.secretary.thinking'
/** 小秘书默认开启思考（支持时） */
const DEFAULT_THINKING: ThinkingLevel = 'high'
/** 面板最大高度：超出后卡片内部滚动（上报给主进程的高度也用这个上限） */
const PANEL_MAX_HEIGHT = 620
/** 左右边缘拖拽的宽度范围（与主进程 secretary-window.service 的 clamp 保持一致） */
const PANEL_DEFAULT_WIDTH = 372
const PANEL_MIN_WIDTH = 300
const PANEL_MAX_WIDTH = 640

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

/** 面板窗：员工切换 + 发任务 + 任务区（正在执行 / 待查看）*/
const SecretaryPanel: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { message } = App.useApp()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [employeeId, setEmployeeId] = useState<string>(() => localStorage.getItem(EMPLOYEE_KEY) || '')
  const [sending, setSending] = useState(false)
  const [dropping, setDropping] = useState(false)
  /** 内联展开的员工切换 / 设置菜单：展开会撑高面板，收起时必须重新上报高度 */
  const [menu, setMenu] = useState<'employee' | 'settings' | null>(null)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modelProviderId, setModelProviderId] = useState(
    () => localStorage.getItem(MODEL_PROVIDER_KEY) || getCachedSceneDefaultModel('workbench')?.provider_id || '',
  )
  const [modelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_ID_KEY) || getCachedSceneDefaultModel('workbench')?.model_id || '',
  )
  const [thinking, setThinking] = useState<ThinkingLevel>(readStoredThinking)
  /** 面板内查看的已结束任务（打开简化对话窗）；空 = 任务列表 */
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  /** 左右边缘拖拽调整宽度时的起点（高度始终由内容自适应） */
  const resizeOriginRef = useRef<{ edge: 'left' | 'right'; x: number; width: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  /** 是否有待处理的权限 / ask_user 弹窗（弹窗挂在本窗口，收起面板会让它看不见） */
  const pendingRef = useRef(false)

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
  const detailTask = useMemo(
    () => (detailTaskId ? allTasks.find((t) => t.id === detailTaskId) : undefined),
    [allTasks, detailTaskId],
  )

  /** 任务列表最多显示 5 条，超出在列表内滚动：按实际行高计算上限，适配不同字号/主题 */
  const taskScrollRef = useRef<HTMLDivElement>(null)
  const [taskListMaxHeight, setTaskListMaxHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = taskScrollRef.current
    const rows = el?.querySelectorAll<HTMLElement>('.secretary-task-row')
    if (!el || !rows || rows.length === 0) {
      setTaskListMaxHeight(undefined)
      return
    }
    // 超过 5 条时按实际行高裁掉多出的行（保留分组标题的完整高度）
    const hiddenRows = rows.length - 5
    const next = hiddenRows <= 0
      ? undefined
      : Math.ceil(el.scrollHeight - hiddenRows * rows[0].getBoundingClientRect().height)
    setTaskListMaxHeight((prev) => (prev === next ? prev : next))
  }, [running.length, finished.length])

  // 任务被移除（完成按钮 / 列表裁剪）后退出详情，回到任务列表
  useEffect(() => {
    if (detailTaskId && !detailTask) setDetailTaskId(null)
  }, [detailTaskId, detailTask])

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

  const employee = useMemo(
    () => employees.find((e) => e.id === employeeId) || employees[0],
    [employees, employeeId],
  )

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
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
        loadEmployees()
        loadProviders()
        return
      }
      // 确认框还挂着时拒绝收起（挂件点击/快捷键/托盘都可能触发），否则弹窗跟着被藏起来，任务只能等超时
      if (pendingRef.current) window.electronAPI.secretary.showPanel()
    })
    return () => { off() }
  }, [loadEmployees, loadProviders])

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
      addNotice({
        id: generateId(),
        title: localize(payload.i18nTitleKey, payload.title) || payload.title,
        body: localize(payload.i18nKey, payload.body),
        source: payload.source,
        clickTarget: payload.clickTarget,
        clickId: payload.clickId,
        createdAt: payload.createdAt || Date.now(),
        viewed: false,
      })
    })
    // 监听注册完成后再上报，主进程据此补发窗口加载期间积压的通知
    window.electronAPI.secretary.notifyReady('panel')
    return () => { off() }
  }, [addNotice, t])

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
  const interactionRequest = useInteractionStore((s) => s.currentRequest)
  const modalOpen = !!interactionRequest

  // 面板内容高度 → 主进程同步窗口高度。
  // 弹窗打开时面板整体让位，窗口收紧到弹窗本身的高度，避免弹窗落在一块多余的面板底色上。
  useEffect(() => {
    if (modalOpen) {
      let ro: ResizeObserver | null = null
      let raf = 0
      let alive = true
      const report = (el: HTMLElement) => {
        // 用 offsetHeight 而不是 getBoundingClientRect：弹窗开场缩放动画会让 rect 偏小，且动画结束不会触发 ResizeObserver
        const height = el.offsetHeight
        if (height > 0) window.electronAPI.secretary.setPanelHeight(Math.ceil(height) + 16)
      }
      const attach = () => {
        if (!alive) return
        const dialog = document.querySelector<HTMLElement>('.wa-approval-modal-compact .ant-modal')
        if (!dialog) {
          raf = window.requestAnimationFrame(attach)
          return
        }
        report(dialog)
        ro = new ResizeObserver(() => report(dialog))
        ro.observe(dialog)
      }
      attach()
      // 文案/选项异步渲染会让高度再变一次，补一次上报
      const timer = window.setTimeout(() => {
        const dialog = document.querySelector<HTMLElement>('.wa-approval-modal-compact .ant-modal')
        if (dialog) report(dialog)
      }, 300)
      return () => {
        alive = false
        window.cancelAnimationFrame(raf)
        window.clearTimeout(timer)
        ro?.disconnect()
      }
    }
    const el = rootRef.current
    if (!el) return
    const report = () => {
      const inner = el.firstElementChild as HTMLElement | null
      const last = inner?.lastElementChild as HTMLElement | null
      let natural = el.getBoundingClientRect().height
      if (inner && last) {
        // 卡片被 max-height 夹住时 rect 只有上限高度，这里按内容实测自然高度
        const padBottom = parseFloat(getComputedStyle(inner).paddingBottom) || 0
        natural = last.getBoundingClientRect().bottom
          - inner.getBoundingClientRect().top
          + inner.scrollTop
          + padBottom
      }
      const target = Math.min(natural, PANEL_MAX_HEIGHT)
      window.electronAPI.secretary.setPanelHeight(Math.ceil(target) + 2)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    // 内容被 max-height 夹住后 el 的盒子不再变化，必须同时观察内容层，否则收起菜单时窗口不会回落
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    // 字体/头像异步加载会让高度在首帧后再变一次，补两次上报避免窗口停在初始高度
    const t1 = window.setTimeout(report, 300)
    const t2 = window.setTimeout(report, 1200)
    return () => {
      ro.disconnect()
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
    // 菜单展开/收起、列表与对话详情互切时卡片被 max-height 夹住，ResizeObserver 收不到盒子变化，必须重跑上报
  }, [modalOpen, menu, detailTaskId])

  /** 左右边缘拖拽柄：只调宽度，高度仍由内容决定 */
  const startResize = useCallback((edge: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeOriginRef.current = { edge, x: e.screenX, width: window.innerWidth }
  }, [])

  const resizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const origin = resizeOriginRef.current
    if (!origin) return
    const dx = e.screenX - origin.x
    // 拖左边缘时右边缘不动（anchor: right），拖右边缘时左边缘不动
    const raw = origin.edge === 'left' ? origin.width - dx : origin.width + dx
    const width = Math.min(Math.max(Math.round(raw), PANEL_MIN_WIDTH), PANEL_MAX_WIDTH)
    window.electronAPI.secretary.setPanelSize({
      width,
      anchor: origin.edge === 'left' ? 'right' : 'left',
    })
  }, [])

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeOriginRef.current) return
    resizeOriginRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  }, [])

  /** 双击边缘拖拽柄：恢复默认宽度 */
  const resetPanelSize = useCallback(() => {
    window.electronAPI.secretary.setPanelSize({ width: PANEL_DEFAULT_WIDTH, anchor: 'left' })
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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 弹窗打开时 Esc 不能收起面板，否则确认框会被一起藏起来
      if (interactionRequest) return
      // Esc 依次收：浮层 → 对话详情 → 面板
      if (menu) {
        setMenu(null)
        return
      }
      if (detailTaskId) {
        setDetailTaskId(null)
        return
      }
      window.electronAPI.secretary.hidePanel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [menu, interactionRequest, detailTaskId])

  const handleSend = useCallback(async (text: string, files: ComposerFile[]) => {
    if (!employee || sending) return
    const prompt = text.trim()
    if (!prompt && files.length === 0) {
      composerRef.current?.focus()
      return
    }
    setSending(true)
    setMenu(null)
    try {
      await startSecretaryTask({
        employee,
        prompt: prompt || files[0]?.name || '',
        attachmentPaths: files.map((f) => f.path),
        providerId: modelProviderId,
        modelId,
        enableThinking: thinking,
      })
      composerRef.current?.clear()
      // 派出去即可：任务在后台静默执行，任务列表会实时出现，点任务行才跳转主窗口查看
      window.electronAPI.secretary.hidePanel()
    } catch (err: any) {
      if (err?.message === 'NO_PROVIDER') message.warning(t('secretary.noProvider'))
      else message.error(t('secretary.sendFailed'))
    } finally {
      setSending(false)
    }
  }, [employee, sending, message, t, modelProviderId, modelId, thinking])

  /** 行点击：已结束任务在面板内看简化对话；执行中的任务仍跳主窗口看实时过程 */
  const openTask = useCallback((task: SecretaryTask) => {
    setMenu(null)
    if (!task.viewed) markViewed(task.id)
    if (task.status === 'done' || task.status === 'failed') {
      setDetailTaskId(task.id)
      return
    }
    if (task.conversationId) {
      window.electronAPI.secretary.openTask({
        employeeId: task.employee.id,
        conversationId: task.conversationId,
      })
      window.electronAPI.secretary.hidePanel()
    }
  }, [markViewed])

  /** 「完成」按钮：该任务从面板消失（主窗口的任务列表不受影响） */
  const dismissTask = useCallback((task: SecretaryTask) => {
    if (task.origin === 'main') dismissRemoteTask(task)
    else removeTask(task.id)
    setDetailTaskId((prev) => (prev === task.id ? null : prev))
  }, [removeTask])

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

  // 任务区全部展示（面板内部可滚动），避免超出前几条的任务无法停止或查看
  const runningShown = running
  const finishedShown = finished

  /** 通知条目点击：标记已读并跳转主窗口对应目标（无目标时仅标记已读） */
  const openNotice = useCallback((notice: SecretaryNotice) => {
    if (!notice.viewed) markNoticeViewed(notice.id)
    if (!notice.clickTarget) return
    window.electronAPI.secretary.openNotice({
      clickTarget: notice.clickTarget,
      clickId: notice.clickId,
      source: notice.source,
    })
    window.electronAPI.secretary.hidePanel()
  }, [markNoticeViewed])

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
        <span className="secretary-task-title">{task.title}</span>
        <span className="secretary-task-meta">
          {task.employee.name} · {task.status === 'running'
            ? (task.step || t('secretary.working'))
            : task.status === 'waiting'
              ? t('secretary.waiting')
              : task.status === 'failed'
                ? (task.error === 'aborted' ? t('secretary.stopped') : t('secretary.failed'))
                : t('secretary.done')}
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

  return (
    <>
      <div
        className={`secretary-panel${modalOpen ? ' is-modal-open' : ''}`}
        ref={rootRef}
        style={{
          background: token.colorBgElevated,
          borderColor: token.colorBorder,
          maxHeight: PANEL_MAX_HEIGHT,
        }}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        // 对话详情有自己的输入框与附件按钮，避免文件被塞进被隐藏的列表输入框
        if (!detailTask) addFiles(e.dataTransfer.files)
      }}
    >
      <div
        className="secretary-panel-inner"
        style={{ outline: dropping ? `1px dashed ${token.colorPrimary}` : 'none', outlineOffset: -6, borderRadius: 16 }}
      >
        {detailTask ? (
          /* 已结束任务：面板内简化对话窗（看回答 + 二次回复 + 跳主窗口） */
          <SecretaryTaskDetail
            task={detailTask}
            providerId={modelProviderId}
            modelId={modelId}
            thinking={thinking}
            readOnly={detailTask.origin === 'main'}
            onBack={() => setDetailTaskId(null)}
            onOpenInMain={() => openInMain(detailTask)}
          />
        ) : (
          <>
        {/* 头部：员工 + 切换 + 设置 + 关闭 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {employee && (
            <EmployeeAvatar
              employeeId={employee.id}
              avatarIcon={employee.avatar_icon}
              avatarColor={employee.avatar_color}
              avatarImage={employee.avatar_image}
              avatarType={employee.avatar_type}
              source={employee.source}
              size={30}
              shape="square"
            />
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: token.colorText }}>
                {employee?.name || t('secretary.title')}
              </span>
              <Tooltip title={t('secretary.switchEmployee')}>
                <Button
                  type="text"
                  size="small"
                  icon={<SwapOutlined />}
                  style={{ color: menu === 'employee' ? token.colorText : token.colorTextTertiary }}
                  onClick={() => setMenu((prev) => (prev === 'employee' ? null : 'employee'))}
                />
              </Tooltip>
            </div>
            <div style={{ fontSize: 11, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 190 }}>
              {employee?.description || t('secretary.subtitle')}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button
              type="text"
              size="small"
              icon={<SettingOutlined />}
              style={{ color: menu === 'settings' ? token.colorText : token.colorTextTertiary }}
              onClick={() => setMenu((prev) => (prev === 'settings' ? null : 'settings'))}
            />
            <Button
              type="text"
              size="small"
              icon={<CloseOutlined />}
              style={{ color: token.colorTextTertiary }}
              onClick={() => window.electronAPI.secretary.hidePanel()}
            />
          </div>
        </div>

        {/* 员工切换 / 设置：内联展开，面板与窗口同步长高，菜单不会被裁 */}
        {menu && (
          <div
            className="secretary-menu"
            style={{ borderColor: token.colorBorderSecondary, background: token.colorBgContainer }}
          >
            {menu === 'employee' && employees.map((emp) => (
              <button
                key={emp.id}
                className={`secretary-menu-item ${emp.id === employee?.id ? 'is-active' : ''}`}
                onClick={() => {
                  setEmployeeId(emp.id)
                  setMenu(null)
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
                <span style={{ flexShrink: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {emp.name}
                </span>
                <span style={{ flex: 1, minWidth: 0, marginLeft: 8, fontSize: 11, color: token.colorTextTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {emp.description}
                </span>
                {emp.id === employee?.id && <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />}
              </button>
            ))}

            {menu === 'settings' && (
              <>
                <button
                  className="secretary-menu-item"
                  style={{ color: token.colorText }}
                  onClick={async () => {
                    setMenu(null)
                    await window.electronAPI.secretary.setSettings({ enabled: false }).catch(() => {})
                    window.electronAPI.secretary.hidePanel()
                  }}
                >
                  <EyeInvisibleOutlined style={{ color: token.colorTextTertiary }} />
                  <span>{t('secretary.hidePet')}</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* 通知区：小秘书承接的日历提醒 / 自动化完成等 */}
        {notices.length > 0 && (
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextTertiary, padding: '0 8px 3px' }}>
              {t('secretary.notices')} {unreadNoticeCount > 0 ? `· ${unreadNoticeCount}` : ''}
            </div>
            {notices.map(noticeRow)}
          </div>
        )}

        {/* 任务区：最多显示 5 条，超出在列表内滚动 */}
        {(runningShown.length > 0 || finishedShown.length > 0) && (
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            <div ref={taskScrollRef} className="secretary-task-scroll" style={{ maxHeight: taskListMaxHeight }}>
              {runningShown.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextTertiary, padding: '0 8px 3px' }}>
                    {t('secretary.running')} {running.length > 1 ? `· ${running.length}` : ''}
                  </div>
                  {runningShown.map(taskRow)}
                </>
              )}
              {finishedShown.length > 0 && (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextTertiary, padding: '6px 8px 3px' }}>
                    {t('secretary.finished')} {finished.length > 1 ? `· ${finished.length}` : ''}
                  </div>
                  {finishedShown.map(taskRow)}
                </>
              )}
            </div>
          </div>
        )}

        {/* 输入区：与主窗口一致，文件以行内令牌显示在编辑器里 */}
        <div style={{ marginTop: 8, paddingTop: 9, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
          <SecretaryComposer
            ref={composerRef}
            placeholder={t('secretary.placeholder', { name: employee?.name || '' })}
            onSend={handleSend}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: token.colorTextQuaternary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t('secretary.inputHint')}
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
            <Button
              type="primary"
              size="small"
              loading={sending}
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
          </>
        )}
      </div>
      {/* 左右边缘拖拽柄：只调整宽度（高度由内容自适应），双击恢复默认宽度 */}
      {(['left', 'right'] as const).map((edge) => (
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
      <UnifiedInteractionModal compact />
    </>
  )
}

export default SecretaryPanel
