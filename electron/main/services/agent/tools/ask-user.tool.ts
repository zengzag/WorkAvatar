import type { ToolDefinition, ToolHandlerContext } from './types'
import UnifiedInteractionService, { INTERACTION_TIMEOUT_MS } from '../../unified-interaction.service'

/** 中止错误信息（等待期间 signal abort 抛出，catch 据此识别为取消而非失败） */
const ABORT_MESSAGE = '用户已停止生成'

/**
 * 与中止信号竞速：等待期间 signal abort 立即失败，
 * 不悬挂在交互等待（最长 305s）上，后到的交互响应被丢弃（由服务自身超时兜底清理）。
 */
function waitWithAbort(request: Promise<any>, signal?: AbortSignal): Promise<any> {
  if (!signal) return request
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error(ABORT_MESSAGE))
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
    request.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

export const askUserTool: ToolDefinition = {
  id: 'ask_user',
  name: 'ask_user',
  title: '询问用户',
  description: '向用户发起交互：confirm(确认)、select(选择)、input(文本输入)。',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['confirm', 'select', 'input'],
        description: '交互类型：confirm(确认)、select(选择)、input(输入)'
      },
      message: {
        type: 'string',
        description: '向用户展示的消息内容'
      },
      title: {
        type: 'string',
        description: '对话框标题（可选）'
      },
      options: {
        type: 'array',
        description: '选项列表（仅select类型使用），每项包含label(显示文本)、value(值)、description(可选描述)、danger(可选，是否为危险选项)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '选项显示文本' },
            value: { type: 'string', description: '选项值' },
            description: { type: 'string', description: '选项描述（可选）' },
            danger: { type: 'boolean', description: '是否为危险选项（可选）' }
          },
          required: ['label', 'value']
        }
      },
      default_value: {
        type: 'string',
        description: '默认值（可选）'
      },
      placeholder: {
        type: 'string',
        description: '输入框占位符（仅input类型使用，可选）'
      },
    },
    required: ['type', 'message']
  },
  handler: async (args: any, context?: ToolHandlerContext) => {
    const signal = context?.signal
    try {
      // signal 已中止：立即失败，不发起交互
      if (signal?.aborted) {
        return { success: false, error: '用户已停止生成，交互已取消', cancelled: true }
      }
      const interactionService = UnifiedInteractionService.getInstance()
      const type = String(args.type || 'confirm')
      const message = String(args.message || '')
      const title = String(args.title || '')

      if (!message) {
        return { success: false, error: '消息内容不能为空' }
      }

      const request: any = {
        type,
        title: title || (type === 'confirm' ? '确认' : type === 'select' ? '请选择' : '请输入'),
        message,
        source: 'ask_user',
      }

      if (type === 'select') {
        if (!args.options || !Array.isArray(args.options) || args.options.length === 0) {
          return { success: false, error: 'select类型必须提供至少一个选项' }
        }
        request.options = args.options.map((opt: any) => ({
          label: String(opt.label || opt.value || ''),
          value: String(opt.value || opt.label || ''),
          description: opt.description ? String(opt.description) : undefined,
          danger: opt.danger === true,
        }))
      }

      if (type === 'input') {
        request.placeholder = args.placeholder ? String(args.placeholder) : undefined
        request.defaultValue = args.default_value ? String(args.default_value) : undefined
      }

      if (type === 'confirm') {
        request.defaultValue = args.default_value || 'no'
      }

      const response = await waitWithAbort(interactionService.request(request), signal)

      if (response.cancelled) {
        const reason = response.timedOut
          ? '用户在5分钟内未响应，可能不在电脑旁'
          : '用户取消了交互'
        return { success: false, error: reason, cancelled: true }
      }

      switch (type) {
        case 'confirm':
          return {
            success: true,
            confirmed: response.confirmed === true,
            output: response.confirmed ? '用户确认了操作' : '用户拒绝了操作'
          }
        case 'select':
          return {
            success: true,
            selectedValue: response.selectedValue,
            output: `用户选择了: ${response.selectedValue}`
          }
        case 'input':
          return {
            success: true,
            inputValue: response.inputValue,
            output: response.inputValue || '(空输入)'
          }
        default:
          return { success: false, error: `不支持的交互类型: ${type}` }
      }
    } catch (error: any) {
      const msg = error?.message || String(error)
      if (msg === ABORT_MESSAGE) {
        return { success: false, error: '用户已停止生成，交互已取消', cancelled: true }
      }
      return { success: false, error: `询问用户失败: ${msg}` }
    }
  },
  source: 'builtin',
  noRetry: true,
  timeoutMs: INTERACTION_TIMEOUT_MS + 5000,
}
