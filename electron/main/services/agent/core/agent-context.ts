import { Message, AgentState, SubAgentDelegation } from './types'
import { AgentEventEmitter } from './agent-events'
import { generateId } from '../../common-utils'

export class AgentContext {
  readonly id: string
  readonly agentName: string
  private messages: Message[] = []
  private state: AgentState = 'idle'
  private stateHistory: Array<{ state: AgentState; timestamp: number }> = []
  private metadata: Map<string, any> = new Map()
  private subAgentDelegations: Map<string, SubAgentDelegation> = new Map()
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
    this.recordState('idle')
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  addMessage(message: Message): void {
    this.messages.push({
      ...message,
      timestamp: message.timestamp ?? Date.now(),
    })
  }

  setMessages(messages: Message[]): void {
    this.messages = messages.map(m => ({
      ...m,
      timestamp: m.timestamp ?? Date.now(),
    }))
  }

  replaceMessages(messages: Message[]): void {
    this.messages = messages
  }

  getState(): AgentState {
    return this.state
  }

  setState(newState: AgentState): void {
    const oldState = this.state
    this.state = newState
    this.recordState(newState)
    this.eventEmitter.emit('state:change', { from: oldState, to: newState })
  }

  getIterationCount(): number {
    return this.iterationCount
  }

  incrementIteration(): number {
    this.iterationCount++
    return this.iterationCount
  }

  resetIterationCount(): void {
    this.iterationCount = 0
  }

  setMetadata(key: string, value: any): void {
    this.metadata.set(key, value)
  }

  getMetadata(key: string): any {
    return this.metadata.get(key)
  }

  getAllMetadata(): Record<string, any> {
    return Object.fromEntries(this.metadata)
  }

  addSubAgentDelegation(delegation: SubAgentDelegation): void {
    this.subAgentDelegations.set(delegation.agentId, delegation)
  }

  getSubAgentDelegation(agentId: string): SubAgentDelegation | undefined {
    return this.subAgentDelegations.get(agentId)
  }

  getAllDelegations(): SubAgentDelegation[] {
    return Array.from(this.subAgentDelegations.values())
  }

  getStateHistory(): Array<{ state: AgentState; timestamp: number }> {
    return [...this.stateHistory]
  }

  getElapsedTime(): number {
    return Date.now() - this.createdAt
  }

  reset(): void {
    this.messages = []
    this.state = 'idle'
    this.iterationCount = 0
    this.metadata.clear()
    this.subAgentDelegations.clear()
    this.recordState('idle')
  }

  private recordState(state: AgentState): void {
    this.stateHistory.push({ state, timestamp: Date.now() })
  }
}

function generateContextId(): string {
  return `ctx_${generateId()}`
}
