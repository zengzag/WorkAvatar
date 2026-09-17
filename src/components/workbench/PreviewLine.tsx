import { useLayoutEffect, useRef } from 'react'

/**
 * 折叠态预览行：内容按容器宽度折行，仅暴露最后一行。
 * 一行写满后整行清空跳到下一行，避免整段文本横向滚动。
 */
const PreviewLine: React.FC<{
  text: string
  fontSize: number
  lineHeight: number
  color: string
}> = ({ text, fontSize, lineHeight, color }) => {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div
      ref={ref}
      className="dm-preview-line"
      style={{
        flex: 1,
        minWidth: 0,
        height: lineHeight,
        fontSize,
        lineHeight: `${lineHeight}px`,
        color,
        overflow: 'hidden',
      }}
    >
      {text}
    </div>
  )
}

export default PreviewLine
