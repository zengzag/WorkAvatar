import type { ToolDefinition } from '../tool.types'
import { safeCalculate } from './utils'

export const calculatorTool: ToolDefinition = {
  id: 'calculator',
  name: 'calculator',
  title: '计算器',
  description: '执行数学计算，支持加减乘除、百分比、幂运算等',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: '数学表达式，如 "100 * 1.13 + 50"'
      }
    },
    required: ['expression']
  },
  handler: (args: any) => {
    try {
      const result = safeCalculate(args.expression)
      return { success: true, result: String(result) }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  },
  source: 'builtin'
}