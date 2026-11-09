import { useEffect, useRef } from 'react'
import { createRobotStage, type RobotStageHandle, type RobotStageProps } from './robot3d'

interface Props extends RobotStageProps {
  className?: string
  style?: React.CSSProperties
  /** 静态预览：只渲染按需帧，不跑动画循环（设置页卡片用） */
  still?: boolean
  /** WebGL 不可用时通知外层回落到 SVG 版本 */
  onFail?: () => void
}

/** 3D 角色的 canvas 容器：只负责生命周期与属性透传，几何/动画在 robot3d.ts */
export const RobotCanvas: React.FC<Props> = ({ className, style, still, onFail, status, play, sleep, faceImage, faceIcon, accent, lookX, lookY }) => {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<RobotStageHandle | null>(null)
  const failRef = useRef(onFail)
  failRef.current = onFail
  const propsRef = useRef<RobotStageProps>({ status, play, sleep, faceImage, faceIcon, accent, lookX, lookY })
  propsRef.current = { status, play, sleep, faceImage, faceIcon, accent, lookX, lookY }

  useEffect(() => {
    let alive = true
    let ro: ResizeObserver | null = null
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    createRobotStage(canvas, propsRef.current, { still })
      .then((stage) => {
        if (!alive) {
          stage.dispose()
          return
        }
        stageRef.current = stage
        ro = new ResizeObserver(() => stage.resize())
        ro.observe(wrap)
        stage.resize()
      })
      .catch(() => {
        if (alive) failRef.current?.()
      })
    return () => {
      alive = false
      ro?.disconnect()
      stageRef.current?.dispose()
      stageRef.current = null
    }
  }, [])

  useEffect(() => {
    stageRef.current?.update({ status, play, sleep, faceImage, faceIcon, accent, lookX, lookY })
  }, [status, play, sleep, faceImage, faceIcon, accent, lookX, lookY])

  return (
    <div ref={wrapRef} className={className} style={{ width: '100%', height: '100%', ...style }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  )
}
