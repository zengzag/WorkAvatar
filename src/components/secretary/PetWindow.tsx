import { useCallback, useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { subscribeSecretaryBus, postSecretaryMessage, SECRETARY_PENDING_FILES_KEY, type SecretaryBusState } from './secretary-bus'
import './secretary.css'

const PET_SVG = (
  <>
    <ellipse className="pet-shadow" cx="70" cy="128" rx="31" ry="5.5" />
    <g className="pet-body">
      <path className="pet-ear" d="M47 32C39 20 44 11 56 17 58.5 24 57 31 55 37Z" />
      <path className="pet-ear" d="M93 32C101 20 96 11 84 17 81.5 24 83 31 85 37Z" />
      <path className="pet-body-shape" d="M70 21C45 21 27 39 27 69 27 102 46 122 70 122 94 122 113 102 113 69 113 39 95 21 70 21Z" />
      <path className="pet-tuft" d="M70 21C69 13 75 9.5 79 14 74 15 72.5 18 73.5 22Z" />
      <ellipse className="pet-belly" cx="70" cy="99" rx="25" ry="16" />
      <g className="pet-eyes">
        <g>
          <circle className="pet-eye-white" cx="55" cy="64" r="9.2" />
          <circle className="pet-pupil" cx="55" cy="64" r="5.3" />
          <circle className="pet-glint" cx="57" cy="61.8" r="1.7" />
        </g>
        <g>
          <circle className="pet-eye-white" cx="85" cy="64" r="9.2" />
          <circle className="pet-pupil" cx="85" cy="64" r="5.3" />
          <circle className="pet-glint" cx="87" cy="61.8" r="1.7" />
        </g>
      </g>
      <g className="pet-happy"><path d="M47 67q8-9 16 0" /><path d="M77 67q8-9 16 0" /></g>
      <g className="pet-x"><path d="M48 57l14 13M62 57L48 70" /><path d="M78 57l14 13M92 57L78 70" /></g>
      <ellipse className="pet-blush" cx="41" cy="81" rx="6.6" ry="3.8" />
      <ellipse className="pet-blush" cx="99" cy="81" rx="6.6" ry="3.8" />
      <path className="pet-mouth-smile" d="M63.5 84q6.5 6.5 13 0" />
      <ellipse className="pet-mouth-o" cx="70" cy="87.5" rx="3.8" ry="4.6" />
      <path className="pet-mouth-big" d="M62 82q8 11 16 0-8 3-16 0Z" />
      <ellipse className="pet-foot" cx="55" cy="120.5" rx="7.5" ry="4.6" />
      <ellipse className="pet-foot" cx="85" cy="120.5" rx="7.5" ry="4.6" />
    </g>
    <path className="pet-sweat" d="M99 40c0 0 4 5.2 4 7.6a4 4 0 0 1-8 0c0-2.4 4-7.6 4-7.6Z" />
    <g className="pet-spark">
      <path d="M30 44l1.4 3.4 3.4 1.4-3.4 1.4L30 53.6l-1.4-3.4-3.4-1.4 3.4-1.4L30 44Z" fill="#F5B73C" />
      <path d="M112 54l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1 1.1-2.7Z" fill="#2FBF71" />
    </g>
  </>
)

/** 挂件窗：只负责表情、气泡、角标与拖动/点击，任务数据由面板窗经 BroadcastChannel 同步 */
const PetWindow: React.FC = () => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [state, setState] = useState<SecretaryBusState>({
    status: 'idle', bubble: '', runningCount: 0, unreadCount: 0,
  })
  const [size, setSize] = useState(128)
  const [opacity, setOpacity] = useState(1)
  const [side, setSide] = useState<'left' | 'right'>('right')
  const [pressed, setPressed] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const petRef = useRef<HTMLDivElement>(null)

  // 透明区域鼠标穿透：指针进入挂件本体时关闭穿透，离开窗口时恢复
  const setIgnore = useCallback((ignore: boolean) => {
    window.electronAPI.secretary.setIgnoreMouse(ignore)
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
      if (msg.type === 'state') setState(msg.payload)
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
    }).catch(() => {})
    const offSettings = window.electronAPI.secretary.onSettingsChanged((s) => {
      setSize(s.size)
      setOpacity(s.opacity)
    })
    const offSide = window.electronAPI.secretary.onSideChanged(setSide)
    // 拖动中窗口失焦（如 Alt+Tab）时结束拖动，避免窗口黏在光标上
    const resetDrag = () => {
      dragRef.current = null
      setPressed(false)
    }
    window.addEventListener('blur', resetDrag)
    return () => {
      alive = false
      offSettings()
      offSide()
      window.removeEventListener('blur', resetDrag)
    }
  }, [])

  useEffect(() => {
    // 完成 / 失败的表情停留 6 秒后回到空闲，期间若有新状态会重置计时
    if (state.status !== 'done' && state.status !== 'failed') return
    const timer = setTimeout(() => {
      setState((prev) => ({ ...prev, status: 'idle', bubble: '' }))
    }, 6000)
    return () => clearTimeout(timer)
  }, [state.status, state.bubble])

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
    else window.electronAPI.secretary.togglePanel()
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    // 拖动期间不切换穿透：中途开启穿透会打断 pointer capture，挂件会卡在半路
    if (dragRef.current) return
    const rect = petRef.current?.getBoundingClientRect()
    if (!rect) return
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
      && e.clientY >= rect.top && e.clientY <= rect.bottom
    setIgnore(!inside)
  }

  const statusClass = state.status === 'waiting' ? 'confirm' : state.status === 'failed' ? 'error' : state.status
  const bubbleText = state.bubble || (state.unreadCount > 0 ? t('secretary.bubbleUnread', { n: state.unreadCount }) : '')

  return (
    <div
      className="pet-window"
      data-side={side}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setIgnore(true)}
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
        className={`pet-anchor ${pressed ? 'is-pressed' : ''}`}
        data-state={statusClass}
        style={{ width: size, height: size, opacity, ['--pet-color' as any]: state.petColor || '#4C8DFF' }}
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
        <svg className="pet-svg" viewBox="0 0 140 140" aria-hidden="true">{PET_SVG}</svg>
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
