import { ILLMProvider, LLMMessage } from '../llm/types'
import type { IPlanner, Plan, PlanningContext, PlanningStrategy } from './types'

export class PlannerFactory {
  static create(
    strategy: PlanningStrategy,
    llmProvider: ILLMProvider,
    options?: { model?: string; apiKey?: string; baseUrl?: string; providerType?: string }
  ): IPlanner {
    switch (strategy) {
      case 'react':
        return new ReActPlanner(llmProvider, options)
      case 'plan_execute':
        return new PlanExecutePlanner(llmProvider, options)
      case 'tool_filter':
        return new ToolFilterPlanner(llmProvider, options)
      default:
        return new ReActPlanner(llmProvider, options)
    }
  }
}

abstract class BasePlanner implements IPlanner {
  protected llmProvider: ILLMProvider
  protected options?: { model?: string; apiKey?: string; baseUrl?: string; providerType?: string }

  constructor(llmProvider: ILLMProvider, options?: { model?: string; apiKey?: string; baseUrl?: string; providerType?: string }) {
    this.llmProvider = llmProvider
    this.options = options
  }

  abstract plan(query: string, availableTools: any[], context?: PlanningContext): Promise<Plan>

  protected async callPlanningLLM(messages: LLMMessage[]): Promise<string> {
    if (this.options?.model && this.options?.apiKey && this.options?.baseUrl) {
      const { OpenAIProvider } = await import('../llm/openai-provider')
      const planningProvider = new OpenAIProvider({
        model: this.options.model,
        apiKey: this.options.apiKey,
        baseUrl: this.options.baseUrl,
        providerType: this.options.providerType,
      })
      const response = await planningProvider.chat(messages, [])
      return response.content
    }

    const response = await this.llmProvider.chat(messages, [])
    return response.content
  }
}

class ReActPlanner extends BasePlanner {
  async plan(query: string, availableTools: any[], context?: PlanningContext): Promise<Plan> {
    const toolsStr = JSON.stringify(
      availableTools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
      })),
      null,
      2
    )

    const systemPrompt = `你是一个任务规划助手。分析用户问题，从以下工具列表中选择必要工具。
工具列表：${toolsStr}

请按以下格式输出：
1. 分析用户需求
2. 选择需要的工具
3. 输出JSON格式的工具选择结果

输出格式：
{"selectedToolNames": ["tool_name_1", "tool_name_2"], "reasoning": "选择理由"}`

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ]

    if (context?.additionalInstructions) {
      messages[0].content += `\n\n额外指令：${context.additionalInstructions}`
    }

    const response = await this.callPlanningLLM(messages)

    return this.parsePlan(query, response, availableTools)
  }

  private parsePlan(query: string, response: string, availableTools: any[]): Plan {
    try {
      const parsed = this.extractJSON(response)
      const selectedToolNames: string[] = parsed.selectedToolNames || parsed.tools?.map((t: any) => t.name) || []

      return {
        goal: query,
        steps: selectedToolNames.map((name, i) => ({
          id: `step_${i + 1}`,
          description: `使用工具 ${name}`,
          toolName: name,
          status: 'pending' as const,
        })),
        selectedToolNames,
        reasoning: parsed.reasoning,
      }
    } catch {
      return {
        goal: query,
        steps: [],
        selectedToolNames: availableTools.map(t => t.function?.name || t.name),
        reasoning: '规划解析失败，使用全部工具',
      }
    }
  }

  private extractJSON(text: string): any {
    let refined = text.trim()
    if (refined.startsWith('```json')) {
      refined = refined.substring(7)
    }
    if (refined.endsWith('```')) {
      refined = refined.substring(0, refined.length - 3)
    }
    return JSON.parse(refined.trim())
  }
}

class PlanExecutePlanner extends BasePlanner {
  async plan(query: string, availableTools: any[], context?: PlanningContext): Promise<Plan> {
    const toolsStr = JSON.stringify(
      availableTools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
      })),
      null,
      2
    )

    const thought1 = await this.think(query, toolsStr, context)
    const refinedThought = await this.reflect(query, toolsStr, thought1)
    const planResult = await this.extract(query, toolsStr, refinedThought)

    return this.parsePlanResult(query, planResult, availableTools)
  }

  private async think(query: string, toolsStr: string, context?: PlanningContext): Promise<string> {
    const systemPrompt = `分析用户问题，从以下工具列表中选择必要工具进行调用，生成最终回答。
工具列表：${toolsStr}
${context?.additionalInstructions ? `\n额外指令：${context.additionalInstructions}` : ''}`

    const response = await this.callPlanningLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ])
    return response
  }

  private async reflect(query: string, toolsStr: string, thought: string): Promise<string> {
    const systemPrompt = `分析用户问题，从以下工具列表中选择必要工具进行调用，生成最终回答。
工具列表：${toolsStr}`

    const response = await this.callPlanningLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
      { role: 'assistant', content: thought },
      { role: 'user', content: '反思上述规划，仅使用<工具列表>中的工具，输出修正后的任务规划，不含其他分析。' },
    ])
    return response
  }

  private async extract(query: string, toolsStr: string, refinedThought: string): Promise<string> {
    const systemPrompt = `分析用户问题，从以下工具列表中选择必要工具进行调用，生成最终回答。
工具列表：${toolsStr}`

    const response = await this.callPlanningLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
      { role: 'assistant', content: refinedThought },
      { role: 'user', content: '输出JSON格式的工具选择结果，格式：{"tools": [{"name": "工具名"}]}，仅输出JSON，不含解释。' },
    ])
    return response
  }

  private parsePlanResult(query: string, result: string, availableTools: any[]): Plan {
    try {
      let refined = result.trim()
      if (refined.startsWith('```json')) refined = refined.substring(7)
      if (refined.endsWith('```')) refined = refined.substring(0, refined.length - 3)
      refined = refined.trim()

      const parsed = JSON.parse(refined)
      const selectedToolNames: string[] = (parsed.tools || []).map((t: any) => (t.name || '').toLowerCase().trim()).filter(Boolean)

      return {
        goal: query,
        steps: selectedToolNames.map((name, i) => ({
          id: `step_${i + 1}`,
          description: `使用工具 ${name}`,
          toolName: name,
          status: 'pending' as const,
        })),
        selectedToolNames,
        reasoning: result,
      }
    } catch {
      return {
        goal: query,
        steps: [],
        selectedToolNames: availableTools.map(t => t.function?.name || t.name),
        reasoning: '规划解析失败，使用全部工具',
      }
    }
  }
}

class ToolFilterPlanner extends BasePlanner {
  async plan(query: string, availableTools: any[], _context?: PlanningContext): Promise<Plan> {
    return {
      goal: query,
      steps: [],
      selectedToolNames: availableTools.map(t => t.function?.name || t.name),
      reasoning: 'ToolFilter模式：仅过滤工具，不生成执行计划',
    }
  }
}
