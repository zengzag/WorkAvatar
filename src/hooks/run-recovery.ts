import type { MessageSegment } from '../components/workbench/types'

/**
 * 从后端 run 事件日志重建 subSegments（renderer 重载恢复用）。
 * 仅用于恢复展示；重载后的实时事件由 useStreamListeners.onRunEvent 继续注入。
 */
export function recoverSubSegmentsFromLog(
  log: Array<{ eventType: string; data: any }>,
  runId: string
): MessageSegment[] {
  const segs: MessageSegment[] = []
  const idPrefix = runId
  for (const ev of log) {
    const { eventType, data } = ev
    if (eventType === 'thought') {
      const thought = typeof data === 'string' ? data : data?.thought
      if (!thought) continue
      const last = segs[segs.length - 1]
      if (last && last.type === 'thinking' && last.isStreaming) {
        last.content = (last.content || '') + thought
      } else {
        segs.push({
          type: 'thinking',
          id: `${idPrefix}_rec_th_${segs.length}`,
          content: thought,
          isStreaming: true,
          collapsed: false,
          timestamp: Date.now(),
        })
      }
    } else if (eventType === 'chunk') {
      const chunk = typeof data === 'string' ? data : data?.chunk
      if (!chunk) continue
      const last = segs[segs.length - 1]
      if (last && last.type === 'answer' && last.isStreaming) {
        last.content = (last.content || '') + chunk
      } else {
        segs.push({
          type: 'answer',
          id: `${idPrefix}_rec_an_${segs.length}`,
          content: chunk,
          isStreaming: true,
          timestamp: Date.now(),
        })
      }
    } else if (eventType === 'tool_call') {
      const last = segs[segs.length - 1]
      if (last && last.type === 'answer' && last.isStreaming) {
        last.isStreaming = false
        last.completedAt = Date.now()
      }
      segs.push({
        type: 'tool_call',
        id: `${idPrefix}_rec_tc_${segs.length}`,
        toolName: data?.name || '',
        toolArgs: data?.args,
        toolCallId: data?.id,
        isToolComplete: false,
        collapsed: true,
        timestamp: Date.now(),
      })
    } else if (eventType === 'tool_result') {
      const name = data?.name
      const back = [...segs].reverse().find(s => s.type === 'tool_call' && s.toolName === name && !s.isToolComplete)
      if (back) {
        const idx = segs.indexOf(back)
        segs[idx] = { ...back, toolResult: data?.result, isToolComplete: true, collapsed: true, completedAt: Date.now() }
      }
    } else if (eventType === 'done') {
      for (const s of segs) {
        if (s.isStreaming) {
          s.isStreaming = false
          s.completedAt = s.completedAt || Date.now()
        }
        if (s.type === 'thinking') s.collapsed = true
      }
    }
  }
  return segs
}