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

export interface AgentEvent {
  type: AgentEventName
  timestamp: number
  data: any
}

export type AgentEventHandler = (event: AgentEvent) => void

export class AgentEventEmitter {
  private handlers: Map<AgentEventName, Set<AgentEventHandler>> = new Map()
  private enabled: boolean

  constructor(options?: { enabled?: boolean }) {
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

  emit(event: AgentEventName, data?: any): void {
    if (!this.enabled) return

    const agentEvent: AgentEvent = {
      type: event,
      timestamp: Date.now(),
      data: data ?? null,
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
}
