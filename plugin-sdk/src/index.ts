export type {
  PluginManifest,
  PluginManifestEmployee,
  PluginNavContribution,
  PluginCapability,
  PluginDataEntity,
  PluginDataAccess,
  PluginExecuteKind,
  PluginKmsQueryType,
  PluginSystemFeature,
  PluginViewPoint,
} from './manifest'
export type {
  PluginToolContext,
  PluginToolDefinition,
  PluginToolResult,
  PluginToolMiddleware,
} from './tool'
export type {
  PluginDatabase,
  PluginSqlStatement,
  PluginStorage,
  PluginLegacyDatabase,
  PluginMigration,
  PluginMigrationContext,
} from './storage'
export type {
  PluginLogger,
  PluginNotificationPayload,
  PluginNotificationService,
  PluginDataService,
  PluginDataQueryParams,
  PluginDataOp,
  PluginKmsService,
  PluginSharedStore,
  PluginBusService,
  PluginExecuteService,
  PluginExecuteRequest,
  PluginExecuteCallbacks,
  PluginEventService,
  PluginSchedulerService,
  PluginWindowOptions,
  PluginWindowHandle,
  PluginWindowService,
  PluginNativeService,
  PluginHostPathsService,
  PluginServices,
} from './services'
export type {
  PluginContributionsApi,
  PluginFileAssociation,
  PluginGlobalShortcut,
  PluginMessageAction,
  PluginMessageActionContext,
  PluginMessageActionResult,
  PluginViewContribution,
  PluginCommand,
} from './contributions'
export type {
  PluginContext,
  PluginIpc,
  PluginPaths,
  PluginMainModule,
} from './context'
export type {
  PluginRouteDefinition,
  PluginViewDefinition,
  PluginBridge,
  PluginHostCapabilities,
  PluginRendererHost,
  PluginRendererEntry,
} from './renderer'
// 宿主原生依赖白名单（单源真相）：定义插件可经 services.native.borrow 租借的原生模块。
// 宿主与构建脚本共同读取此常量做出发（build-plugin.mjs 校验 nativeDependencies 合法性）。
import HOST_NATIVE_DEPENDENCIES from '../host-native-dependencies.json'
export { HOST_NATIVE_DEPENDENCIES }
export type PluginHostNativeDependencies = typeof HOST_NATIVE_DEPENDENCIES
