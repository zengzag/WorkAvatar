import type { ProcessThinkChunkResult } from './llm-client-types'

/**
 * 创建 think 标签处理器
 *
 * 用于流式响应中解析 <think>...</think> 标签，分离思考内容和正文内容。
 * 维护内部状态以处理跨 chunk 的标签边界。
 */
export function createThinkProcessor() {
  let state: 'normal' | 'thinking' = 'normal'
  let buffer = ''

  function reset(): void {
    state = 'normal'
    buffer = ''
  }

  function processChunk(rawChunk: string): ProcessThinkChunkResult {
    buffer += rawChunk
    let thought = ''
    let content = ''

    while (buffer.length > 0) {
      if (state === 'normal') {
        const openIdx = buffer.toLowerCase().indexOf('<think')
        if (openIdx === -1) {
          const partials = ['<', '<t', '<th', '<thi', '<thin']
          let hasPartial = false
          for (const p of partials) {
            if (buffer.endsWith(p)) { hasPartial = true; break }
          }
          if (!hasPartial) {
            content += buffer
            buffer = ''
          }
          break
        } else {
          content += buffer.substring(0, openIdx)
          const afterOpen = buffer.substring(openIdx)
          const closeBracketIdx = afterOpen.indexOf('>')
          if (closeBracketIdx === -1) {
            buffer = ''
            state = 'thinking'
            break
          }
          buffer = afterOpen.substring(closeBracketIdx + 1)
          state = 'thinking'
        }
      } else if (state === 'thinking') {
        const closeIdx = buffer.toLowerCase().indexOf('</think')
        if (closeIdx === -1) {
          const partials = ['<', '</', '</t', '</th', '</thi', '</thin', '</think']
          let hasPartial = false
          for (const p of partials) {
            if (buffer.endsWith(p)) { hasPartial = true; break }
          }
          if (!hasPartial) {
            thought += buffer
            buffer = ''
          }
          break
        } else {
          thought += buffer.substring(0, closeIdx)
          const afterClose = buffer.substring(closeIdx)
          const closeBracketIdx = afterClose.indexOf('>')
          if (closeBracketIdx === -1) {
            buffer = ''
            state = 'normal'
            break
          }
          buffer = afterClose.substring(closeBracketIdx + 1)
          state = 'normal'
        }
      }
    }

    return {
      thought: thought || undefined,
      content: content || undefined,
    }
  }

  function finalize(): ProcessThinkChunkResult {
    let thought = ''
    let content = ''

    if (buffer.length > 0) {
      if (state === 'thinking') {
        thought = buffer
          .replace(/<\/?(?:think|t|th|thi|thin)$/gi, '')
          .trim()
      } else {
        content = buffer
          .replace(/^<?\/?t(?:h(?:i(?:n(?:k)?)?)?)?$/gi, '')
          .trim()
      }
      buffer = ''
    }
    state = 'normal'

    return {
      thought: thought || undefined,
      content: content || undefined,
    }
  }

  return { reset, processChunk, finalize }
}
