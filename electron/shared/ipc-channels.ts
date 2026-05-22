export { IPC_CHANNELS } from './channels'
export type {
  WorkspaceInfoParams,
  WorkspaceListFilesParams,
  WorkspaceReadFileParams,
  WorkspaceWriteFileParams,
  WorkspaceCreateFolderParams,
  WorkspaceDeleteItemParams,
  WorkspaceRenameItemParams,
  WorkspaceImportParams,
  WorkspaceOpenInExplorerParams,
} from './channels/workspace'
export type {
  EmployeeListParams,
  EmployeeCreateParams,
  EmployeeUpdateParams,
  ConversationListParams,
  ConversationCreateParams,
  EmployeeProfileAnalyzeParams,
  EmployeeProfileRefineParams,
  EmployeeExportConfigParams,
  EmployeeImportConfigParams,
  EmployeeExportPackageParams,
  EmployeeImportPackageParams,
  EmployeeKBListParams,
  EmployeeKBLinkParams,
  EmployeeKBUnlinkParams,
  EmployeeMemoryListParams,
  EmployeeMemoryCreateParams,
  EmployeeMemoryUpdateParams,
  EmployeeMemorySearchParams,
  EmployeeMemoryExtractParams,
} from './channels/employee'
export type {
  LLMProviderCreateParams,
  LLMProviderUpdateParams,
  LLMTestConnectionParams,
  LLMChatParams,
  EmployeeChatStreamParams,
} from './channels/llm'
export type {
  ToolAssignParams,
  MCPServerCreateParams,
  MCPServerUpdateParams,
} from './channels/tool'
export type {
  SettingsGetParams,
  SettingsSetParams,
  AppShowOpenDialogParams,
  AppShowSaveDialogParams,
} from './channels/app'
export type {
  KBCreateParams,
  KBUpdateParams,
  KBDocParseParams,
  KBProcessDocumentParams,
  KBProcessAllParams,
  KBBuildGlobalParams,
  KBExportFullParams,
  KBExportSummaryParams,
  KBExportDocumentsParams,
  KBImportFullParams,
} from './channels/kb'
export type {
  EmployeeTaskCreateParams,
  EmployeeTaskUpdateParams,
  EmployeeScheduleCreateParams,
  EmployeeScheduleUpdateParams,
} from './channels/employee-task'
export type {
  WorkflowCreateParams,
  WorkflowUpdateParams,
} from './channels/workflow'
