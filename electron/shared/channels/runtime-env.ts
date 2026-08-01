/**
 * 运行时环境检测相关 IPC 通道。
 *
 * 用于检测数字员工脚本所依赖的运行时（uv / python / node / pip）是否已安装，
 * 并提供一键安装入口，避免因缺失依赖导致部分脚本无法运行。
 */
export const RUNTIME_ENV_CHANNELS = {
  // 检测所有受支持运行时的安装状态
  RUNTIME_ENV_LIST: 'runtime-env:list',
  // 一键安装指定运行时（如 uv / python / node）
  RUNTIME_ENV_INSTALL: 'runtime-env:install',
  // 取消正在进行的安装
  RUNTIME_ENV_CANCEL_INSTALL: 'runtime-env:cancel-install',
  // 安装进度推送（主进程 → 渲染进程的事件通道）
  RUNTIME_ENV_PROGRESS: 'runtime-env:progress',
} as const

export type RuntimeEnvToolId = 'uv' | 'python' | 'node' | 'pip'

export interface RuntimeEnvTool {
  id: RuntimeEnvToolId
  /** 展示名称 */
  name: string
  /** 用途说明 */
  description: string
  /** 是否已安装 */
  installed: boolean
  /** 版本号（已安装时） */
  version?: string
  /** 可执行文件绝对路径（已安装时） */
  path?: string
  /** 是否支持一键安装 */
  installable: boolean
  /** 不支持一键安装时给用户的提示文案 */
  installHint?: string
  /** 当前是否正在安装中 */
  installing?: boolean
}

export interface RuntimeEnvInstallParams {
  toolId: RuntimeEnvToolId
}

export interface RuntimeEnvInstallProgress {
  toolId: RuntimeEnvToolId
  /** 进度阶段 */
  phase: 'pending' | 'downloading' | 'installing' | 'verifying' | 'done' | 'error' | 'cancelled'
  /** 阶段描述文案 */
  message: string
  /** 0-100 的进度百分比（无法量化时省略） */
  progress?: number
}