import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Dropdown, Switch, Tooltip, theme } from 'antd'
import {
  CloseOutlined,
  PaperClipOutlined,
  SwapOutlined,
  SendOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SettingOutlined,
  BellOutlined,
  EyeInvisibleOutlined,
  StopOutlined,
  BulbOutlined,
  BulbFilled,
  RobotOutlined,
  CheckOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import EmployeeAvatar, { resolveEmployeeAvatarIcon } from '../common/EmployeeAvatar'
import { getCachedSceneDefaultModel } from '../../utils/default-model'
import { getProviderModels, supportsReasoningEffort, supportsThinking } from '../../utils/llm'
import type { Employee, LLMProvider, ThinkingLevel } from '../../types'
import {
  useSecretaryStore,
  selectRunningTasks,
  selectUnreadTasks,
  type SecretaryTask,
} from './secretary.store'
import { startSecretaryTask, abortSecretaryTask, broadcastSecretaryState } from './secretary-runner'
import { postSecretaryMessage, subscribeSecretaryBus, SECRETARY_PENDING_FILES_KEY } from './secretary-bus'
import { useInteractionStore } from '../../stores/interaction.store'
import UnifiedInteractionModal from '../common/UnifiedInteractionModal'
import SecretaryComposer, { type ComposerFile, type ComposerHandle } from './SecretaryComposer'
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
/** 权限 / ask_user 弹窗是浮层，不参与面板内容高度：窗口需要临时撑到该高度才能完整显示 */
const MODAL_MIN_HEIGHT = 480

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
  const [dnd, setDnd] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [providers, setProviders] = useState<LLMProvider[]>([])
  const [modelProviderId, setModelProviderId] = useState(
    () => localStorage.getItem(MODEL_PROVIDER_KEY) || getCachedSceneDefaultModel('workbench')?.provider_id || '',
  )
  const [modelId, setModelId] = useState(
    () => localStorage.getItem(MODEL_ID_KEY) || getCachedSceneDefaultModel('workbench')?.model_id || '',
  )
  const [thinking, setThinking] = useState<ThinkingLevel>(readStoredThinking)
  const fileRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<ComposerHandle>(null)
  /** 是否有待处理的权限 / ask_user 弹窗（弹窗挂在本窗口，收起面板会让它看不见） */
  const pendingRef = useRef(false)

  const tasks = useSecretaryStore((s) => s.tasks)
  const markViewed = useSecretaryStore((s) => s.markViewed)
  const running = useMemo(() => selectRunningTasks(tasks), [tasks])
  const unread = useMemo(() => selectUnreadTasks(tasks), [tasks])

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
    window.electronAPI.secretary.getState()
      .then((s) => setDnd(s.settings.dnd))
      .catch(() => {})
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

  // 面板内容高度 → 主进程同步窗口高度（弹窗打开时额外撑高）
  useEffect(() => {
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
      const target = Math.min(Math.max(natural, modalOpen ? MODAL_MIN_HEIGHT : 0), PANEL_MAX_HEIGHT)
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
  }, [modalOpen])

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

  const [menu, setMenu] = useState<'employee' | 'settings' | null>(null)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 弹窗打开时 Esc 不能收起面板，否则确认框会被一起藏起来
      if (interactionRequest) return
      // Esc 先收浮层，再收面板
      if (menu) {
        setMenu(null)
        return
      }
      window.electronAPI.secretary.hidePanel()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [menu, interactionRequest])

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
      window.electronAPI.secretary.hidePanel()
    } catch (err: any) {
      if (err?.message === 'NO_PROVIDER') message.warning(t('secretary.noProvider'))
      else message.error(t('secretary.sendFailed'))
    } finally {
      setSending(false)
    }
  }, [employee, sending, message, t, modelProviderId, modelId, thinking])

  const openTask = useCallback((task: SecretaryTask) => {
    setMenu(null)
    if (!task.viewed) markViewed(task.id)
    if (task.conversationId) {
      window.electronAPI.secretary.openTask({
        employeeId: task.employee.id,
        conversationId: task.conversationId,
      })
      window.electronAPI.secretary.hidePanel()
    }
  }, [markViewed])

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
  const unreadShown = unread

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
            void abortSecretaryTask(task.id)
          }}
          style={{ color: token.colorTextTertiary }}
        >
          <StopOutlined />
        </button>
      )}
    </div>
  )

  return (
    <>
      <div
        className="secretary-panel"
        ref={rootRef}
        style={{ background: token.colorBgElevated, borderColor: token.colorBorder, maxHeight: PANEL_MAX_HEIGHT }}
      onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      <div
        className="secretary-panel-inner"
        style={{ outline: dropping ? `1px dashed ${token.colorPrimary}` : 'none', outlineOffset: -6, borderRadius: 16 }}
      >
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
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {emp.name}
                </span>
                <span style={{ fontSize: 11, color: token.colorTextTertiary, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {emp.description}
                </span>
                {emp.id === employee?.id && <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 12 }} />}
              </button>
            ))}

            {menu === 'settings' && (
              <>
                <div className="secretary-menu-item" style={{ color: token.colorText, cursor: 'default' }}>
                  <BellOutlined style={{ color: token.colorTextTertiary }} />
                  <span style={{ flex: 1 }}>{t('secretary.dnd')}</span>
                  <Switch
                    size="small"
                    checked={dnd}
                    onChange={async (checked) => {
                      setDnd(checked)
                      await window.electronAPI.secretary.setSettings({ dnd: checked }).catch(() => {})
                    }}
                  />
                </div>
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

        {/* 任务区 */}
        {(runningShown.length > 0 || unreadShown.length > 0) && (
          <div style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${token.colorBorderSecondary}` }}>
            {runningShown.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextTertiary, padding: '0 8px 3px' }}>
                  {t('secretary.running')} {running.length > 1 ? `· ${running.length}` : ''}
                </div>
                {runningShown.map(taskRow)}
              </>
            )}
            {unreadShown.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: token.colorTextTertiary, padding: '6px 8px 3px' }}>
                  {t('secretary.unread')} {unread.length > 1 ? `· ${unread.length}` : ''}
                </div>
                {unreadShown.map(taskRow)}
              </>
            )}
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
      </div>
      </div>
      {/* 权限 / ask_user：交互会话绑定本窗口，弹窗必须挂在这里；小窗宽度有限，用紧凑版弹窗 */}
      <UnifiedInteractionModal compact />
    </>
  )
}

export default SecretaryPanel
