import type { ToolDefinition } from '../tool.types'
import UnifiedInteractionService from '../../unified-interaction.service'

export const askUserTool: ToolDefinition = {
  id: 'ask_user',
  name: 'ask_user',
  title: '询问用户',
  description: '向用户提问并获取回复。支持三种交互类型：1) confirm - 确认对话框，获取用户的是/否选择；2) select - 选项列表，让用户从多个选项中选择一个；3) input - 文本输入，收集用户的文字输入。当需要用户决策、确认操作或获取信息时使用此工具。',
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
  handler: async (args: any) => {
    try {
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

      const response = await interactionService.request(request)

      if (response.cancelled) {
        return { success: false, error: '用户取消了交互', cancelled: true }
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
      return { success: false, error: `询问用户失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}
