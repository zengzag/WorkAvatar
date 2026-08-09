import path from 'path'
import type { ToolDefinition } from './types'
import DatabaseService from '../../database.service'
import EmployeeAgentService from '../../employee-agent.service'
import WorkspaceManagerService from '../../workspace-manager.service'
import MemoryRefinementService from '../../memory-refinement.service'
import { interactionContext } from '../../unified-interaction.service'
import { forwardDelegationEvent } from '../../../ipc/llm.handlers'
import { generateId } from '../../common-utils'
import { createLogger } from '../../logger'

const logger = createLogger('DelegateTool')

/** 委托链深度上限：防止递归死循环 */
const MAX_DELEGATION_DEPTH = 3
/** context_files 最大数量，防止 LLM 传入过多文件撑爆上下文 */
const MAX_CONTEXT_FILES = 10
/** 单个 context_file 读取上限（字符），防止超大文件 */
const MAX_FILE_CHARS = 8000

/**
 * delegate_to_employee 工具：
 * 主管员工调用此工具，将子任务委托给指定数字员工执行。
 *
 * 设计要点：
 * - 子员工独立 conversation + 独立 SessionContext（工作区/权限隔离）
 * - 子会话 parent_conversation_id 指向主管会话，不出现在任务列表/检索结果中
 * - 子会话工作区目录位于主管会话工作区下（非子员工工作区下）
 * - 子员工 chatStream 的事件经 AGENT_DELEGATION_EVENT IPC 通道转发到主管前端
 * - 主管 LLM 仅拿到结果摘要（resultSummary），子员工完整过程不进主管上下文
 * - 子员工 token 用量累计到主管 SessionContext.childTokenUsage，onDone 时合并
 * - abort 信号传播：从主管 SessionContext.abortSignal 派生子 signal
 * - 递归防护：delegationDepth ≤ 3 + delegationChain 去环
 * - 禁止自委托；可委托员工列表由 resolveActiveTools 动态注入 description
 */
export const delegateTool: ToolDefinition = {
  id: 'delegate_to_employee',
  name: 'delegate_to_employee',
  title: '委托给数字员工',
  summary: '将子任务委托给指定数字员工执行，同步等待返回结果',
  description: `将当前子任务委托给另一个数字员工执行，适用于需要其他员工专业能力（如资料检索、文档生成）的场景。
参数：
- target_employee_id: 目标数字员工 id（从下方「可委托员工列表」中选择）
- instruction: 委托给该员工的任务指令（清晰描述要做什么）
- context_files: 可选，传给子员工的上下文文件绝对路径列表（最多 ${MAX_CONTEXT_FILES} 个，需位于当前任务工作区或员工工作区内）
返回：子员工的执行结果摘要。
限制：不能委托给自己；委托深度上限 ${MAX_DELEGATION_DEPTH} 层。`,
  parameters: {
    type: 'object',
    properties: {
      target_employee_id: { type: 'string', description: '目标数字员工 id（从可委托员工列表中选择）' },
      instruction: { type: 'string', description: '委托给该员工的任务指令' },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: `可选，传给子员工的上下文文件绝对路径（最多 ${MAX_CONTEXT_FILES} 个）`,
      },
    },
    required: ['target_employee_id', 'instruction'],
  },
  handler: handleDelegate,
  source: 'builtin',
  onDemand: false,
  permission: 'safe',
  noRetry: true,
  timeoutMs: 5 * 60 * 1000,
}

/** 构造 delegate_to_employee 工具的动态 description（含可委托员工列表） */
export function buildDelegateDescription(employeeId: string, employees: Array<{ id: string; name: string; description?: string; role?: string }>): string {
  const others = employees.filter(e => e.id !== employeeId)
  const listText = others.length > 0
    ? others.map(e => {
        const role = e.role || e.description?.trim()
        return `- ${e.name} (id=${e.id})${role ? `：${role.slice(0, 80)}` : ''}`
      }).join('\n')
    : '（暂无其他数字员工）'
  return `${delegateTool.description}

可委托员工列表：
${listText}`
}

async function handleDelegate(args: Record<string, any>): Promise<any> {
  const { target_employee_id, instruction } = args
  const contextFiles: string[] = Array.isArray(args.context_files) ? args.context_files : []

  const store = interactionContext.getStore()
  if (!store) {
    return { success: false, error: '委托失败：缺少会话上下文' }
  }

  // 提前生成 delegationId，确保所有返回路径都能携带（前端据此关联 segment）
  const delegationId = generateId()

  const db = DatabaseService.getInstance().getDb()

  // 提前查询 target 信息，失败返回中携带 targetEmployeeName 供前端展示
  const target = db.prepare('SELECT id, name, avatar_type FROM employees WHERE id = ?').get(target_employee_id) as
    | { id: string; name: string; avatar_type?: string }
    | undefined
  const targetName = target?.name || target_employee_id

  // ① 递归防护
  const depth = store.delegationDepth ?? 0
  const chain = store.delegationChain ?? []
  if (depth >= MAX_DELEGATION_DEPTH) {
    return { success: false, error: `委托深度超限（上限 ${MAX_DELEGATION_DEPTH} 层，当前 ${depth}）`, delegationId, targetEmployeeName: targetName }
  }
  if (chain.includes(target_employee_id)) {
    return { success: false, error: '检测到委托环：目标员工已在委托链中', delegationId, targetEmployeeName: targetName }
  }

  // ② 禁止自委托
  if (target_employee_id === store.employeeId) {
    return { success: false, error: '不能委托给自己', delegationId, targetEmployeeName: targetName }
  }

  // ③ 目标员工存在性
  if (!target) {
    return { success: false, error: `目标员工不存在: ${target_employee_id}`, delegationId, targetEmployeeName: targetName }
  }

  // ④ 子员工 provider/model 解析：复用全局默认 LLM 解析逻辑（settings → is_default provider）
  const resolved = await MemoryRefinementService.getInstance().resolveEmployeeLLM()
  if (!resolved) {
    return { success: false, error: '无可用 LLM 提供商（请在设置中配置默认模型）', delegationId, targetEmployeeName: targetName }
  }
  const { providerId, modelId } = resolved

  // ⑤ context_files 路径校验 + 数量限制
  if (contextFiles.length > MAX_CONTEXT_FILES) {
    return { success: false, error: `context_files 数量超限（最多 ${MAX_CONTEXT_FILES} 个，传入 ${contextFiles.length} 个）`, delegationId, targetEmployeeName: targetName }
  }
  const validatedFiles = validateContextFiles(contextFiles, store.conversationId)
  if (validatedFiles.errors.length > 0) {
    return {
      success: false,
      error: `context_files 路径校验失败：\n${validatedFiles.errors.join('\n')}`,
      delegationId,
      targetEmployeeName: targetName,
    }
  }

  // ⑥ 创建子 conversation（parent_conversation_id 指向主管会话，工作区目录在主管会话目录下）
  const ws = WorkspaceManagerService.getInstance()
  const parentConversationId = store.conversationId
  const subConv = ws.createConversation(target_employee_id, undefined, `委托: ${instruction.slice(0, 30)}`, true, parentConversationId)

  // ⑦ 构造子员工输入
  const subMessages = await buildSubMessages(instruction, validatedFiles.valid)

  // ⑧ 建立事件转发
  const parentSessionId = store.sessionId
  const agentService = EmployeeAgentService.getInstance()

  let finalAnswer = ''
  let tokenUsage: any = undefined
  let subError: string | null = null

  const forward = (eventType: string, data: any) => {
    forwardDelegationEvent(parentSessionId, delegationId, eventType, data)
  }

  // ⑨ 通知前端委托开始（传递 delegationId + target 信息，便于前端创建 delegation segment）
  forward('start', {
    delegationId,
    targetEmployeeId: target_employee_id,
    targetEmployeeName: target.name,
    targetAvatarType: target.avatar_type,
    instruction,
  })

  // ⑩ abort 信号传播：从主管 context 读取 abortSignal，创建子 AbortController
  // 主管 abort 时触发子 AbortController.abort()，中断子员工 chatStream
  const parentSignal = store.abortSignal
  const subAbortController = new AbortController()
  const onParentAbort = () => subAbortController.abort()
  if (parentSignal) {
    if (parentSignal.aborted) {
      subAbortController.abort()
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }
  }

  // ⑪ 调用子员工 chatStream，事件转发到主管前端
  //    关键：minimal_mode=false（否则 resolveActiveTools 返回空，子员工无工具可用）
  //    enable_thinking 跟随主管设置（主管开则子员工开，主管关则子员工关）
  try {
    await interactionContext.run(
      {
        sessionId: generateId(),
        employeeId: target_employee_id,
        conversationId: subConv.id,
        delegationDepth: depth + 1,
        delegationChain: [...chain, store.employeeId],
        parentSessionId,
        delegationId,
        abortSignal: subAbortController.signal,
        enableThinking: store.enableThinking,
      },
      async () => {
        await agentService.chatStream(
          {
            employee_id: target_employee_id,
            provider_id: providerId,
            model_id: modelId,
            messages: subMessages,
            conversation_id: subConv.id,
            minimal_mode: false,
            enable_thinking: store.enableThinking === true,
            use_skills: true,
            high_permission: store.highPermission === true,
          },
          {
            onChunk: (chunk: string) => {
              finalAnswer += chunk
              forward('chunk', chunk)
            },
            onThought: (thought: string) => forward('thought', thought),
            onToolCallDelta: (d: any) => forward('tool_call_delta', d),
            onToolCall: (tc: any) => forward('tool_call', { ...tc, delegationId }),
            onToolResult: (tr: any) => forward('tool_result', { ...tr, delegationId }),
            onToolProgress: (p: any) => forward('tool_progress', p),
            onDone: (metadata?: any) => {
              tokenUsage = metadata?.tokenUsage
              // 累计子员工 token 到主管 SessionContext
              if (tokenUsage && store.childTokenUsage) {
                store.childTokenUsage.promptTokens = (store.childTokenUsage.promptTokens || 0) + (tokenUsage.promptTokens || tokenUsage.prompt_tokens || 0)
                store.childTokenUsage.completionTokens = (store.childTokenUsage.completionTokens || 0) + (tokenUsage.completionTokens || tokenUsage.completion_tokens || 0)
                store.childTokenUsage.totalTokens = (store.childTokenUsage.totalTokens || 0) + (tokenUsage.totalTokens || tokenUsage.total_tokens || 0)
              } else if (tokenUsage) {
                store.childTokenUsage = {
                  promptTokens: tokenUsage.promptTokens || tokenUsage.prompt_tokens || 0,
                  completionTokens: tokenUsage.completionTokens || tokenUsage.completion_tokens || 0,
                  totalTokens: tokenUsage.totalTokens || tokenUsage.total_tokens || 0,
                }
              }
              forward('done', {
                tokenUsage,
                delegationId,
                targetEmployeeId: target_employee_id,
                targetEmployeeName: target.name,
                targetAvatarType: target.avatar_type,
              })
            },
            onError: (error: string) => {
              subError = error
              forward('error', { error, delegationId })
            },
          },
          subAbortController.signal
        )
      }
    )
  } catch (err: any) {
    subError = err?.message || String(err)
    forward('error', { error: subError, delegationId })
  } finally {
    // 清理 abort 事件监听，防止内存泄漏
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort)
    }
  }

  // ⑫ 汇总结果摘要（不把完整子对话塞进主管上下文）
  if (subError) {
    return {
      success: false,
      error: `委托给 ${target.name} 执行失败：${subError}`,
      delegationId,
      targetEmployeeName: target.name,
      tokenUsage,
    }
  }

  const summary = finalAnswer.trim() || '(子员工未产出文本)'
  return {
    success: true,
    output: `已委托 ${target.name} 完成任务。\n结果摘要：\n${summary}`,
    delegationId,
    targetEmployeeName: target.name,
    tokenUsage,
  }
}

/**
 * 校验 context_files 路径安全性：
 * - 必须位于主管会话工作区或主管员工工作区内
 * - 防止 LLM 传入系统敏感文件路径（如 /etc/passwd、C:\Windows\System32\config\SAM）
 */
function validateContextFiles(
  files: string[],
  conversationId?: string
): { valid: string[]; errors: string[] } {
  const valid: string[] = []
  const errors: string[] = []
  const ws = WorkspaceManagerService.getInstance()
  const db = DatabaseService.getInstance().getDb()

  // 收集允许的目录白名单
  const allowedRoots: string[] = []
  if (conversationId) {
    const convWs = ws.getConversationWorkspacePath(conversationId)
    if (convWs) allowedRoots.push(path.resolve(convWs))
  }
  // 主管员工工作区
  const ctx = interactionContext.getStore()
  if (ctx?.employeeId) {
    const emp = db.prepare('SELECT workspace_path FROM employees WHERE id = ?').get(ctx.employeeId) as { workspace_path?: string } | undefined
    if (emp?.workspace_path) allowedRoots.push(path.resolve(emp.workspace_path))
  }

  for (const fp of files) {
    if (!fp || typeof fp !== 'string') {
      errors.push(`路径无效: ${fp}`)
      continue
    }
    const resolved = path.resolve(fp)
    const isAllowed = allowedRoots.some(root => {
      const rel = path.relative(root, resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (!isAllowed) {
      errors.push(`路径不在允许的工作区范围内: ${fp}`)
      continue
    }
    valid.push(fp)
  }
  return { valid, errors }
}

/** 构造子员工输入消息：instruction + context_files 内容 */
async function buildSubMessages(
  instruction: string,
  contextFiles: string[]
): Promise<Array<{ role: string; content: string }>> {
  let content = instruction
  if (contextFiles.length > 0) {
    const fs = await import('fs/promises')
    const parts: string[] = [instruction, '', '--- 上下文文件 ---']
    for (const fp of contextFiles) {
      try {
        const text = await fs.readFile(fp, 'utf-8')
        parts.push(`\n[文件: ${fp}]\n${text.slice(0, MAX_FILE_CHARS)}`)
      } catch {
        parts.push(`\n[文件: ${fp}]\n(读取失败)`)
      }
    }
    content = parts.join('\n')
  }
  return [{ role: 'user', content }]
}

logger.info('delegate_to_employee tool registered')
