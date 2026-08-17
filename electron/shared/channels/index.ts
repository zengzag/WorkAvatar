import { WORKSPACE_CHANNELS } from './workspace'
import { EMPLOYEE_CHANNELS } from './employee'
import { LLM_CHANNELS } from './llm'
import { TOOL_CHANNELS } from './tool'
import { APP_CHANNELS } from './app'
import { KMS_CHANNELS } from './kms'
import { VOICE_CHANNELS } from './voice'
import { RUNTIME_ENV_CHANNELS } from './runtime-env'
import { MCP_CHANNELS } from './mcp'
import { CALENDAR_CHANNELS } from './calendar'
import { AUTOMATION_CHANNELS } from './automation'
import { PLUGIN_CHANNELS } from './plugin'

export const IPC_CHANNELS = {
  ...WORKSPACE_CHANNELS,
  ...EMPLOYEE_CHANNELS,
  ...LLM_CHANNELS,
  ...TOOL_CHANNELS,
  ...APP_CHANNELS,
  ...KMS_CHANNELS,
  ...VOICE_CHANNELS,
  ...RUNTIME_ENV_CHANNELS,
  ...MCP_CHANNELS,
  ...CALENDAR_CHANNELS,
  ...AUTOMATION_CHANNELS,
  ...PLUGIN_CHANNELS,
} as const

export * from './workspace'
export * from './employee'
export * from './llm'
export * from './tool'
export * from './app'
export * from './kms'
export * from './voice'
export * from './runtime-env'
export * from './mcp'
export * from './calendar'
export * from './automation'
export * from './plugin'
