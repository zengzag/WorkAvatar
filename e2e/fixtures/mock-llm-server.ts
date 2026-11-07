import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 本地 OpenAI 兼容 Mock LLM。
 *
 * 目标：让 UI 端到端测试完全不依赖外网与真实模型，同时保留真实的
 * SSE 流式协议、工具调用往返、错误分支，使测试可以稳定断言界面行为。
 *
 * 触发约定（写在用户消息里即可）：
 * - `[[tool:file_list]]` 第一次请求返回 tool_call，工具结果回传后返回最终文本
 * - `[[http-error]]`        返回 500，用于验证失败提示与重试入口
 * - `[[slow-stream]]`      长时间流式输出，用于验证停止生成
 */

export interface RecordedLlmRequest {
  method: string
  path: string
  body: any
  authorization?: string
}

export interface MockLlmServer {
  baseUrl: string
  requests: RecordedLlmRequest[]
  /** 让接下来的 N 次 chat/completions 返回 500（用于验证错误提示与原地重试） */
  failNext: (count: number) => void
  reset: () => void
  close: () => Promise<void>
}

const MODEL_ID = 'e2e-model'
const TOOL_CALL_ID = 'call_e2e_file_list'

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-e2e',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function lastUserIndex(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i
  }
  return -1
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('')
  }
  return ''
}

function buildReply(userText: string): string {
  const marker = userText.match(/\[\[[^\]]+\]\]/g)?.join(' ') ?? ''
  const concise = userText.replace(/\s+/g, ' ').trim().slice(0, 60)
  return `E2E 回复：已收到请求「${concise}」${marker ? `（${marker}）` : ''}`
}

interface ToolInvocation {
  name: string
  args: Record<string, unknown>
}

/**
 * 用户消息标记 → 工具调用。
 * 覆盖只读工具、需确认的写文件、以及跨员工委托三类关键链路。
 */
function resolveToolCall(userText: string): ToolInvocation | null {
  if (userText.includes('[[tool:file_list]]')) {
    return { name: 'file_list', args: { path: '.' } }
  }
  if (userText.includes('[[tool:file_write]]')) {
    // 工作区外写入：触发统一文件权限确认（区内写入会被自动放行，无法覆盖确认链路）
    return {
      name: 'file_write',
      args: { path: '../e2e-permission.txt', content: 'E2E-PERMISSION-CONTENT' },
    }
  }
  if (userText.includes('[[tool:file_write_local]]')) {
    return {
      name: 'file_write',
      args: { path: 'e2e-artifact.txt', content: 'E2E-ARTIFACT-CONTENT' },
    }
  }
  const delegate = userText.match(/\[\[tool:delegate:([^\]]+)\]\]/)
  if (delegate) {
    return {
      name: 'delegate_to_employee',
      args: {
        target_employee_id: delegate[1].trim(),
        instruction: '请完成 E2E 子任务并返回结果',
      },
    }
  }
  return null
}

export async function startMockLlmServer(): Promise<MockLlmServer> {
  const requests: RecordedLlmRequest[] = []
  let pendingFailures = 0

  const server = http.createServer((req, res) => {
    const url = req.url || '/'
    if (req.method === 'GET' && url.endsWith('/models')) {
      requests.push({ method: 'GET', path: url, body: null, authorization: req.headers.authorization as string | undefined })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'e2e' }],
      }))
      return
    }

    if (req.method === 'POST' && url.endsWith('/embeddings')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: new Array(8).fill(0.1) }],
        model: MODEL_ID,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }))
      return
    }

    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `Unsupported route: ${req.method} ${url}` } }))
      return
    }

    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body: any = {}
      try { body = JSON.parse(raw || '{}') } catch { /* 保留空对象 */ }
      requests.push({
        method: req.method || 'POST',
        path: url,
        body,
        authorization: req.headers.authorization as string | undefined,
      })

      const messages = Array.isArray(body.messages) ? body.messages : []
      const userIndex = lastUserIndex(messages)
      const userText = textOf(messages[userIndex]?.content)
      const toolResultsAfterUser = messages
        .slice(userIndex + 1)
        .filter((m: any) => m?.role === 'tool' || m?.role === 'toolResult')
      const stream = body.stream === true
      const systemText = textOf(messages.find((message: any) => message.role === 'system')?.content)
      // pi-ai 的 chat() 即便非流式聚合也会以 stream:true 发起请求，标题请求同样走流式，
      // 因此只能按系统提示词识别，不能依赖 stream 标记。
      const isTitleRequest = systemText.includes('conversation title generator')

      // 只让“真实对话流式请求”消费失败配额：自动标题生成不应把用于验证重试的失败次数提前用掉。
      const shouldFail = (pendingFailures > 0 && stream && !isTitleRequest) || userText.includes('[[http-error]]')
      if (shouldFail) {
        if (pendingFailures > 0 && stream && !isTitleRequest) pendingFailures -= 1
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'E2E injected upstream failure', type: 'server_error' } }))
        return
      }

      const toolInvocation = toolResultsAfterUser.length === 0 ? resolveToolCall(userText) : null

      if (!stream) {
        const content = toolInvocation
          ? ''
          : isTitleRequest ? 'E2E 自动标题' : buildReply(userText)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: MODEL_ID,
          choices: [{
            index: 0,
            message: toolInvocation
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: `${TOOL_CALL_ID}_${toolInvocation.name}`,
                    type: 'function',
                    function: { name: toolInvocation.name, arguments: JSON.stringify(toolInvocation.args) },
                  }],
                }
              : { role: 'assistant', content },
            finish_reason: toolInvocation ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }))
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      // 用响应侧的 close 判断客户端断开；req 的 close 在 keep-alive 请求体读完时就可能触发，
      // 会把正常流式输出误判为断开，导致永远不发 finish_reason。
      let closed = false
      res.on('close', () => {
        if (!res.writableEnded) closed = true
      })
      const send = (payload: string) => {
        if (closed) return false
        res.write(payload)
        return true
      }
      const finish = () => {
        send('data: [DONE]\n\n')
        res.end()
      }

      if (toolInvocation) {
        send(sseChunk({
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: `${TOOL_CALL_ID}_${toolInvocation.name}`,
            type: 'function',
            function: { name: toolInvocation.name, arguments: '' },
          }],
        }))
        send(sseChunk({
          tool_calls: [{ index: 0, function: { arguments: JSON.stringify(toolInvocation.args) } }],
        }))
        send(sseChunk({}, 'tool_calls'))
        finish()
        return
      }

      const reply = isTitleRequest ? 'E2E 自动标题' : buildReply(userText)
      const slow = userText.includes('[[slow-stream]]')
      const pieces = slow ? reply.split('').map((char) => char) : reply.match(/[\s\S]{1,6}/g) || [reply]
      let index = 0

      const push = () => {
        if (closed) return
        if (index >= pieces.length) {
          send(sseChunk({}, 'stop'))
          send(`data: ${JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: MODEL_ID,
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          })}\n\n`)
          finish()
          return
        }
        send(sseChunk({ content: pieces[index] }))
        index += 1
        setTimeout(push, slow ? 120 : 12)
      }

      send(sseChunk({ role: 'assistant', content: '' }))
      if (userText.includes('[[thinking]]')) {
        send(sseChunk({ reasoning_content: 'E2E 思考过程：先理解问题，再给出结论。' }))
      }
      push()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/v1`

  return {
    baseUrl,
    requests,
    failNext: (count: number) => { pendingFailures = count },
    reset: () => { requests.length = 0; pendingFailures = 0 },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}
