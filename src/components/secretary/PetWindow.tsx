import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_SECRETARY_SETTINGS,
  isSecretaryCharacterId,
  isSecretaryDockEdge,
  type SecretaryCharacterId,
  type SecretaryDockEdge,
  type SecretarySettings,
} from '../../../electron/shared/channels/secretary'
import { isPointInDockHit } from '../../../electron/shared/secretary-dock'
import { dockPeekForStatus } from './secretary-dock-peek'
import { CHARACTER_PLAYS, type PlayAction } from './characters'
import { SecretaryAvatar } from './SecretaryAvatar'
import SecretaryDock from './SecretaryDock'
import { subscribeSecretaryBus, postSecretaryMessage, SECRETARY_PENDING_FILES_KEY, type SecretaryBusState } from './secretary-bus'
import './secretary.css'

/** 主进程建窗时经 query 带上的设置快照：首帧即渲染用户选中的形象，避免先闪默认形象再切换 */
const INITIAL_SETTINGS: Partial<SecretarySettings> = (() => {
  try {
    const raw = new URLSearchParams(window.location.search).get('settings')
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
})()

/** 建窗时已经贴边的话首帧直接渲染贴边条，避免先闪一下挂件 */
const INITIAL_DOCK: SecretaryDockEdge | null = (() => {
  const raw = new URLSearchParams(window.location.search).get('dock')
  return isSecretaryDockEdge(raw) ? raw : null
})()

/** 无交互多久后进入睡眠（毫秒）：睡眠时只保留极缓呼吸，不再做小动作吸引注意 */
const SLEEP_AFTER_MS = 3 * 60 * 1000

/** 挂件窗：只负责表情、气泡、角标与拖动/点击，任务数据由面板窗经 BroadcastChannel 同步 */
const PetWindow: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [state, setState] = useState<SecretaryBusState>({
    status: 'idle', bubble: '', runningCount: 0, unreadCount: 0, unreadTaskCount: 0, unreadNoticeCount: 0,
  })
  /** 展示态：完成/失败停留 6s 后回到 idle；不直接改总线 status，避免轮询重发时被误判成新的完成事件 */
  const [displayStatus, setDisplayStatus] = useState<SecretaryBusState['status']>('idle')
  const [size, setSize] = useState(INITIAL_SETTINGS.size || DEFAULT_SECRETARY_SETTINGS.size)
  const [opacity, setOpacity] = useState(INITIAL_SETTINGS.opacity || DEFAULT_SECRETARY_SETTINGS.opacity)

  const [character, setCharacter] = useState<SecretaryCharacterId>(
    isSecretaryCharacterId(INITIAL_SETTINGS.character) ? INITIAL_SETTINGS.character : DEFAULT_SECRETARY_SETTINGS.character,
  )
  const [play, setPlay] = useState<PlayAction | ''>('')
  /** robot 屏幕脸：面板选中员工的头像图（无则显示员工头像图标，再退回默认 W 图标）；任务运行时跟随执行员工 */
  const [faceImage, setFaceImage] = useState<string | null>(null)
  const [faceIcon, setFaceIcon] = useState<string | null>(null)
  const [faceColor, setFaceColor] = useState<string | undefined>(undefined)
  const [pressed, setPressed] = useState(false)
  /** 小秘书承接的宿主通知：挂件气泡短暂展示标题 */
  const [notice, setNotice] = useState<{ title: string; body: string; clickId?: string } | null>(null)
  /** 3D 头部跟随：光标相对挂件中心的归一化偏移（-1..1），鼠标太远时归零 */
  const [look, setLook] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const petRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  /** 气泡水平偏移与尾巴位置：靠屏幕边缘时整体内收，尾巴仍指向挂件 */
  const [bubbleTrim, setBubbleTrim] = useState({ shift: 0, tail: 0 })
  const playTimerRef = useRef(0)
  const noticeTimerRef = useRef(0)
  /** 睡眠态：长时间无交互且没有任务时进入，减少一切多余动作 */
  const [sleeping, setSleeping] = useState(false)
  const sleepingRef = useRef(false)
  const statusRef = useRef(displayStatus)
  statusRef.current = displayStatus
  const lastActiveRef = useRef(Date.now())
  /** 面板打开时用户正在和小秘书交互，不进入睡眠 */
  const panelOpenRef = useRef(false)
  /** 面板打开时隐藏气泡：膨胀的提示会被面板窗口挡住，状态改为在面板内展示 */
  const [panelOpen, setPanelOpen] = useState(false)

  /** 贴边位置：null 为自由挂件 */
  const [dockEdge, setDockEdge] = useState<SecretaryDockEdge | null>(INITIAL_DOCK)
  /** 贴边条悬停 / 拖拽 / 提醒临时展开 */
  const [dockHovered, setDockHovered] = useState(false)
  const [dockPressed, setDockPressed] = useState(false)
  const [dockPeek, setDockPeek] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const dockPeekTimerRef = useRef(0)
  const dockEdgeRef = useRef(dockEdge)
  dockEdgeRef.current = dockEdge
  const prevStatusRef = useRef(state.status)
  /** 上一次气泡文案：执行中步骤变化时重新弹出灵动岛 */
  const prevBubbleRef = useRef(state.bubble)
  /** 步骤更新的弹出节流：避免长任务里气泡持续展开 */
  const lastStepPeekRef = useRef(0)
  /** 面板打开时贴边条保持收起：灵动岛会盖住面板，点击贴边条即可收起面板 */
  const dockExpanded = !!dockEdge && !panelOpen && (dockHovered || dockPressed || dockPeek)

  const peekDock = useCallback((ms: number) => {
    if (!dockEdgeRef.current) return
    setDockPeek(true)
    window.clearTimeout(dockPeekTimerRef.current)
    dockPeekTimerRef.current = window.setTimeout(() => setDockPeek(false), ms)
  }, [])

  const setSleep = useCallback((value: boolean) => {
    if (sleepingRef.current === value) return
    sleepingRef.current = value
    setSleeping(value)
  }, [])

  /** 记录一次交互：处于睡眠时立即唤醒，倒计时在轮询里按 lastActive 判定 */
  const touch = useCallback(() => {
    lastActiveRef.current = Date.now()
    setSleep(false)
  }, [setSleep])

  /** 触发一次随机的调皮小动作（空闲时循环，点击挂件时也会来一下） */
  const triggerPlay = useCallback(() => {
    const list = CHARACTER_PLAYS[character]
    setPlay(list[Math.floor(Math.random() * list.length)])
    window.clearTimeout(playTimerRef.current)
    playTimerRef.current = window.setTimeout(() => setPlay(''), 1800)
  }, [character])

  // 透明区域鼠标穿透：指针进入挂件本体时关闭穿透，离开窗口时恢复。
  // mousemove 频率很高，状态没变时不要发 IPC（主进程同时有轮询兜底）
  const ignoreRef = useRef(true)
  const setIgnore = useCallback((ignore: boolean) => {
    if (ignoreRef.current === ignore) return
    ignoreRef.current = ignore
    window.electronAPI.secretary.setIgnoreMouse(ignore)
  }, [])

  /** 量化到 0.05 再落 state，避免每次 mousemove 都触发挂件重渲染 */
  const updateLook = useCallback((x: number, y: number) => {
    const qx = Math.round(x * 20) / 20
    const qy = Math.round(y * 20) / 20
    setLook((prev) => (prev.x === qx && prev.y === qy ? prev : { x: qx, y: qy }))
  }, [])

  /** 贴边时窗口有部分在屏外：气泡整体往屏内平移，尾巴仍对准挂件 */
  const placeBubble = useCallback(() => {
    const bubble = bubbleRef.current
    const pet = petRef.current
    if (!bubble || !pet) return
    const bubbleWidth = bubble.offsetWidth
    if (!bubbleWidth) return
    const petBox = pet.getBoundingClientRect()
    const petCenter = petBox.left + petBox.width / 2
    const naturalLeft = petCenter - bubbleWidth / 2
    const screenInfo = window.screen as Screen & { availLeft?: number }
    const viewLeft = (screenInfo.availLeft ?? 0) - window.screenX
    const viewRight = viewLeft + screenInfo.availWidth
    const margin = 8
    const left = Math.min(
      Math.max(naturalLeft, viewLeft + margin),
      Math.max(viewLeft + margin, viewRight - margin - bubbleWidth),
    )
    const shift = Math.round(left - naturalLeft)
    const tail = Math.round(Math.max(14, Math.min(bubbleWidth - 14, petCenter - left)))
    setBubbleTrim((prev) => (prev.shift === shift && prev.tail === tail ? prev : { shift, tail }))
  }, [])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    return () => setIgnore(false)
  }, [setIgnore])

  useEffect(() => {
    postSecretaryMessage({ type: 'request-state' })
    const off = subscribeSecretaryBus((msg) => {
      if (msg.type === 'state') {
        setState(msg.payload)
        // 运行中员工的头像优先接管屏幕脸；空闲时保留最后身份
        if (msg.payload.petImage || msg.payload.petIcon) {
          setFaceImage(msg.payload.petImage || null)
          setFaceIcon(msg.payload.petIcon || null)
        }
        if (msg.payload.petColor) setFaceColor(msg.payload.petColor)
      } else if (msg.type === 'face') {
        setFaceImage(msg.payload.avatarImage || null)
        setFaceIcon(msg.payload.avatarIcon || null)
        setFaceColor(msg.payload.avatarColor || undefined)
      }
    })
    return off
  }, [])

  useEffect(() => {
    let alive = true
    window.electronAPI.secretary.getState().then((s) => {
      if (!alive) return
      setSize(s.settings.size)
      setOpacity(s.settings.opacity)
      panelOpenRef.current = s.panelOpen
      setPanelOpen(s.panelOpen)
      setDockEdge(s.dockEdge ?? null)
      if (isSecretaryCharacterId(s.settings.character)) setCharacter(s.settings.character)
    }).catch(() => {})
    const offSettings = window.electronAPI.secretary.onSettingsChanged((s) => {
      setSize(s.size)
      setOpacity(s.opacity)
      setCharacter(isSecretaryCharacterId(s.character) ? s.character : DEFAULT_SECRETARY_SETTINGS.character)
    })
    // 面板显隐也算交互：打开期间保持清醒，关闭后重新计时
    const offPanel = window.electronAPI.secretary.onPanelVisibility((open) => {
      panelOpenRef.current = open
      setPanelOpen(open)
      touch()
    })
    // 主进程决定贴边 / 脱离贴边后同步给渲染端
    const offDock = window.electronAPI.secretary.onDockChanged((edge) => setDockEdge(edge))
    // 拖动中窗口失焦（如 Alt+Tab）时结束拖动，避免窗口黏在光标上
    const resetDrag = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setPressed(false)
      setDockPressed(false)
      updateLook(0, 0)
      window.electronAPI.secretary.dragEnd()
    }
    window.addEventListener('blur', resetDrag)
    return () => {
      alive = false
      offSettings()
      offPanel()
      offDock()
      window.removeEventListener('blur', resetDrag)
    }
  }, [updateLook, touch])

  // 小秘书承接的宿主通知：挂件直接弹气泡，面板窗负责记录到通知列表
  useEffect(() => {
    const off = window.electronAPI.secretary.onNotify((payload) => {
      setNotice({ title: payload.title, body: payload.body, clickId: payload.clickId })
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8000)
      // 贴边时用「灵动岛」短暂展开承接提醒，收起态也能看到发生了什么
      peekDock(6000)
      touch()
    })
    // 交互请求已在其他窗口处理：若气泡正展示同一条提醒则立即收起
    const offDismiss = window.electronAPI.secretary.onNotifyDismiss?.(({ clickId }) => {
      if (!clickId) return
      setNotice((prev) => {
        if (!prev || prev.clickId !== clickId) return prev
        window.clearTimeout(noticeTimerRef.current)
        return null
      })
    })
    // 监听注册完成后再上报，避免主进程在 React 挂载前投递导致通知丢失
    window.electronAPI.secretary.notifyReady('pet')
    return () => {
      off()
      offDismiss?.()
      window.clearTimeout(noticeTimerRef.current)
    }
  }, [touch, peekDock])

  // 贴边时任务开始 / 等待确认 / 完成 / 失败：自动展开灵动岛提示，避免收起态错过状态变化
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = state.status
    if (!dockEdgeRef.current) return
    const reason = dockPeekForStatus(prev, state.status)
    if (reason === 'running') peekDock(5000)
    else if (reason === 'waiting') peekDock(8000)
    else if (reason === 'terminal') peekDock(4500)
  }, [state.status, peekDock])

  // 未读结果增加时也弹一次：覆盖「快速任务」直接从 running 变为新的 done（聚合状态没变）的情况
  const prevUnreadTaskCountRef = useRef(state.unreadTaskCount)
  useEffect(() => {
    const prev = prevUnreadTaskCountRef.current
    prevUnreadTaskCountRef.current = state.unreadTaskCount
    if (!dockEdgeRef.current || state.unreadTaskCount <= prev) return
    peekDock(4500)
  }, [state.unreadTaskCount, peekDock])

  // 执行中的步骤文案变化也要弹出消息；6s 内的连续变化只展开一次，避免长任务一直挡在桌面上
  useEffect(() => {
    const prev = prevBubbleRef.current
    prevBubbleRef.current = state.bubble
    if (!dockEdgeRef.current) return
    if (state.status !== 'running' && state.status !== 'waiting') return
    if (!state.bubble || state.bubble === prev) return
    const now = Date.now()
    if (now - lastStepPeekRef.current < 6000) return
    lastStepPeekRef.current = now
    peekDock(5000)
  }, [state.bubble, state.status, peekDock])

  // 贴边条展开 / 收起通知主进程调整透明区域命中范围
  useEffect(() => {
    if (!dockEdge) return
    window.electronAPI.secretary.setDockExpanded(dockExpanded)
  }, [dockEdge, dockExpanded])

  // 脱离贴边后复位临时展开状态，避免下次贴边时还没悬停就展开
  useEffect(() => {
    if (dockEdge) return
    setDockHovered(false)
    setDockPressed(false)
    setDockPeek(false)
    window.clearTimeout(dockPeekTimerRef.current)
  }, [dockEdge])

  // 面板打开时清掉尚未结束的弹出，避免关闭面板后灵动岛突然展开
  useEffect(() => {
    if (!panelOpen) return
    window.clearTimeout(dockPeekTimerRef.current)
    setDockPeek(false)
  }, [panelOpen])

  useEffect(() => () => window.clearTimeout(dockPeekTimerRef.current), [])

  // 总线状态变化驱动展示态；完成 / 失败的表情停留 6 秒后回到空闲（只改展示态）
  useEffect(() => {
    setDisplayStatus(state.status)
  }, [state.status])

  useEffect(() => {
    if (displayStatus !== 'done' && displayStatus !== 'failed') return
    const timer = setTimeout(() => setDisplayStatus('idle'), 6000)
    return () => clearTimeout(timer)
  }, [displayStatus])

  // 空闲且长时间无交互进入睡眠；任务活动或用户交互都会立即唤醒
  useEffect(() => {
    if (displayStatus !== 'idle') {
      setSleep(false)
      return
    }
    // 刚回到空闲时重新计时，避免任务结束后立刻入睡
    lastActiveRef.current = Date.now()
    setSleep(false)
    const timer = window.setInterval(() => {
      if (statusRef.current !== 'idle' || panelOpenRef.current) return
      if (Date.now() - lastActiveRef.current >= SLEEP_AFTER_MS) setSleep(true)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [displayStatus, setSleep])

  // 空闲时每隔几秒来一个随机小动作；任务状态一变或进入睡眠就收起
  useEffect(() => {
    if (displayStatus !== 'idle' || sleeping) {
      setPlay('')
      return
    }
    let alive = true
    let next = 0
    const schedule = () => {
      next = window.setTimeout(() => {
        if (!alive) return
        triggerPlay()
        schedule()
      }, 5200 + Math.random() * 5200)
    }
    schedule()
    return () => {
      alive = false
      window.clearTimeout(next)
    }
  }, [displayStatus, sleeping, triggerPlay])

  useEffect(() => () => window.clearTimeout(playTimerRef.current), [])

  // 入睡时把视线收回正中，避免半睡半醒盯着光标
  useEffect(() => {
    if (!sleeping) return
    petRef.current?.style.setProperty('--look-x', '0')
    petRef.current?.style.setProperty('--look-y', '0')
    updateLook(0, 0)
  }, [sleeping, updateLook])

  // 空闲时视线随机游移，制造“东张西望”的灵动效果；hover 跟随由 handleMouseMove 覆盖
  useEffect(() => {
    if (displayStatus !== 'idle' || sleeping) return
    let alive = true
    let timer = 0
    const glance = () => {
      if (!alive) return
      const el = petRef.current
      if (el) {
        const back = Math.random() < .3
        el.style.setProperty('--look-x', back ? '0' : ((Math.random() * 2 - 1) * .8).toFixed(2))
        el.style.setProperty('--look-y', back ? '0' : ((Math.random() * 2 - 1) * .5).toFixed(2))
      }
      timer = window.setTimeout(glance, 1600 + Math.random() * 2800)
    }
    timer = window.setTimeout(glance, 1200)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [displayStatus, sleeping])

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    touch()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* 指针已失效时忽略，不影响后续点击判定 */ }
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
    setPressed(true)
    // 让主进程重置拖动起点：残留的起点会让这次拖动按旧基准算位移，窗口直接跳走
    window.electronAPI.secretary.dragStart()
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.moved && Math.abs(e.screenX - drag.startX) + Math.abs(e.screenY - drag.startY) < 3) return
    drag.moved = true
    window.electronAPI.secretary.movePetTo()
  }

  const handlePointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    setPressed(false)
    if (!drag) return
    // 无论是否真的移动都结束主进程的拖动：否则起点残留会一直跳过穿透判定
    window.electronAPI.secretary.dragEnd()
    // 主进程吸附到屏幕边缘后才最终落位，稍后再按新位置校准气泡
    if (drag.moved) window.setTimeout(placeBubble, 150)
    if (!drag.moved) {
      triggerPlay()
      window.electronAPI.secretary.togglePanel()
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    // 拖动期间不切换穿透：中途开启穿透会打断 pointer capture，挂件会卡在半路
    if (dragRef.current) return
    touch()
    const rect = petRef.current?.getBoundingClientRect()
    if (!rect) return
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom
    setIgnore(!inside)
    // 瞳孔轻微跟随光标，让挂件“活”起来
    const rawX = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
    const rawY = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
    const nx = Math.max(-1, Math.min(1, rawX))
    const ny = Math.max(-1, Math.min(1, rawY))
    petRef.current?.style.setProperty('--look-x', nx.toFixed(2))
    petRef.current?.style.setProperty('--look-y', ny.toFixed(2))
    // 3D 头部跟随：光标贴近挂件时看过去，离远了（超过约 2.8 个半身位）回到自然姿态
    const dist = Math.hypot(rawX, rawY)
    const near = dist <= 1.6 ? 1 : dist >= 2.8 ? 0 : (2.8 - dist) / 1.2
    updateLook(nx * near, ny * near)
  }

  /** 贴边条的悬停判定：向屏幕内侧与两端扩出热区，与主进程命中区一致（展开态也不收回热区） */
  const isInsideDock = (e: React.MouseEvent): boolean => {
    if (!dockEdge) return false
    const rect = dockRef.current?.getBoundingClientRect()
    if (!rect) return false
    return isPointInDockHit(
      dockEdge,
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      e.clientX,
      e.clientY,
    )
  }

  const handleWindowMouseMove = (e: React.MouseEvent) => {
    if (!dockEdge) {
      handleMouseMove(e)
      return
    }
    if (dragRef.current) return
    touch()
    const inside = isInsideDock(e)
    setDockHovered(inside)
    setIgnore(!inside)
  }

  const handleDockPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    touch()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* 指针已失效时忽略，不影响后续点击判定 */ }
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
    setDockPressed(true)
    window.electronAPI.secretary.dragStart()
  }

  const handleDockPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.moved && Math.abs(e.screenX - drag.startX) + Math.abs(e.screenY - drag.startY) < 3) return
    drag.moved = true
    window.electronAPI.secretary.movePetTo()
  }

  const handleDockPointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    setDockPressed(false)
    if (!drag) return
    // 主进程决定回贴还是脱离贴边；结果通过 onDockChanged 回到这里
    window.electronAPI.secretary.dragEnd()
    if (!drag.moved) window.electronAPI.secretary.togglePanel()
  }

  const statusClass = displayStatus === 'waiting' ? 'confirm' : displayStatus === 'failed' ? 'error' : displayStatus
  // 任务态优先展示执行阶段；空闲时优先展示刚收到的通知标题，其次是未读汇总
  const bubbleText = displayStatus === 'waiting' || displayStatus === 'running'
    ? state.bubble
    : notice?.title || (state.unreadTaskCount > 0
        ? t('secretary.bubbleUnread', { n: state.unreadTaskCount })
        : state.unreadNoticeCount > 0
          ? t('secretary.bubbleUnreadNotices', { n: state.unreadNoticeCount })
          : '')
  /** 贴边条展开后的标题：通知优先展示标题，其次任务步骤与空闲文案 */
  const dockTitle = notice?.title || bubbleText || (
    displayStatus === 'running' ? t('secretary.working')
      : displayStatus === 'waiting' ? t('secretary.waiting')
        : displayStatus === 'done' ? t('secretary.done')
          : displayStatus === 'failed' ? t('secretary.failed')
            : t('secretary.dockIdle')
  )

  // 气泡文案/挂件尺寸变化后重新贴边；首帧同理（布局效果早于绘制，不会闪）
  useLayoutEffect(() => {
    placeBubble()
  }, [bubbleText, size, panelOpen, placeBubble])

  // 拖动期间窗口跟着光标移动，逐帧校准气泡，避免中途越出屏幕
  useEffect(() => {
    if (!pressed) return
    let raf = 0
    const tick = () => {
      placeBubble()
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [pressed, placeBubble])

  return (
    <div
      className="pet-window"
      onMouseMove={handleWindowMouseMove}
      onMouseLeave={() => {
        setIgnore(true)
        setDockHovered(false)
        petRef.current?.style.setProperty('--look-x', '0')
        petRef.current?.style.setProperty('--look-y', '0')
        updateLook(0, 0)
      }}
      onDragOver={(e) => { e.preventDefault() }}
      onDrop={(e) => {
        e.preventDefault()
        touch()
        const files = Array.from(e.dataTransfer?.files || [])
        if (files.length === 0) return
        // 跨窗口无法传 File 对象，取真实路径后交给面板窗生成附件
        const paths: string[] = []
        for (const file of files) {
          try {
            const p = window.electronAPI.getPathForFile(file)
            if (p) paths.push(p)
          } catch { /* ignore */ }
        }
        if (paths.length === 0) return
        // 面板窗可能还没创建（首次拖入），先暂存路径，面板挂载时消费
        try { localStorage.setItem(SECRETARY_PENDING_FILES_KEY, JSON.stringify(paths)) } catch { /* ignore */ }
        postSecretaryMessage({ type: 'files', paths })
        window.electronAPI.secretary.showPanel()
      }}
      style={{ background: 'transparent' }}
    >
      {dockEdge ? (
        <SecretaryDock
          edge={dockEdge}
          expanded={dockExpanded}
          pressed={dockPressed}
          statusClass={statusClass}
          title={dockTitle}
          opacity={opacity}
          unreadCount={state.unreadCount}
          rootRef={dockRef}
          onPointerDown={handleDockPointerDown}
          onPointerMove={handleDockPointerMove}
          onPointerUp={handleDockPointerUp}
          onPointerCancel={handleDockPointerUp}
          onContextMenu={(e) => {
            e.preventDefault()
            touch()
            window.electronAPI.secretary.showContextMenu()
          }}
        />
      ) : (
      <div
        className={`pet-anchor pc-scope ${pressed ? 'is-pressed' : ''}`}
        data-state={statusClass}
        data-character={character}
        data-play={play || undefined}
        data-sleep={sleeping ? '' : undefined}
        style={{
          width: size,
          height: size,
          opacity,
          ['--pet-color' as any]: state.petColor || '#4C8DFF',
          ['--pc-face-color' as any]: faceColor,
        }}
        ref={petRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          touch()
          window.electronAPI.secretary.showContextMenu()
        }}
      >
        {!panelOpen && bubbleText && (
          <div
            className="pet-bubble"
            ref={bubbleRef}
            title={notice?.body || bubbleText}
            style={{
              background: token.colorBgElevated,
              borderColor: token.colorBorderSecondary,
              color: token.colorText,
              left: `calc(50% + ${bubbleTrim.shift}px)`,
              ['--pet-bubble-tail' as any]: `${bubbleTrim.tail}px`,
            }}
          >
            {statusClass === 'running' && <span className="pet-bubble-spin" style={{ borderTopColor: token.colorPrimary }} />}
            <span className="pet-bubble-text">{bubbleText}</span>
          </div>
        )}
        <SecretaryAvatar
          className="pet-svg"
          id={character}
          status={statusClass}
          play={play}
          sleep={sleeping}
          faceImage={faceImage}
          faceIcon={faceIcon}
          accent={faceColor}
          lookX={look.x}
          lookY={look.y}
        />
        {state.petImage && <img className="pet-id" src={state.petImage} alt="" draggable={false} />}
        {state.unreadCount > 0 && (
          <div className="pet-badge" style={{ background: token.colorError }}>
            {state.unreadCount > 99 ? '99+' : state.unreadCount}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

export default PetWindow
