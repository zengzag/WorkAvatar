import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { buildPiModel, resolvePiStreamFn } from '../../../electron/main/services/agent/llm/api-format'
import { buildPiStreamOptions } from '../../../electron/main/services/agent/llm/pi-stream-options'

/**
 * pi-ai 请求契约回归测试（真实 HTTP，不 mock pi-ai）。
 *
 * pi-ai 1.x 起 api 实现只接受归一化 transcript（提示词/工具声明折叠进首条 system 消息），
 * 项目侧由 resolvePiStreamFn → normalizeContext 兜住。本测试固定住该契约：
 * Context 简写仍能把提示词与工具带到上游，且会话路由头（opencode-go 必需）在每个接口形态都发出。
 * 升级 pi-ai 后若此处失败，说明契约变了，需同步 api-format.ts。
 */

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('')

const OPENAI_SSE = [
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
  'data: [DONE]\n\n',
].join('')

const RESPONSES_SSE = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r1","object":"response","status":"in_progress","output":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":0,"content_index":0,"delta":"hi"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","object":"response","status":"completed","output":[{"type":"message","id":"m1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
].join('')

const SSE_BY_FORMAT: Record<string, string> = {
  'chat-completions': OPENAI_SSE,
  'anthropic-messages': ANTHROPIC_SSE,
  'openai-responses': RESPONSES_SSE,
}

let server: http.Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

async function captureRequest(apiFormat: 'chat-completions' | 'anthropic-messages' | 'openai-responses', modelId: string) {
  let headers: http.IncomingHttpHeaders = {}
  let url = ''
  let body: any
  server = http.createServer((req, res) => {
    headers = req.headers
    url = req.url || ''
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(SSE_BY_FORMAT[apiFormat])
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const port = (server!.address() as any).port

  const model = buildPiModel({
    modelId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    providerType: 'opencode-go',
    apiFormat,
    imageInput: false,
  })
  const events = resolvePiStreamFn(apiFormat)(
    model,
    {
      systemPrompt: 'SYS-PROMPT',
      messages: [{ role: 'user', content: 'hi', timestamp: 1 }],
      tools: [{ name: 'tool_a', description: 'd', parameters: { type: 'object', properties: {} } }],
    },
    buildPiStreamOptions({
      providerType: 'opencode-go',
      modelId,
      apiFormat,
      apiKey: 'unused',
      sessionId: 'conv-xyz',
      maxTokens: 8192,
      streaming: true,
    }),
  )
  for await (const _event of events) { /* drain：请求已发出 */ }
  return { headers, url, body }
}

describe('pi-ai 请求契约（opencode-go）', () => {
  it('chat-completions：system 消息 + tools + 会话路由头', async () => {
    const { headers, url, body } = await captureRequest('chat-completions', 'glm-5.2')
    expect(url).toBe('/v1/chat/completions')
    expect(headers['x-opencode-session']).toBe('conv-xyz')
    expect(headers['x-opencode-client']).toBe('workavatar')
    expect(body.messages[0]).toMatchObject({ role: 'system', content: 'SYS-PROMPT' })
    expect(body.tools?.[0]?.function?.name).toBe('tool_a')
    expect(body.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('anthropic-messages：system 参数 + tools + 会话路由头', async () => {
    const { headers, url, body } = await captureRequest('anthropic-messages', 'minimax-m3')
    expect(url.startsWith('/v1/messages')).toBe(true)
    expect(headers['x-opencode-session']).toBe('conv-xyz')
    expect(headers['x-opencode-client']).toBe('workavatar')
    expect(JSON.stringify(body.system)).toContain('SYS-PROMPT')
    expect(body.tools?.[0]?.name).toBe('tool_a')
    expect(body.messages.at(-1)).toMatchObject({ role: 'user' })
  })

  it('openai-responses：instructions 与 tools 体现在请求体 + 会话路由头', async () => {
    const { headers, url, body } = await captureRequest('openai-responses', 'gpt-5.6-luna')
    expect(url).toBe('/v1/responses')
    expect(headers['x-opencode-session']).toBe('conv-xyz')
    expect(headers['x-opencode-client']).toBe('workavatar')
    // Responses 形态：系统提示词走 instructions（或等价字段），工具为扁平声明
    expect(JSON.stringify(body)).toContain('SYS-PROMPT')
    expect(JSON.stringify(body.tools)).toContain('tool_a')
    expect(JSON.stringify(body.input).includes('hi')).toBe(true)
  })
})
