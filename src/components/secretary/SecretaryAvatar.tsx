import { useState } from 'react'
import { SecretaryCharacter } from './characters'
import { RobotCanvas } from './RobotCanvas'
import type { SecretaryCharacterId } from '../../../electron/shared/channels/secretary'

interface Props {
  id: SecretaryCharacterId
  className?: string
  style?: React.CSSProperties
  faceImage?: string | null
  /** 员工头像图标 key：无上传头像时作为 robot 屏幕脸 */
  faceIcon?: string | null
  accent?: string
  status?: string
  play?: string
  /** 睡眠态：长时间无交互时只保留极缓呼吸 */
  sleep?: boolean
  /** 3D 角色只出静态帧（设置页预览，避免常驻渲染循环） */
  still?: boolean
  /** 光标相对挂件中心的归一化坐标，驱动 3D 头部跟随 */
  lookX?: number
  lookY?: number
}

/**
 * 角色渲染入口：robot 走 Three.js 真 3D（失败时回落到同款 SVG），
 * 其余角色沿用内联 SVG（父级仍按 viewBox 0 0 140 140 排布）。
 */
export const SecretaryAvatar: React.FC<Props> = ({ id, className, style, faceImage, faceIcon, accent, status, play, sleep, still, lookX, lookY }) => {
  const [glFailed, setGlFailed] = useState(false)
  if (!glFailed && id === 'robot') {
    return (
      <RobotCanvas
        className={className}
        style={style}
        status={status}
        play={play}
        sleep={sleep}
        faceImage={faceImage}
        faceIcon={faceIcon}
        accent={accent}
        still={still}
        lookX={lookX}
        lookY={lookY}
        onFail={() => setGlFailed(true)}
      />
    )
  }
  return (
    <svg className={className} style={style} viewBox="0 0 140 140" aria-hidden="true">
      <SecretaryCharacter id={id} faceImage={faceImage} faceIcon={faceIcon} />
    </svg>
  )
}
