import { PROJECT_CHANNELS } from './project'
import { EMPLOYEE_CHANNELS } from './employee'
import { LLM_CHANNELS } from './llm'
import { TOOL_CHANNELS } from './tool'
import { APP_CHANNELS } from './app'
import { KB_CHANNELS } from './kb'
import { TASK_CHANNELS } from './task'
import { EMPLOYEE_TASK_CHANNELS } from './employee-task'

export const IPC_CHANNELS = {
  ...PROJECT_CHANNELS,
  ...EMPLOYEE_CHANNELS,
  ...LLM_CHANNELS,
  ...TOOL_CHANNELS,
  ...APP_CHANNELS,
  ...KB_CHANNELS,
  ...TASK_CHANNELS,
  ...EMPLOYEE_TASK_CHANNELS,
} as const

export * from './project'
export * from './employee'
export * from './llm'
export * from './tool'
export * from './app'
export * from './kb'
export * from './task'
export * from './employee-task'
