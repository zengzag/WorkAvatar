import { dateTimeTool } from './date-time.tool'
import { shellExecTool } from './shell-exec.tool'
import { residentFileTools } from './fs-tools'
import { fileListTool } from './file-list.tool'
import { grepTool } from './grep.tool'
import { applyPatchTool } from './apply-patch.tool'
import { envProbeTool } from './env-probe.tool'
import { shellOutputTool, shellKillTool } from './background-shell.tools'
import { webSearchTool } from './web-search.tool'
import { webFetchTool } from './web-fetch.tool'
import { askUserTool } from './ask-user.tool'
import { ocrImageTool } from './ocr.tool'
import { readImageTool } from './read-image.tool'
import { sendMessageTool, readMessagesTool } from './collab-messages.tool'
import { listEmployeesTool, listProvidersTool } from './collaboration.tool'
import type { ToolDefinition } from './types'

/** 编程场景补充工具（不单设分类：file_list/grep/apply_patch 归入「文件操作」，env_probe 归入「脚本执行」） */
export const programmingTools: ToolDefinition[] = [
  fileListTool,
  grepTool,
  applyPatchTool,
  envProbeTool,
]

/** 后台终端管理工具：配合 shell_exec(run_in_background=true) 读取输出与终止任务 */
export const backgroundShellTools: ToolDefinition[] = [
  shellOutputTool,
  shellKillTool,
]

// 委托类工具（delegateTool / launchAgentsTool / awaitAgentsTool）不在此列：
// 它们由员工「委托能力设置」（employees.delegation_json）驱动注册，不再是员工可配置工具
export const allBuiltinTools: ToolDefinition[] = [
  dateTimeTool,
  shellExecTool,
  ...backgroundShellTools,
  ...residentFileTools,
  ...programmingTools,
  webSearchTool,
  webFetchTool,
  askUserTool,
  ocrImageTool,
  readImageTool,
  sendMessageTool,
  readMessagesTool,
  listEmployeesTool,
  listProvidersTool,
]

export * from './javascript-exec.tool'

export { shellExecTool } from './shell-exec.tool'
export { createKMSTools, type SearchScopeRef } from './kms-search.tool'
export { createKMSCollectionTools } from './kms-collection-tools'
export { createMemorySearchTool } from './memory-search.tool'
export { createListAvailableToolsTool, createInvokeToolTool } from './meta-tools'
export { runSkillScriptTool } from './run-skill-script.tool'
export { delegateTool } from './delegate.tool'
export { followupTool } from './followup.tool'
export { launchAgentsTool, awaitAgentsTool } from './launch-agents.tool'
export { sendMessageTool, readMessagesTool } from './collab-messages.tool'
export {
  listSubagentsTool,
  listSubagentProfilesTool,
  getSubagentStatusTool,
  cancelSubagentTool,
  readRunNotificationsTool,
  taskItemCreateTool,
  taskItemUpdateTool,
  taskItemListTool,
  submitStructuredResultTool,
} from './subagent-tools'
