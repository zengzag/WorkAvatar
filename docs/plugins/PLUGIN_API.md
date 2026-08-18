# WorkAvatar 插件协议 · API 参考

> 对应实现：宿主 [plugin-host.service.ts](../../electron/main/services/plugin/plugin-host.service.ts)，类型契约 [plugin-sdk/src](../../plugins/plugin-sdk/src/)。

WorkAvatar 采用 **manifest 声明 + 双入口插件包 + 宿主扩展点** 的插件模型（VSCode 扩展的简化版）。
**不存在「内置插件」特权**：所有插件统一为用户来源，走完全相同的加载、启停、删除逻辑。

## 目录

- [1. 插件包结构](#1-插件包结构)
- [2. manifest.json 字段](#2-manifestjson-字段)
- [3. 生命周期（重启生效，无热插拔）](#3-生命周期重启生效无热插拔)
- [4. 主进程入口](#4-主进程入口)
- [5. ctx（PluginContext）能力](#5-ctxplugincontext能力)
- [6. 权限与 services 注入表](#6-权限与-services-注入表)
- [7. IPC 约定](#7-ipc-约定)
- [8. 存储与数据迁移](#8-存储与数据迁移)
- [9. 贡献点](#9-贡献点)
- [10. 渲染端入口](#10-渲染端入口)
- [11. 渲染端集成（__WA_HOST__ / plugin:// 协议）](#11-渲染端集成)

---

## 1. 插件包结构

```
<plugin-root>/
├── manifest.json          # 唯一信任入口
├── dist/
│   ├── main/index.cjs     # 主进程入口：export { migrations?, activate, deactivate? }
│   └── renderer/index.js  # 渲染端入口：export default { routes, navIcon?, init?, dispose? }
├── resources/             # 自包含重资源（onnx 模型等），只读
└── locale/                # zh-CN.json / en-US.json
```

**唯一安装来源**（`userData/plugins/<id>/`）：无论插件来自 dev 自动安装还是用户 zip 导入，落地后都是用户插件，可启停、可删除。运行期数据独立存于 `userData/plugin-data/<id>/`，与安装目录解耦，禁用/重装不丢数据。

## 2. manifest.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | `/^[a-z][a-z0-9-]{1,63}$/`；保留字：`settings` `tasks` `employees` `list` `invoke` `event` |
| `name` / `version` | ✓ | 展示名 / semver |
| `engine` | ✓ | 宿主协议 semver range（如 `>=0.1.0 <1.0.0`），不满足则禁用并提示 |
| `main` | ✓ | 主进程入口（cjs），相对根目录 |
| `renderer` | | 渲染端入口（ESM）；纯后台插件可省略 |
| `locale` | | locale 目录名，默认 `locale` |
| `ipc` | | 允许注册的通道名列表（`'*'` 全开）；宿主强制 `plugin:<id>:` 前缀 |
| `permissions` | | 权限声明，决定 `ctx.services` 注入项（见 §6） |
| `nav` | | 导航项：`label`（文案或 i18n key）、`icon`（16×16 SVG 字符串）、`order`（默认 100）、`detachable` |

参考真实示例：[notes/manifest.json](../../plugins/notes/manifest.json)、[calendar/manifest.json](../../plugins/calendar/manifest.json)、[voice/manifest.json](../../plugins/voice/manifest.json)。

## 3. 生命周期（重启生效，无热插拔）

```
宿主启动
  → 扫描 userData/plugins/，解析每个 manifest
  → schema 校验 + engine 校验 + id 保留字校验
  → 读 settings 表 plugins.config 启用状态，过滤
  → 逐插件执行未应用的 migrations（原子事务 + plugin_migrations 版本记录）
  → 逐插件 activate(ctx)（try/catch 隔离，单插件失败不阻塞宿主，标记 error）
  → 贡献点落库（agent 工具 / MCP 工具 / 文件关联 / 快捷键 / 导航）
  → 之后才初始化 EmployeeAgentService 等内核服务（保证插件工具就位）
渲染端启动
  → IPC 拉取已启用插件清单
  → import('plugin://<id>/index.js')（宿主 privileged scheme + protocol.handle）
  → init(host) → 注册路由 / 导航 / locale → createHashRouter
退出 / 禁用
  → shutdown()：注销插件全局快捷键、清定时器、关插件窗口、逐个 deactivate()
```

dev 阶段：宿主额外扫描项目根 `plugins/`（**优先于**用户目录、不拷贝不覆盖），方便改源码即生效；release 仅加载用户目录。

## 4. 主进程入口

`dist/main/index.cjs`：

```ts
export const migrations?: PluginMigration[]    // 可选，见 §8
export function activate(ctx: PluginContext): void | Promise<void>
export function deactivate?(): void | Promise<void>   // 释放定时器/窗口/DB 连接
```

## 5. ctx（PluginContext）能力

```ts
interface PluginContext {
  manifest: PluginManifest
  hostVersion: string                 // 宿主应用版本
  paths: { root; data; resources }    // 安装根 / userData/plugin-data/<id> / resources
  ipc: PluginIpc                      // handle / broadcast
  storage: PluginStorage              // openSqlite / KV
  services: PluginServices            // 按 permissions 注入，见 §6
  contributions: PluginContributionsApi // 见 §9
}
```

- `paths.root`：只读安装目录；`paths.data`：可写数据目录；`paths.resources`：只读资源目录。
- `ipc.handle(channel, handler)`：通道强制 `plugin:<id>:` 前缀，且须在 `manifest.ipc` 白名单，越权注册抛错。
- `ipc.broadcast(event, payload)`：推送到本插件所有渲染端（主窗口 + tab 独立窗口 + 插件自建窗口）。
- `storage.openSqlite(name?)`：独立分库（WAL）；`storage.get/set/delete/keys`：插件作用域 KV（存 `plugin_kv` 表，不写内核 settings）。

## 6. 权限与 services 注入表

| 权限 | 注入服务 | 用途 |
|---|---|---|
| （无需声明） | `logger` / `host` / `ipc` / `storage` / `contributions` | 基础能力（`host.getDataDir()` 等） |
| `llm` | `services.llm.chat()/chatStream()` | 受控 LLM 调用（走宿主 PiAIProvider，自动记日志/用量；流式支持回调与 AbortSignal） |
| `agent` | `services.agent.runTask()/listEmployees()` | 委派数字员工 |
| `conversations` | `services.conversations` | 内核对话只读查询 |
| `notifications` | `services.notification.notify()` | 通知（主窗口激活→推 `notify` 插件事件，失焦→系统通知，点击→`notify-click`） |
| `scheduler` | `services.scheduler.every()/cron()/cancel()` | 定时任务（宿主统一回收） |
| `globalShortcuts` | `contributions.registerGlobalShortcuts()` | 全局快捷键 |
| `windows` | `services.windows.create()` | 插件窗口（透明/置顶/无任务栏/无阴影/坐标等；创建后自动纳入广播目标） |
| `nativeModules` | `services.native.borrow()/modulePath()` | 租借宿主原生模块（ABI 一致；**插件禁止自带 .node**） |
| `legacyMigration` | migration ctx 的 `legacy` / `legacy.kms` | 只读内核主库（`kms` 额外只读 KMS 向量库；仅数据迁出场景） |

未声明权限的服务为 `undefined`，访问即报错便于发现。

## 7. IPC 约定

- preload 只暴露通用桥（不随插件膨胀）：
  ```ts
  window.electronAPI.plugin.invoke(pluginId, channel, payload)
  window.electronAPI.plugin.onEvent(pluginId, cb)   // cb({ event, payload })
  window.electronAPI.plugin.setEnabled(id, bool)    // 重启生效
  window.electronAPI.plugin.remove(id)
  window.electronAPI.plugin.import(overwrite?)      // 导入 zip 包（主进程弹文件选择）
  window.electronAPI.plugin.openPluginsDir()
  ```
- 主进程通道一律 `plugin:<id>:<channel>`，宿主拒绝插件覆盖内核通道。
- 主进程推送：`ctx.ipc.broadcast(event, payload)` → 该插件所有渲染端。
- 插件 agent 工具 handler 上下文为 `PluginToolContext`：`{ onProgress?, employeeId? }`。

## 8. 存储与数据迁移

- 插件一律 `ctx.storage.openSqlite()` 获得独立分库（WAL），**禁止直连内核主库**。
- 原生模块只能 `borrow('better-sqlite3')` 等租借，禁止自带 `.node`（启动扫描与导入校验均拒绝）。
- 迁出内核旧数据：`migrations: [{ version, description?, run(ctx) }]`，宿主保证：
  - 每个迁移在插件库事务内执行，失败回滚并禁用该插件（不阻塞宿主与其他插件）；
  - 成功后写 `plugin_migrations(version, applied_at)`，幂等；
  - `ctx.legacy` 只读内核主库（`get`/`all`/`listTables`/`getSetting`，仅 SELECT），`ctx.legacy.kms` 额外只读 KMS 向量库。
- 内核为迁出保留的旧表不会立即删除，留有兜底窗口期（见 [legacy](../../electron/main/services/plugin/legacy/index.ts) 标注清单）。

## 9. 贡献点

`ctx.contributions`：

```ts
registerAgentTools(tools: PluginToolDefinition[])        // 进宿主 ToolRegistry，参与员工三态配置
registerMcpTools(tools: PluginToolDefinition[])          // 经内置 MCP 对外暴露
registerFileAssociations(assocs)                          // 系统"打开方式"→ 路由到插件渲染端
registerGlobalShortcuts(shortcuts)                        // 需 globalShortcuts 权限
```

`PluginToolDefinition` 与宿主内置 `ToolDefinition` 结构兼容：`id/name/title/description/summary/parameters/handler(second)`，`handler(args, { onProgress, employeeId })`；可选 `permission/timeoutMs/noRetry/onDemand/metadata`。注册时 id 不得与已注册工具冲突（冲突整组拒绝）。插件工具 id 沿用原名，老员工三态配置无需迁移。

## 10. 渲染端入口

`dist/renderer/index.js`，ESM `default export`：

```ts
export default {
  routes: [{ path: '', component: Page }],   // 挂载到 /plugin/<id>/ 命名空间
  navIcon?: (props: { active }) => JSX,      // 动态导航图标
  init?(host: PluginRendererHost): void,     // 路由挂载前调用一次
  dispose?(): void,                          // 卸载时清理订阅
}
```

`PluginRendererHost` 提供 `bridge.invoke/onEvent`、`i18n.t`（插件 locale 已由宿主代注册，namespace = 插件 id）与 `hostCapabilities`（`subscribeExternalFiles` 订阅外部文件、`registerCloseGuard` 注册"未保存"守卫）。

## 11. 渲染端集成（__WA_HOST__ / plugin:// 协议）

- **共享库单例**：宿主注入 `globalThis.__WA_HOST__ = { React, ReactDOM, jsxRuntime, antd, icons, i18n, reactI18n }`。插件构建时把 `react/antd` 等 external 并 shim 到 `__WA_HOST__`（见构建脚本），防双 React 实例；插件包内若检出自带 react 则拒绝加载。
- **plugin:// 协议**：`plugin://<id>/<相对路径>` 经 `protocol.handle` 映射到插件目录（主动校验越权：非法路径 403，未启用插件 404）。仅 enabled 插件可访问。
- **路由**：`/plugin/<id>/*` 挂载插件 routes；独立窗口复用同一组路径；导航项合并进 `nav.store`（label 为插件 locale key，icon 为 SVG 字符串，支持排序与 tab 分离）。