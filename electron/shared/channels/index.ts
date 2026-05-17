import { WORKSPACE_CHANNELS } from './workspace'
import { EMPLOYEE_CHANNELS } from './employee'
import { LLM_CHANNELS } from './llm'
import { TOOL_CHANNELS } from './tool'
import { APP_CHANNELS } from './app'
import { KB_CHANNELS } from './kb'
import { TASK_CHANNELS } from './task'
import { EMPLOYEE_TASK_CHANNELS } from './employee-task'
import { WORKFLOW_CHANNELS } from './workflow'

export const IPC_CHANNELS = {
  ...WORKSPACE_CHANNELS,
  ...EMPLOYEE_CHANNELS,
  ...LLM_CHANNELS,
  ...TOOL_CHANNELS,
  ...APP_CHANNELS,
  ...KB_CHANNELS,
  ...TASK_CHANNELS,
  ...EMPLOYEE_TASK_CHANNELS,
  ...WORKFLOW_CHANNELS,
} as const

export * from './workspace'
export * from './employee'
export * from './llm'
export * from './tool'
export * from './app'
export * from './kb'
export * from './task'
export * from './employee-task'
export * from './workflow'
