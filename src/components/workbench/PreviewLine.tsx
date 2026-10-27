import { useLayoutEffect, useRef, useEffect } from 'react'

/**
 * 折叠态预览行：内容按容器宽度折行，仅暴露最后一行。
 * 一行写满后整行清空跳到下一行，避免整段文本横向滚动。
 *
 * 只渲染尾部片段：思考内容/工具参数可能是几万字符且每次增量都在变长，
 * 整段塞进 DOM 会在每次更新时重排全文（流式期间 CPU 占用的重要来源）。
 *
 * 流式增量按 60ms 窗口批量到达，单批文本往往接近甚至超出一行宽度，
 * 直接渲染会退化成"每批文本各占一行闪一下"；这里按帧匀速揭示积压文本，
 * 恢复逐字填满一行的观感（DOM 写入仍按批进行，不增加增量次数）。
 */
const MAX_PREVIEW_CHARS = 400
/** 积压文本的补齐窗口：越小越实时，越大越平缓 */
const REVEAL_WINDOW_MS = 700
/** 最低揭示速度（字符/秒），慢速模型也保持连续增长而非整批跳动 */
const MIN_REVEAL_CPS = 30
/** 绘制间隔（≈30fps），避免每帧写 DOM 抵消流式渲染优化 */
const MIN_PAINT_INTERVAL_MS = 32

const PreviewLine: React.FC<{
  text: string
  fontSize: number
  lineHeight: number
  color: string
}> = ({ text, fontSize, lineHeight, color }) => {
  const ref = useRef<HTMLDivElement>(null)
  /** 最新目标文本（只增不减，段切换时整体替换） */
  const targetRef = useRef(text)
  /** 已揭示到的字符下标 */
  const revealedRef = useRef(text.length)
  const rafRef = useRef<number | null>(null)
  const lastPaintTsRef = useRef(0)
  const mountedRef = useRef(false)

  const paint = () => {
    const el = ref.current
    if (!el) return
    const end = revealedRef.current
    el.textContent = targetRef.current.slice(Math.max(0, end - MAX_PREVIEW_CHARS), end)
    el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    const target = text
    const prev = targetRef.current
    targetRef.current = target

    // 首次挂载：直接显示已有内容，历史段不重新逐字播放
    if (!mountedRef.current) {
      mountedRef.current = true
      revealedRef.current = target.length
      paint()
      return
    }

    // 内容被替换或回退（新段落、重试回滚）：直接对齐
    if (!target.startsWith(prev)) {
      revealedRef.current = target.length
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      paint()
      return
    }

    if (revealedRef.current > target.length) revealedRef.current = target.length
    if (rafRef.current !== null) return

    const step = (ts: number) => {
      rafRef.current = null
      const goal = targetRef.current.length
      const backlog = goal - revealedRef.current
      if (backlog <= 0) {
        lastPaintTsRef.current = 0
        return
      }
      if (!lastPaintTsRef.current) {
        lastPaintTsRef.current = ts
        rafRef.current = requestAnimationFrame(step)
        return
      }
      const elapsed = ts - lastPaintTsRef.current
      if (elapsed < MIN_PAINT_INTERVAL_MS) {
        rafRef.current = requestAnimationFrame(step)
        return
      }
      lastPaintTsRef.current = ts
      const cps = Math.max(MIN_REVEAL_CPS, backlog / (REVEAL_WINDOW_MS / 1000))
      const stepChars = Math.max(1, Math.round((cps * elapsed) / 1000))
      revealedRef.current = Math.min(goal, revealedRef.current + stepChars)
      paint()
      if (revealedRef.current < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        lastPaintTsRef.current = 0
      }
    }
    rafRef.current = requestAnimationFrame(step)
  }, [text])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

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
    />
  )
}

export default PreviewLine
