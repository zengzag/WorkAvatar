import type { BaseAgent } from '../core/base-agent'
import type { AgentResponse, AgentRunOptions, AgentRunStreamCallbacks, SubAgentDelegation } from '../core/types'
import { AgentEventEmitter } from '../core/agent-events'
import { AgentContext } from '../core/agent-context'

export type DelegationMode = 'sequential' | 'parallel' | 'supervisor'

export interface SubAgentDefinition {
  id: string
  name: string
  agent: BaseAgent
  description: string
  capabilities?: string[]
}

export interface DelegationRequest {
  task: string
  targetAgentId?: string
  mode?: DelegationMode
  context?: Record<string, any>
  timeoutMs?: number
}

export interface DelegationResult {
  agentId: string
  agentName: string
  success: boolean
  response?: AgentResponse
  error?: string
  latencyMs?: number
}

export class AgentOrchestrator {
  private agents: Map<string, SubAgentDefinition> = new Map()
  private eventEmitter: AgentEventEmitter
  private context: AgentContext

  constructor(options?: { eventEmitter?: AgentEventEmitter; context?: AgentContext }) {
    this.eventEmitter = options?.eventEmitter ?? new AgentEventEmitter()
    this.context = options?.context ?? new AgentContext({ agentName: 'Orchestrator' })
  }

  registerAgent(definition: SubAgentDefinition): void {
    this.agents.set(definition.id, definition)
  }

  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId)
  }

  getAgent(agentId: string): SubAgentDefinition | undefined {
    return this.agents.get(agentId)
  }

  getAgents(): SubAgentDefinition[] {
    return Array.from(this.agents.values())
  }

  findBestAgent(task: string): SubAgentDefinition | undefined {
    for (const agent of this.agents.values()) {
      if (agent.capabilities?.some(cap =>
        task.toLowerCase().includes(cap.toLowerCase())
      )) {
        return agent
      }
    }

    return this.agents.values().next().value
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startTime = Date.now()

    let targetAgent = request.targetAgentId
      ? this.agents.get(request.targetAgentId)
      : this.findBestAgent(request.task)

    if (!targetAgent) {
      return {
        agentId: '',
        agentName: '',
        success: false,
        error: 'No suitable agent found for delegation',
      }
    }

    const delegation: SubAgentDelegation = {
      agentId: targetAgent.id,
      task: request.task,
      status: 'running',
    }
    this.context.addSubAgentDelegation(delegation)

    this.eventEmitter.emit('run:start', {
      agentId: targetAgent.id,
      task: request.task,
    })

    try {
      const runOptions: AgentRunOptions = {
        query: request.task,
        metadata: request.context,
      }

      const response = await targetAgent.agent.run(runOptions)

      delegation.status = 'completed'
      delegation.result = response

      this.eventEmitter.emit('run:end', {
        agentId: targetAgent.id,
        success: response.success,
      })

      return {
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        success: response.success,
        response,
        latencyMs: Date.now() - startTime,
      }
    } catch (error: any) {
      delegation.status = 'failed'

      this.eventEmitter.emit('run:error', {
        agentId: targetAgent.id,
        error: error.message,
      })

      return {
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        success: false,
        error: error.message,
        latencyMs: Date.now() - startTime,
      }
    }
  }

  async delegateStream(
    request: DelegationRequest,
    callbacks: AgentRunStreamCallbacks,
    signal?: AbortSignal
  ): Promise<DelegationResult> {
    const startTime = Date.now()

    let targetAgent = request.targetAgentId
      ? this.agents.get(request.targetAgentId)
      : this.findBestAgent(request.task)

    if (!targetAgent) {
      return {
        agentId: '',
        agentName: '',
        success: false,
        error: 'No suitable agent found for delegation',
      }
    }

    const delegation: SubAgentDelegation = {
      agentId: targetAgent.id,
      task: request.task,
      status: 'running',
    }
    this.context.addSubAgentDelegation(delegation)

    try {
      const runOptions: AgentRunOptions = {
        query: request.task,
        metadata: request.context,
      }

      await targetAgent.agent.runStream(runOptions, callbacks, signal)

      delegation.status = 'completed'

      return {
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        success: true,
        latencyMs: Date.now() - startTime,
      }
    } catch (error: any) {
      delegation.status = 'failed'

      return {
        agentId: targetAgent.id,
        agentName: targetAgent.name,
        success: false,
        error: error.message,
        latencyMs: Date.now() - startTime,
      }
    }
  }

  async delegateParallel(
    tasks: Array<{ task: string; targetAgentId?: string }>
  ): Promise<DelegationResult[]> {
    const results = await Promise.all(
      tasks.map(async (t) => {
        return this.delegate({
          task: t.task,
          targetAgentId: t.targetAgentId,
          mode: 'parallel',
        })
      })
    )
    return results
  }

  getEventEmitter(): AgentEventEmitter {
    return this.eventEmitter
  }

  getContext(): AgentContext {
    return this.context
  }

  getDelegations(): SubAgentDelegation[] {
    return this.context.getAllDelegations()
  }
}
