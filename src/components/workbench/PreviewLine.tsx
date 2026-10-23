import { useLayoutEffect, useRef } from 'react'

/**
 * 折叠态预览行：内容按容器宽度折行，仅暴露最后一行。
 * 一行写满后整行清空跳到下一行，避免整段文本横向滚动。
 *
 * 只渲染尾部片段：思考内容/工具参数可能是几万字符且每次增量都在变长，
 * 整段塞进 DOM 会在每次更新时重排全文（流式期间 CPU 占用的重要来源）。
 */
const MAX_PREVIEW_CHARS = 400

const PreviewLine: React.FC<{
  text: string
  fontSize: number
  lineHeight: number
  color: string
}> = ({ text, fontSize, lineHeight, color }) => {
  const ref = useRef<HTMLDivElement>(null)
  const tail = text.length > MAX_PREVIEW_CHARS ? text.slice(-MAX_PREVIEW_CHARS) : text

  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [tail])

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
      {tail}
    </div>
  )
}

export default PreviewLine
