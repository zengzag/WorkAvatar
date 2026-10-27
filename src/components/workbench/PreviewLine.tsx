import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 折叠态预览行：按容器宽度折行，只暴露最后一行（新行从下方平滑滑入）。
 *
 * 1. 文本只追加（appendData）：换行位置固定，可见行是被逐字填满的；
 *    每次重设"尾部 N 字窗口"会让换行点随起点漂移，行内内容会左右乱跳。
 * 2. 缓冲超过 TRIM_AT 时裁到"当前行起点"：被裁掉的都是上方整行，可见内容与换行位置不变。
 * 3. 滚动位置按指数缓动跟随（SMOOTH_MS）：换行时的行间位移平滑滑入，而不是瞬跳。
 */
const TRIM_AT = 3000
const KEEP = 1000
/** 滚动跟随的时间常数（ms）：越大越柔和，代价是与最新文本的滞后越明显 */
const SMOOTH_MS = 150

/** 当前可见（最后一行）在文本节点中的起始偏移 */
function lastLineStart(node: Text): number {
  const whole = document.createRange()
  whole.selectNodeContents(node)
  const rects = whole.getClientRects()
  if (rects.length <= 1) return 0
  const lastTop = rects[rects.length - 1].top
  const range = document.createRange()
  let lo = 0
  let hi = node.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    range.setStart(node, mid)
    range.setEnd(node, mid + 1)
    const rect = range.getClientRects()[0]
    if (!rect) {
      lo = mid + 1
      continue
    }
    if (rect.top >= lastTop - 1) {
      found = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return found
}

const PreviewLine: React.FC<{
  text: string
  fontSize: number
  lineHeight: number
  color: string
}> = ({ text, fontSize, lineHeight, color }) => {
  const ref = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const prevTextRef = useRef(text)
  /** 文本缓冲在 text 中的起始下标 */
  const bufferStartRef = useRef(0)
  /** 已渲染到的 text 下标 */
  const renderedEndRef = useRef(text.length)

  const follow = () => {
    const el = ref.current
    if (!el) return
    const target = el.scrollHeight - el.clientHeight
    if (target <= el.scrollTop + 1) {
      el.scrollTop = target
      return
    }
    if (rafRef.current !== null) return

    let lastTs = 0
    const step = (ts: number) => {
      const node = ref.current
      if (!node) {
        rafRef.current = null
        return
      }
      const goal = node.scrollHeight - node.clientHeight
      const diff = goal - node.scrollTop
      if (diff <= 1) {
        node.scrollTop = goal
        rafRef.current = null
        return
      }
      const dt = lastTs ? Math.min(64, ts - lastTs) : 16
      lastTs = ts
      node.scrollTop += diff * (1 - Math.exp(-dt / SMOOTH_MS))
      rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const prev = prevTextRef.current
    prevTextRef.current = text
    const node = el.firstChild as Text | null

    // 首次挂载 / 段切换 / 回滚：整体重建并直接对齐最新位置
    if (!node || !text.startsWith(prev) || text.length < renderedEndRef.current) {
      bufferStartRef.current = Math.max(0, text.length - KEEP)
      renderedEndRef.current = text.length
      el.textContent = text.slice(bufferStartRef.current)
      el.scrollTop = el.scrollHeight
      return
    }

    if (text.length > renderedEndRef.current) {
      node.appendData(text.slice(renderedEndRef.current))
      renderedEndRef.current = text.length

      // 超限裁剪：裁到当前行起点，可见行与换行位置都不变
      if (node.length > TRIM_AT) {
        const cut = lastLineStart(node)
        if (cut > 0) {
          node.deleteData(0, cut)
          bufferStartRef.current += cut
        }
      }
    }
    follow()
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
