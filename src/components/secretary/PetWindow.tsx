import { useCallback, useEffect, useRef, useState } from 'react'
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

/** 挂件窗：只负责表情、气泡、角标与拖动/点击，任务数据由面板窗经 BroadcastChannel 同步 */
const PetWindow: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [state, setState] = useState<SecretaryBusState>({
    status: 'idle', bubble: '', runningCount: 0, unreadCount: 0,
  })
  const [size, setSize] = useState(INITIAL_SETTINGS.size || DEFAULT_SECRETARY_SETTINGS.size)
  const [opacity, setOpacity] = useState(INITIAL_SETTINGS.opacity || DEFAULT_SECRETARY_SETTINGS.opacity)
  const [side, setSide] = useState<'left' | 'right'>('right')
  const [character, setCharacter] = useState<SecretaryCharacterId>(
    isSecretaryCharacterId(INITIAL_SETTINGS.character) ? INITIAL_SETTINGS.character : DEFAULT_SECRETARY_SETTINGS.character,
  )
  const [play, setPlay] = useState<PlayAction | ''>('')
  /** robot 屏幕脸：面板选中员工的头像图（无则显示员工头像图标，再退回默认 W 图标）；任务运行时跟随执行员工 */
  const [faceImage, setFaceImage] = useState<string | null>(null)
  const [faceIcon, setFaceIcon] = useState<string | null>(null)
  const [faceColor, setFaceColor] = useState<string | undefined>(undefined)
  const [pressed, setPressed] = useState(false)
  /** 3D 头部跟随：光标相对挂件中心的归一化偏移（-1..1），鼠标太远时归零 */
  const [look, setLook] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const petRef = useRef<HTMLDivElement>(null)
  const playTimerRef = useRef(0)

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
      setSide(s.side)
      if (isSecretaryCharacterId(s.settings.character)) setCharacter(s.settings.character)
    }).catch(() => {})
    const offSettings = window.electronAPI.secretary.onSettingsChanged((s) => {
      setSize(s.size)
      setOpacity(s.opacity)
      setCharacter(isSecretaryCharacterId(s.character) ? s.character : DEFAULT_SECRETARY_SETTINGS.character)
    })
    const offSide = window.electronAPI.secretary.onSideChanged(setSide)
    // 拖动中窗口失焦（如 Alt+Tab）时结束拖动，避免窗口黏在光标上
    const resetDrag = () => {
      dragRef.current = null
      setPressed(false)
      updateLook(0, 0)
    }
    window.addEventListener('blur', resetDrag)
    return () => {
      alive = false
      offSettings()
      offSide()
      window.removeEventListener('blur', resetDrag)
    }
  }, [updateLook])

  useEffect(() => {
    // 完成 / 失败的表情停留 6 秒后回到空闲，期间若有新状态会重置计时
    if (state.status !== 'done' && state.status !== 'failed') return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: 'idle', bubble: '' }))
    }, 6000)
    return () => clearTimeout(timer)
  }, [state.status, state.bubble])

  // 空闲时每隔几秒来一个随机小动作；任务状态一变就收起
  useEffect(() => {
    if (state.status !== 'idle') {
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
  }, [state.status, triggerPlay])

  useEffect(() => () => window.clearTimeout(playTimerRef.current), [])

  // 空闲时视线随机游移，制造“东张西望”的灵动效果；hover 跟随由 handleMouseMove 覆盖
  useEffect(() => {
    if (state.status !== 'idle') return
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
  }, [state.status])

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.screenX, startY: e.screenY, moved: false }
    setPressed(true)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.moved && Math.abs(e.screenX - drag.startX) + Math.abs(e.screenY - drag.startY) < 3) return
    drag.moved = true
    window.electronAPI.secretary.movePetTo(e.screenX, e.screenY)
  }

  const handlePointerUp = () => {
    const drag = dragRef.current
    dragRef.current = null
    setPressed(false)
    if (!drag) return
    if (drag.moved) window.electronAPI.secretary.dragEnd()
    else {
      triggerPlay()
      window.electronAPI.secretary.togglePanel()
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    // 拖动期间不切换穿透：中途开启穿透会打断 pointer capture，挂件会卡在半路
    if (dragRef.current) return
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
  const bubbleText = state.bubble || (state.unreadCount > 0 ? t('secretary.bubbleUnread', { n: state.unreadCount }) : '')

  return (
    <div
      className="pet-window"
      data-side={side}
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
          window.electronAPI.secretary.showContextMenu()
        }}
      >
        {bubbleText && (
          <div className="pet-bubble" style={{ background: token.colorBgElevated, borderColor: token.colorBorderSecondary, color: token.colorText }}>
            {statusClass === 'running' && <span className="pet-bubble-spin" style={{ borderTopColor: token.colorPrimary }} />}
            <span>{bubbleText}</span>
          </div>
        )}
        <SecretaryAvatar
          className="pet-svg"
          id={character}
          status={statusClass}
          play={play}
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
