# WorkAvatar 插件协议规范

> 本文件是插件协议的单一事实源，类型定义见 `plugin-sdk/src/`。
> 插件通过 **manifest 声明 + 双入口插件包 + 宿主扩展点** 扩展 WorkAvatar 的能力。
> 能力矩阵见 [CAPABILITY_MATRIX.md](../../docs/plugins/CAPABILITY_MATRIX.md)，接口签名见 [API_REFERENCE.md](../../docs/plugins/API_REFERENCE.md)。

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

插件安装到 `userData/plugins/<id>/`，可启停、可删除、可覆盖升级。运行期数据（sqlite 分库、KV）写入 `userData/plugin-data/<id>/`，与安装目录解耦，禁用/重装不丢数据。

## 2. manifest.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | `/^[a-z][a-z0-9-]{1,63}$/`；保留字：`settings` `tasks` `employees` `list` `invoke` `event` |
| `name` / `version` | ✓ | 展示名 / semver |
| `engine` | ✓ | 宿主协议 semver range（当前为 `>=0.2.0`），不满足则禁用并提示 |
| `main` | ✓ | 主进程入口（cjs），相对根目录 |
| `renderer` | | 渲染端入口（ESM）；纯后台插件可省略 |
| `locale` | | locale 目录名，默认 `locale` |
| `ipc` | | 允许注册的通道名列表（`'*'` 全开）；宿主强制 `plugin:<id>:` 前缀 |
| `capabilities` | | 能力域授权声明（见 §4） |
| `permissions` | | 迁移专用权限（仅保留 `legacyMigration`） |
| `nav` | | 导航项：`label`（文案或 i18n key）、`icon`（SVG 字符串）、`order`（默认 100）、`detachable` |
| `dependencies` | | 插件依赖（pluginId → semver range）。缺失/未启用/无效/版本不满足都会标记 invalid 并提示，激活按拓扑顺序先激活依赖方 |

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

插件变更（启停 / 导入 / 删除 / 升级）后需重启应用生效。

## 4. 能力域授权（capabilities）

manifest `capabilities` 数组声明插件可访问的能力域，宿主在服务入口统一校验（越权抛错）。

| 能力域 | 声明 | 注入服务 | 用途 |
|---|---|---|---|
| `data` | `{ domain:'data', entities:[...], access:'read'\|'write' }` | `services.data.query/mutate` | 通用数据访问（实体白名单 + 读写分离） |
| `kms` | `{ domain:'kms', query:['search'\|'content'\|'collections'] }` | `services.kms.*` | 只读资料库查询（检索/读内容/列合集） |
| `execute` | `{ domain:'execute', kinds:[...] }` | `services.execute.execute` | 统一执行入口（agent-task/agent-chat/llm-chat/llm-stream） |
| `events` | `{ domain:'events', subscribe?:[...], publish?:boolean }` | `services.events.subscribe/publish` | 事件总线（订阅白名单 + 发布开关） |
| `ui` | `{ domain:'ui', views:[...] }` | 渲染端 `views` + `contributions.registerView` | UI 注入（注入点白名单） |
| `system` | `{ domain:'system', features:[...] }` | `services.notification/scheduler/windows/native` | 系统能力（特性白名单） |
| `collaboration` | `{ domain:'collaboration', shared?:{read?,write}, call?:[...] }` | `services.shared` + `services.bus` | 插件协作：共享 KV + 跨插件 RPC |

**数据实体**：`conversations` / `employees` / `llmProviders` / `memories` / `settings`（只读）/ `messages`（只读，`filter.conversationId` 读某对话全部消息）。
**执行类型**：`agent-task` / `agent-chat` / `llm-chat` / `llm-stream`。
**系统特性**：`notification` / `scheduler` / `windows` / `native` / `globalShortcuts`。
**UI 注入点**：`chat.toolbar` / `chat.quick` / `chat.header` / `sidebar.footer` / `settings.tab` / `message.menu` / `message.bubble`。

**基础能力**（无需声明）：`logger` / `host` / `ipc` / `storage` / `contributions` / `paths`。

## 5. 数据访问层（services.data）

```ts
services.data.query(entity, { filter?, sort?, limit?, offset? })   // 只读查询
services.data.mutate(entity, op, payload)                          // 写操作（create/update/delete）
```

- 实体必须在 `capabilities.data.entities` 白名单内，否则拒绝。
- `access=read` 的实体调用 `mutate` 拒绝。
- `llmProviders` 返回前剥离 `api_key`。
- `messages` 为只读实体：`query('messages', { filter: { conversationId } })` 返回某对话全部分析后的消息数组。

## 6. 宿主能力层（services.execute）

```ts
services.execute.execute({ kind, employeeId?, providerId?, modelId?, prompt?, messages?, ... }, callbacks?, signal?)
```

- `kind` 必须在 `capabilities.execute.kinds` 白名单内。
- 插件只需理解"execute 一个任务/一次对话"，无需区分底层是 agent 还是 llm。
- **`agent-chat`**：返回 `{ conversationId }`（新建或复用的会话 id）。支持：
  - `system`（字符串）：覆盖员工系统提示词，注入领域专用提示（插件场景推荐）；
  - `minimalMode`（布尔）：`false` 时保留员工全部工具（默认 `true` 会清空工具集，需编辑类工具时必须显式设 false）；
  - `messages`：`{role, content}[]`，末条为用户消息（query），其余为历史。
- **`llm-stream` / `llm-chat`**：返回累积文本；`llm-stream` 经 `onChunk` 流式回调。

## 7. 系统集成层（services.events）

```ts
services.events.subscribe(event, callback)   // 订阅（白名单），返回取消订阅函数
services.events.publish(event, payload)      // 发布（需 publish 能力），强制 plugin:<id>: 前缀
```

- **宿主事件**：`conversation:created`（{id,employeeId,title,parentConversationId}）、`conversation:updated`（{id,data}）、`conversation:deleted`、`employee:created` / `employee:updated` / `employee:deleted`（{id}）、`model:renamed`。
- **插件事件**：`plugin:<id>:<event>`，可被其他插件订阅（需在 subscribe 白名单声明）。

## 7.5 插件协作层（services.shared / services.bus）

需 `capabilities.collaboration` 授权。

```ts
services.shared.set(key, value)                     // 写本插件命名空间
services.shared.get(key, defaultValue?)             // 读本插件命名空间
services.shared.getFrom(pluginId, key, defaultValue?) // 读其他插件命名空间（需 shared.read）
services.shared.delete(key) / keys() / keysAll()     // keysAll 需 shared.read
services.bus.respond('method', handler)              // 注册可被调用的方法（自动加本插件 id 前缀），返回取消注册函数
await services.bus.call('目标插件id:方法名', payload)  // 调用其他插件方法（需 call 白名单含该方法）
```

- `shared` 数据存宿主级共享库 `plugin-data/plugin-shared.db`，跨插件/热重载持久；写入强制以本插件命名空间隔离，杜绝覆盖他人数据。
- `bus` 目标方法名固定 `目标插件id:方法名`，host 路由到目标插件注册的 responder；目标未注册返回 rejected promise。

## 8. 插件依赖与构建产物依赖

**插件间依赖**：manifest `dependencies`（pluginId → semver range）。宿主激活前校验依赖（缺失 / 未启用 / 无效 / 版本不满足任一），不满足则本插件标记 invalid 并给出原因；激活按拓扑顺序先激活依赖方。

**构建产物依赖**（各插件 `package.json` 声明，构建脚本据 `manifest.main`/`renderer` 打包）：

| 字段 | 去向 | 说明 |
|---|---|---|
| `dependencies` | 打包进 `dist/` 随插件分发 | 运行时纯 JS 依赖，无需宿主预装 |
| `nativeDependencies` | external，**不打包** | 宿主借用的原生模块（`.node`），运行时经 `ctx.services.native.borrow` 租借，**仅限宿主白名单**，zip 禁止自带 |
| `devDependencies` | 仅构建期 | 共享库（shim 到 `__WA_HOST__`）+ 构建工具，不随分发 |

**宿主原生模块白名单（单源真相）**：`host-native-dependencies.json` 定义宿主可经 `native.borrow` 租借的原生模块集合。宿主启动校验借用合法性、构建脚本校验 `nativeDependencies` 声明，二者都读取该清单。第三方插件只能选用清单内模块，运行时可用 `ctx.services.host.listNativeModules()` 查询（对象为 `name → semver 范围`）。

## 8. UI 扩展层

### 8.1 渲染端视图注入（views）

渲染端入口 `default export` 的 `views` 字段声明注入点组件：

```ts
export default {
  routes: [...],
  views: [{ view: 'chat.toolbar', component: MyToolbar }],  // 需 capabilities.ui.views 授权
}
```

宿主在对应注入点渲染组件（经 `__WA_HOST__` 共享 React）。

### 8.2 主进程贡献点（contributions）

```ts
registerAgentTools(tools)          // 进宿主 ToolRegistry，参与员工三态配置
registerMcpTools(tools)            // 经内置 MCP 对外暴露
registerFileAssociations(assocs)   // 系统"打开方式"→ 路由到插件渲染端
registerGlobalShortcuts(shortcuts) // 需 system.features 含 globalShortcuts
registerMessageActions(actions)    // 对话消息快捷操作
registerView(view)                 // 声明 UI 注入意图（需 capabilities.ui.views 授权）
registerCommand(command)           // 注册命令（可被斜杠菜单/宿主调用）
```

## 9. IPC 约定

- preload 只暴露通用桥：`window.electronAPI.plugin.invoke(pluginId, channel, payload)` / `onEvent(pluginId, cb)`。
- 主进程通道一律 `plugin:<id>:<channel>`，宿主拒绝插件覆盖内核通道。
- 主进程推送：`ctx.ipc.broadcast(event, payload)` → 该插件所有渲染端。
- 插件 agent 工具 handler 上下文为 `PluginToolContext`：`{ onProgress?, employeeId? }`。

## 10. 存储与迁移

- 插件一律使用 `ctx.storage.openSqlite()` 获得独立分库（WAL），**禁止直连内核主库**。
- 原生模块只能 `borrow('better-sqlite3')` 等租借，禁止自带 .node（启动扫描拒绝）。
- 迁出内核旧数据：`migrations: [{ version, run(ctx) }]`，宿主保证原子事务 + 幂等 + 失败回滚禁用。

## 11. 渲染端约定

- 路由挂载于 `/plugin/<id>/` 命名空间；独立窗口复用同一组路径。
- **共享库单例**：react / react-dom / antd / i18next 由宿主提供，SDK 构建模板强制 external 并 shim 到 `globalThis.__WA_HOST__`；插件包内若检出自带 react 则拒绝加载。
- 主题：插件 UI 只用 antd token / CSS 变量，明暗主题自动继承。
- i18n：插件 locale 文件由宿主代注册（namespace = 插件 id），渲染端直接 `t()`。

## 12. 版本策略

- `engine` semver 启动校验：不兼容 → 禁用 + 设置页提示，不崩溃。
- ctx API 只增不改：新增字段/方法为 minor；删除或语义变更为 major。

## 13. 安全边界

- 启动时静态扫描：拒绝自带 `.node`、拒绝 manifest 通道越权、拒绝 capabilities 越权。
- 能力域授权：data/execute/events/ui/system 各域在服务入口统一校验。
- 敏感数据剥离：llmProviders 的 api_key 不暴露给插件。
