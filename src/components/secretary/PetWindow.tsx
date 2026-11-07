import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_SECRETARY_SETTINGS,
  isSecretaryCharacterId,
  type SecretaryCharacterId,
  type SecretarySettings,
} from '../../../electron/shared/channels/secretary'
import { CHARACTER_PLAYS, type PlayAction } from './characters'
import { SecretaryAvatar } from './SecretaryAvatar'
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

/** 无交互多久后进入睡眠（毫秒）：睡眠时只保留极缓呼吸，不再做小动作吸引注意 */
const SLEEP_AFTER_MS = 3 * 60 * 1000

/** 挂件窗：只负责表情、气泡、角标与拖动/点击，任务数据由面板窗经 BroadcastChannel 同步 */
const PetWindow: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [state, setState] = useState<SecretaryBusState>({
    status: 'idle', bubble: '', runningCount: 0, unreadCount: 0,
  })
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
  const statusRef = useRef(state.status)
  statusRef.current = state.status
  const lastActiveRef = useRef(Date.now())
  /** 面板打开时用户正在和小秘书交互，不进入睡眠 */
  const panelOpenRef = useRef(false)
  /** 面板打开时隐藏气泡：膨胀的提示会被面板窗口挡住，状态改为在面板内展示 */
  const [panelOpen, setPanelOpen] = useState(false)

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
    // 拖动中窗口失焦（如 Alt+Tab）时结束拖动，避免窗口黏在光标上
    const resetDrag = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setPressed(false)
      updateLook(0, 0)
      window.electronAPI.secretary.dragEnd()
    }
    window.addEventListener('blur', resetDrag)
    return () => {
      alive = false
      offSettings()
      offPanel()
      window.removeEventListener('blur', resetDrag)
    }
  }, [updateLook, touch])

  // 小秘书承接的宿主通知：挂件直接弹气泡，面板窗负责记录到通知列表
  useEffect(() => {
    const off = window.electronAPI.secretary.onNotify((payload) => {
      setNotice({ title: payload.title, body: payload.body, clickId: payload.clickId })
      window.clearTimeout(noticeTimerRef.current)
      noticeTimerRef.current = window.setTimeout(() => setNotice(null), 8000)
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
  }, [touch])

  useEffect(() => {
    // 完成 / 失败的表情停留 6 秒后回到空闲，期间若有新状态会重置计时
    if (state.status !== 'done' && state.status !== 'failed') return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: 'idle', bubble: '' }))
    }, 6000)
    return () => clearTimeout(timer)
  }, [state.status, state.bubble])

  // 空闲且长时间无交互进入睡眠；任务活动或用户交互都会立即唤醒
  useEffect(() => {
    if (state.status !== 'idle') {
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
  }, [state.status, setSleep])

  // 空闲时每隔几秒来一个随机小动作；任务状态一变或进入睡眠就收起
  useEffect(() => {
    if (state.status !== 'idle' || sleeping) {
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
  }, [state.status, sleeping, triggerPlay])

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
    if (state.status !== 'idle' || sleeping) return
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
  }, [state.status, sleeping])

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

  const statusClass = state.status === 'waiting' ? 'confirm' : state.status === 'failed' ? 'error' : state.status
  // 任务态优先展示执行阶段；空闲时优先展示刚收到的通知标题，其次是未读汇总
  const bubbleText = state.status === 'waiting' || state.status === 'running'
    ? state.bubble
    : notice?.title || (state.unreadCount > 0 ? t('secretary.bubbleUnread', { n: state.unreadCount }) : '')

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
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        setIgnore(true)
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
    </div>
  )
}

export default PetWindow
