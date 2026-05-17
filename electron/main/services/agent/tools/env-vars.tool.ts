import type { ToolDefinition } from './types'

export const envVarsTool: ToolDefinition = {
  id: 'env_vars',
  name: 'env_vars',
  title: '环境变量',
  description: '读取允许列表内的系统环境变量。',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '要读取的环境变量名称列表'
      }
    },
    required: ['names']
  },
  handler: (args: any) => {
    try {
      const allowedPrefixes = ['PATH', 'HOME', 'USER', 'COMPUTERNAME', 'OS', 'TEMP', 'TMP', 'NODE', 'npm']
      const names = (args.names || []).filter((n: string) => {
        const upper = n.toUpperCase()
        return allowedPrefixes.some(p => upper.startsWith(p)) || upper === 'PLATFORM'
      })

      const result: Record<string, string | undefined> = {}
      for (const name of names) {
        result[name] = process.env[name]
      }

      return { success: true, output: JSON.stringify(result, null, 2) }
    } catch (error: any) {
      return { success: false, error: `读取环境变量失败: ${error.message || error}` }
    }
  },
  source: 'builtin'
}