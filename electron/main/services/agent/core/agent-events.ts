export type AgentEventName =
  | 'run:start'
  | 'run:end'
  | 'run:error'
  | 'iteration:start'
  | 'iteration:end'
  | 'tool:call:start'
  | 'tool:call:end'
  | 'state:change'
  | 'plan:generated'
  | 'memory:compressed'
  | 'skill:activated'

export interface AgentEvent {
  type: AgentEventName
  timestamp: number
  data: any
}

export type AgentEventHandler = (event: AgentEvent) => void

export class AgentEventEmitter {
  private handlers: Map<AgentEventName, Set<AgentEventHandler>> = new Map()
  private eventHistory: AgentEvent[] = []
  private maxHistorySize: number
  private enabled: boolean

  constructor(options?: { maxHistorySize?: number; enabled?: boolean }) {
    this.maxHistorySize = options?.maxHistorySize ?? 1000
    this.enabled = options?.enabled ?? true
  }

  on(event: AgentEventName, handler: AgentEventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler)

    return () => {
      this.handlers.get(event)?.delete(handler)
    }
  }

  off(event: AgentEventName, handler: AgentEventHandler): void {
    this.handlers.get(event)?.delete(handler)
  }

  emit(event: AgentEventName, data?: any): void {
    if (!this.enabled) return

    const agentEvent: AgentEvent = {
      type: event,
      timestamp: Date.now(),
      data: data ?? null,
    }

    this.eventHistory.push(agentEvent)
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift()
    }

    const handlers = this.handlers.get(event)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(agentEvent)
        } catch {
          // handler errors should not break the event chain
        }
      }
    }
  }

  getHistory(eventType?: AgentEventName): AgentEvent[] {
    if (eventType) {
      return this.eventHistory.filter(e => e.type === eventType)
    }
    return [...this.eventHistory]
  }

  clearHistory(): void {
    this.eventHistory = []
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }
}
