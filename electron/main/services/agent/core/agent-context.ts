import { AgentState } from './types'
import { AgentEventEmitter } from './agent-events'
import { generateId } from '../../common-utils'

export class AgentContext {
  readonly id: string
  readonly agentName: string
  private state: AgentState = 'idle'
  private metadata: Map<string, any> = new Map()
  readonly eventEmitter: AgentEventEmitter
  readonly createdAt: number
  private iterationCount: number = 0

  constructor(options: {
    id?: string
    agentName: string
    eventEmitter?: AgentEventEmitter
  }) {
    this.id = options.id ?? generateContextId()
    this.agentName = options.agentName
    this.eventEmitter = options.eventEmitter ?? new AgentEventEmitter()
    this.createdAt = Date.now()
  }

  setState(newState: AgentState): void {
    const oldState = this.state
    this.state = newState
    this.eventEmitter.emit('state:change', { from: oldState, to: newState })
  }

  getIterationCount(): number {
    return this.iterationCount
  }

  incrementIteration(): number {
    this.iterationCount++
    return this.iterationCount
  }

  setMetadata(key: string, value: any): void {
    this.metadata.set(key, value)
  }

  reset(): void {
    this.state = 'idle'
    this.iterationCount = 0
    this.metadata.clear()
  }
}

function generateContextId(): string {
  return `ctx_${generateId()}`
}
