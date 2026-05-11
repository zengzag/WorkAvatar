export interface AgentConfig {
  name?: string
  instructions?: string
  role?: string
  model: string
  apiKey?: string
  baseUrl?: string
  treeOfThought?: boolean
  totModel?: string
  totApiKey?: string
  totBaseUrl?: string
  filterTools?: boolean
  selfLearning?: boolean
  skillsDirectories?: string[]
  autoDiscoverSkills?: boolean
  debug?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  toolCallId?: string
  toolCalls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }>
  timestamp?: number
}

export interface AgentRunOptions {
  query: string
  tools?: string[]
  stream?: boolean
  maxRetry?: number
  userId?: string
  history?: Message[]
  metadata?: Record<string, any>
  useSkills?: boolean
}

export interface AgentRunStreamCallbacks {
  onChunk?: (chunk: string) => void
  onThought?: (thought: string) => void
  onToolCall?: (toolCall: { name: string; args: any }) => void
  onToolResult?: (toolResult: { name: string; result: any; rawResult?: any }) => void
  onDone?: () => void
  onError?: (error: string) => void
}

export interface AgentResponse {
  content: string
  toolCalls?: Array<{
    name: string
    args: any
    result: any
  }>
  success: boolean
  error?: string
}
