import { WORKSPACE_CHANNELS } from './workspace'
import { EMPLOYEE_CHANNELS } from './employee'
import { LLM_CHANNELS } from './llm'
import { TOOL_CHANNELS } from './tool'
import { APP_CHANNELS } from './app'
import { KMS_CHANNELS } from './kms'
import { RUNTIME_ENV_CHANNELS } from './runtime-env'
import { MCP_CHANNELS } from './mcp'
import { PLUGIN_CHANNELS } from './plugin'
import { NOTIFY_CHANNELS } from './notification'

export const IPC_CHANNELS = {
  ...WORKSPACE_CHANNELS,
  ...EMPLOYEE_CHANNELS,
  ...LLM_CHANNELS,
  ...TOOL_CHANNELS,
  ...APP_CHANNELS,
  ...KMS_CHANNELS,
  ...RUNTIME_ENV_CHANNELS,
  ...MCP_CHANNELS,
  ...PLUGIN_CHANNELS,
  ...NOTIFY_CHANNELS,
} as const

export * from './workspace'
export * from './employee'
export * from './llm'
export * from './tool'
export * from './app'
export * from './kms'
export * from './runtime-env'
export * from './mcp'
export * from './plugin'
export * from './notification'
