# WorkAvatar 插件协议 · API 参考

> 类型契约见 [plugin-sdk/src](./src/)，协议规范见 [PROTOCOL.md](./PROTOCOL.md)，能力矩阵见 [CAPABILITY\_MATRIX.md](./CAPABILITY_MATRIX.md)。

WorkAvatar 采用 **manifest 声明 + 双入口插件包 + 宿主扩展点** 的插件模型。
插件通过 **capabilities（能力域授权）** 声明可访问的能力，并可使用通用数据访问、统一执行入口、事件总线、UI 注入四类放权能力。

## 目录

- [1. 插件包结构](#1-插件包结构)

- [2. manifest.json 字段](#2-manifestjson-字段)

- [3. 生命周期](#3-生命周期)

- [4. 主进程入口](#4-主进程入口)

- [5. ctx（PluginContext）能力](#5-ctxplugincontext能力)

- [6. 数据访问层（services.data）](#6-数据访问层servicesdata)

- [7. 宿主能力层（services.execute）](#7-宿主能力层servicesexecute)

- [8. 系统集成层（services.events）](#8-系统集成层servicesevents)

- [9. 系统能力（services.system）](#9-系统能力servicessystem)

- [10. 贡献点（contributions）](#10-贡献点contributions)

- [11. 渲染端入口](#11-渲染端入口)

- [12. 渲染端集成（__WA\_HOST__](#12-渲染端集成) [/ plugin:// 协议）](#12-渲染端集成)

***

## 1. 插件包结构

```
<plugin-root>/
├── manifest.json          # 唯一信任入口
├── dist/
│   ├── main/index.cjs     # 主进程入口：export { migrations?, activate, deactivate? }
│   └── renderer/index.js  # 渲染端入口：export default { routes, views?, navIcon?, init?, dispose? }
├── resources/             # 自包含重资源（onnx 模型等），只读
└── locale/                # zh-CN.json / en-US.json
```

插件安装到 `userData/plugins/<id>/`，可启停、可删除、可覆盖升级。运行期数据独立存于 `userData/plugin-data/<id>/`，与安装目录解耦，禁用/重装不丢数据。

## 2. manifest.json 字段

| 字段                 | 必填     | 说明                                                                                    |
| ------------------ | ------ | ------------------------------------------------------------------------------------- |
| `id`               | ✓      | `/^[a-z][a-z0-9-]{1,63}$/`；保留字：`settings` `tasks` `employees` `list` `invoke` `event` |
| `name` / `version` | ✓      | 展示名 / semver                                                                          |
| `engine`           | ✓      | 宿主协议 semver range（当前为 `>=0.2.0`），不满足则禁用并提示                                            |
| `main`             | ✓      | 主进程入口（cjs），相对根目录                                                                      |
| `renderer`         | <br /> | 渲染端入口（ESM）；纯后台插件可省略                                                                   |
| `locale`           | <br /> | locale 目录名，默认 `locale`                                                                |
| `ipc`              | <br /> | 允许注册的通道名列表（`'*'` 全开）；宿主强制 `plugin:<id>:` 前缀                                           |
| `capabilities`     | <br /> | 能力域授权声明（见 §5）                                                                         |
| `permissions`      | <br /> | 迁移专用权限（仅保留 `legacyMigration`）                                                         |
| `nav`              | <br /> | 导航项：`label`、`icon`、`order`、`detachable`                                               |
| `dependencies`     | <br /> | 插件依赖（pluginId → semver range），缺失/不满足/未启用则标记 invalid，按拓扑激活                             |

参考真实示例：开发包 `plugin-template/` 模板工程的 `manifest.json`（最小可构建示例）。

## 3. 生命周期

```
宿主启动
  → 扫描 userData/plugins/，解析每个 manifest
  → schema 校验 + engine 校验 + capabilities 校验 + id 保留字校验
  → 读启用状态，过滤
  → 逐插件执行未应用的 migrations（原子事务 + plugin_migrations 版本记录）
  → 逐插件 activate(ctx)（单插件失败不阻塞宿主，标记 error）
  → 贡献点落库（agent 工具 / MCP 工具 / 文件关联 / 快捷键 / 视图 / 命令 / 导航）
渲染端启动
  → 拉取已启用插件清单
  → import('plugin://<id>/index.js')
  → init(host) → 注册路由 / 视图 / 导航 / locale
退出 / 禁用
  → deactivate()（插件释放资源：关定时器、关窗口、关 DB 连接）
```

插件变更（启停 / 导入 / 删除 / 升级）**即时生效，无需重启**（宿主增量激活 + 渲染端增量加载，不打断正在进行的智能体生成）。

## 4. 主进程入口

`dist/main/index.cjs`：

```ts
export const migrations?: PluginMigration[]    // 可选，见 §10
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
  services: PluginServices            // 按 capabilities 注入，见 §6-9
  contributions: PluginContributionsApi // 见 §10
}
```

- `paths.root`：只读安装目录；`paths.data`：可写数据目录；`paths.resources`：只读资源目录。

- `ipc.handle(channel, handler)`：通道强制 `plugin:<id>:` 前缀，且须在 `manifest.ipc` 白名单，越权注册抛错。

- `ipc.broadcast(event, payload)`：推送到本插件所有渲染端（主窗口 + tab 独立窗口 + 插件自建窗口）。

- `storage.openSqlite(name?)`：独立分库（WAL）；`storage.get/set/delete/keys`：插件作用域 KV（存 `plugin_kv` 表，不写内核 settings）。

## 6. 数据访问层（services.data）

需 `capabilities.data` 授权。

```ts
services.data.query<T>(entity, { filter?, sort?, limit?, offset? }): Promise<T[]>
services.data.mutate<T>(entity, op, payload): Promise<T>
```

**实体**：`conversations` / `employees` / `llmProviders` / `memories` / `settings`（只读）/ `messages`（只读，`filter.conversationId` 读某对话全部消息）。
**操作**：`create` / `update` / `delete`。

**安全**：

- 实体必须在 `capabilities.data.entities` 白名单内，否则拒绝。

- `access=read` 的实体调用 `mutate` 拒绝。

- `llmProviders` 返回前剥离 `api_key`。

**示例**：

```ts
// 查询某员工最近对话
const convs = await ctx.services.data!.query('conversations', {
  filter: { employeeIds: ['emp-1'] },
  limit: 10,
})

// 创建对话
await ctx.services.data!.mutate('conversations', 'create', {
  employeeId: 'emp-1',
  title: '新任务',
})

// 查询员工记忆
const memories = await ctx.services.data!.query('memories', {
  filter: { employeeId: 'emp-1', query: '偏好' },
})
```

## 7. 宿主能力层（services.execute）

需 `capabilities.execute` 授权。

```ts
services.execute.execute<T>(request, callbacks?, signal?): Promise<T>
```

**kind**：`agent-task` / `agent-chat` / `llm-chat` / `llm-stream`。

**示例**：

```ts
// 委派数字员工执行任务
const result = await ctx.services.execute!.execute({
  kind: 'agent-task',
  employeeId: 'emp-1',
  prompt: '帮我整理本周会议纪要',
}, {
  onChunk: (text) => console.log(text),
})

// 底层对话流式执行（返回会话 id；可注入领域专用系统提示词）
const { conversationId } = await ctx.services.execute!.execute({
  kind: 'agent-chat',
  employeeId: 'emp-1',
  providerId: 'prov-1',
  messages: [{ role: 'user', content: '为博客建用户表' }],
  system: '你是一个数据建模助手，只能使用数据模型工具',
  minimalMode: false, // false 保留员工全部工具（默认 true 会清空工具）
}, {
  onChunk: (chunk) => console.log(chunk),
  onToolCall: (tc) => console.log('tool', tc.name, tc.arguments),
})
// 会话消息可用 services.data.query('messages', { filter: { conversationId } }) 读取

// 流式调用 LLM
const text = await ctx.services.execute!.execute({
  kind: 'llm-stream',
  prompt: '写一段欢迎词',
  system: '你是文案助手',
}, {
  onChunk: (chunk) => console.log(chunk),
})
```

## 7.5 资料库查询层（services.kms）

需 `capabilities.kms` 授权，只读查询资料库，不触发索引/晋升副作用。

```ts
services.kms.search(query, { limit?, collectionIds?, fileExtensions? })   // 混合检索，返回 SearchResult[]
services.kms.listCollections()                                            // 列合集 [{id,name,description,file_count}]
services.kms.getContent(fileId, { paragraphId?, maxChars? })              // 读文件文本
```

## 7.6 插件协作层（services.shared / services.bus）

需 `capabilities.collaboration` 授权，实现跨插件共享数据 + 跨插件 RPC。

```ts
services.shared.set/get/getFrom/delete/keys/keysAll   // 跨插件共享 KV（写限本插件命名空间，读全部需 shared.read）
services.bus.respond('method', handler)               // 注册可被调用的方法，返回取消注册函数
await services.bus.call('目标插件id:方法名', payload)   // 调用其他插件方法（需 call 白名单）
```

## 8. 系统集成层（services.events）

需 `capabilities.events` 授权。

```ts
services.events.subscribe(event, callback): () => void   // 订阅，返回取消订阅函数
services.events.publish(event, payload): void            // 发布，强制 plugin:<id>: 前缀
```

**宿主事件**：`conversation:created`（{id,employeeId,title,parentConversationId}）、`conversation:updated`（{id,data}）、`conversation:deleted`、`employee:created` / `employee:updated` / `employee:deleted`（{id}）、`model:renamed`、`agent:event`（数字员工运行时事件桥，见下）。
**插件事件**：`plugin:<id>:<event>`，可被其他插件订阅（需在 subscribe 白名单声明）。

**`agent:event`（数字员工运行时事件）**：订阅后收到数字员工执行生命周期事件，payload 为 `{ employeeId, conversationId, event, data }`，其中 `event` 是 agent 事件名：
`run:start / run:end / run:error`、`iteration:start / iteration:end`、`tool:call:start / tool:call:end`、`state:change`、`plan:generated`、`memory:compressed`；`data` 为原始事件数据透传。适用于观测、审计、数据加工。无订阅者时宿主零成本转发。

**示例**：

```ts
// 订阅对话删除事件
const unsub = ctx.services.events!.subscribe('conversation:deleted', (id) => {
  console.log('对话被删除:', id)
})

// 订阅数字员工运行时事件（观测/审计）
ctx.services.events!.subscribe('agent:event', (p) => {
  console.log(p.employeeId, p.conversationId, p.event, p.data)
})

// 发布自己的事件
ctx.services.events!.publish('data-changed', { ts: Date.now() })
```

## 9. 系统能力（services.system）

需 `capabilities.system.features` 授权。

| 特性                | 服务                                      | 说明                                | <br /> |
| ----------------- | --------------------------------------- | --------------------------------- | :----- |
| `notification`    | `services.notification.notify(payload)` | 系统通知（主窗口激活→推渲染端，失焦→系统通知）          | <br /> |
| `scheduler`       | `services.scheduler.every/cron/cancel`  | 定时任务（宿主统一回收）                      | <br /> |
| `windows`         | `services.windows.create(options)`      | 插件窗口（透明/置顶/无任务栏等）                 | <br /> |
| `native`          | `services.native.borrow/modulePath`     | 租借宿主原生模块（ABI 一致；**插件禁止自带 .node**） | <br /> |
| `globalShortcuts` | `contributions.registerGlobalShortcuts` | 全局快捷键                             | <br /> |
| `agentMiddleware` | `contributions.registerAgentMiddleware` | 注册数字员工工具调用中间件（执行路径拦截）             | <br /> |

## 10. 贡献点（contributions）

```ts
registerAgentTools(tools: PluginToolDefinition[])        // 进宿主 ToolRegistry，参与员工三态配置
registerMcpTools(tools: PluginToolDefinition[])          // 经内置 MCP 对外暴露
registerFileAssociations(assocs)                          // 系统"打开方式"→ 路由到插件渲染端
registerGlobalShortcuts(shortcuts)                        // 需 system.features 含 globalShortcuts
registerAgentMiddleware(middlewares: PluginToolMiddleware[]) // 数字员工工具调用中间件（需 system.features 含 agentMiddleware）
registerMessageActions(actions)                           // 对话消息快捷操作
registerView(view)                                        // 声明 UI 注入意图（需 capabilities.ui.views 授权）
registerCommand(command)                                  // 注册命令（可被斜杠菜单/宿主调用）
```

`PluginToolDefinition` 结构：`id/name/title/description/summary/parameters/handler(second)`，`handler(args, { onProgress, employeeId })`；可选 `permission/timeoutMs/noRetry/onDemand/metadata`。注册时 id 不得与已注册工具冲突（冲突整组拒绝）。

**`PluginToolMiddleware`（工具调用中间件）**：结构 `{ name: string; fn(toolName, args, next): Promise<PluginToolResult> }`。宿主以**链首守卫**挂到数字员工上，先于内置 `logging/retry/timeout/result_size` 执行，可用于：

- **观察**：`const r = await next()` 后读取结果；

- **短路阻断**：不调用 `next()`，直接返回 `{ success: false, error, toolName }`（工具 handler 不再执行）；

- **改写**：调用 `next()` 后改写返回值。

`next()` 返回 `PluginToolResult`（`success/output/error/toolName/generatedFiles`）。中间件异常会被宿主收敛为错误结果，不会中断代理执行。禁用/删除插件后**即时生效**（按插件下线后，存量 agent 的中间件链在下一次重建时移除，运行中的任务不受打断）。

## 11. 渲染端入口

`dist/renderer/index.js`，ESM `default export`：

```ts
export default {
  routes: [{ path: '', component: Page }],   // 挂载到 /plugin/<id>/ 命名空间
  views?: [{ view: 'chat.toolbar', component: MyToolbar }],  // UI 注入（需 capabilities.ui.views 授权）
  navIcon?: (props: { active }) => JSX,      // 动态导航图标
  init?(host: PluginRendererHost): void,     // 路由挂载前调用一次
  dispose?(): void,                          // 卸载时清理订阅
}
```

`PluginRendererHost` 提供 `bridge.invoke/onEvent`、`i18n.t`（插件 locale 已由宿主代注册，namespace = 插件 id）与 `hostCapabilities`：`subscribeExternalFiles`、`registerCloseGuard`、`showOpenDialog`、`showSaveDialog`、`clipboard{readText,writeText}`、`getTheme`+`onThemeChange`、`getLocale`+`onLocaleChange`。

**UI 注入点**：`chat.toolbar`（输入框工具栏）/ `chat.quick`（输入框上方快捷建议区）/ `chat.header`（任务对话页头部）/ `sidebar.footer`（底部导航栏底部）/ `settings.tab`（设置页聚合 Tab）/ `message.menu`（消息操作菜单）/ `message.bubble`（消息气泡操作区，context 含 {role,content,messageId}）。

## 12. 渲染端集成（__WA\_HOST__ / plugin:// 协议）

- **共享库单例**：宿主注入 `globalThis.__WA_HOST__ = { React, ReactDOM, jsxRuntime, antd, icons, i18n, reactI18n }`。插件构建时把 `react/antd` 等 external 并 shim 到 `__WA_HOST__`（见构建脚本），防双 React 实例；插件包内若检出自带 react 则拒绝加载。

- **plugin:// 协议**：`plugin://<id>/<相对路径>` 经 `protocol.handle` 映射到插件目录（主动校验越权：非法路径 403，未启用插件 404）。仅 enabled 插件可访问。

- **路由**：`/plugin/<id>/*` 挂载插件 routes；独立窗口复用同一组路径；导航项合并进 `nav.store`（label 为插件 locale key，icon 为 SVG 字符串，支持排序与 tab 分离）。

