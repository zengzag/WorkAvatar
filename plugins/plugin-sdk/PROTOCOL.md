# WorkAvatar 插件协议规范（P0 草案 v0.1）

> 本文件是插件协议的单一事实源，类型定义见 `src/`。评审通过后在 P1 实现宿主侧，后续只增不改（破坏性变更升 major）。

## 1. 插件包结构

```
<plugin-root>/
├── manifest.json          # 唯一信任入口
├── dist/
│   ├── main/index.cjs     # 主进程入口：export { migrations?, activate, deactivate? }
│   └── renderer/index.js  # 渲染端入口：export default { routes, navIcon?, init?, dispose? }
├── resources/             # 自包含重资源（onnx 模型等），随包 asarUnpack，只读
└── locale/                # zh-CN.json / en-US.json
```

两个安装来源，同一套加载器：

| 来源 | 目录 | 特性 |
|---|---|---|
| 内置 | `<安装目录>/resources/plugins/` | 只读、随安装包分发、可禁用不可删除 |
| 用户 | `<userData>/plugins/` | 放入即识别、可启停可删除 |

插件运行期数据（sqlite 分库、KV）全部写入 `userData/plugin-data/<id>/`，与安装目录解耦，禁用不丢数据。

## 2. manifest.json 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✓ | `/^[a-z][a-z0-9-]{1,63}$/`；保留字：`settings` `tasks` `employees` |
| `name` / `version` | ✓ | 展示名 / semver |
| `engine` | ✓ | 宿主协议 semver range（如 `>=0.1.0 <1.0.0`），不满足则禁用并提示 |
| `main` | ✓ | 主进程入口（cjs），相对根目录 |
| `renderer` | | 渲染端入口（ESM）；纯后台插件可省略 |
| `locale` | | locale 目录名，默认 `locale` |
| `ipc` | | 允许注册的通道名列表（`'*'` 全开）；宿主强制 `plugin:<id>:` 前缀 |
| `permissions` | | 权限声明，决定 ctx.services 注入项（见 §4） |
| `nav` | | 导航项：`label`（文案或 i18n key）、`icon`（SVG 字符串）、`order`（默认 100）、`detachable` |

## 3. 生命周期（重启生效，无热插拔）

```
宿主启动
  → 扫描两个插件目录，解析 manifest
  → schema 校验 + engine 校验 + id 保留字校验
  → 读 settings 表 plugins.config 启用状态，过滤
  → 逐插件执行未应用的 migrations（原子事务 + plugin_migrations 版本记录）
  → 逐插件 activate(ctx)（try/catch 隔离，单插件失败不阻塞宿主）
  → 贡献点落库（agent 工具 / MCP 工具 / 文件关联 / 快捷键 / 导航）
  → 之后才初始化 EmployeeAgentService 等内核服务（保证插件工具就位）
渲染端启动
  → IPC 拉取已启用插件清单
  → import('plugin://<id>/index.js')（宿主 privileged scheme + protocol.handle）
  → init(host) → 注册路由 / 导航 / locale → createHashRouter
退出 / 禁用
  → deactivate()（插件释放资源：关定时器、关窗口、关 DB 连接）
```

启停插件在 Settings「插件管理」页操作，重启后生效。

## 4. 权限与 ctx.services 对应表

| 权限 | 注入的服务 | 用途 |
|---|---|---|
| （无需声明） | `logger` / `host` / `ipc` / `storage` / `contributions` | 基础能力（host.getDataDir 等） |
| `llm` | `services.llm.chat()` / `chatStream()` | 受控 LLM 调用（走 PiAIProvider，自动记日志/用量；chatStream 支持流式回调与 AbortSignal） |
| `agent` | `services.agent.runTask()/listEmployees()` | 委派数字员工 |
| `conversations` | `services.conversations` | 内核对话只读查询 |
| `notifications` | `services.notification.notify()` | 通知（主窗口激活→推 `notify` 插件事件，失焦→系统通知，点击→`notify-click` 插件事件） |
| `scheduler` | `services.scheduler.every()/cron()/cancel()` | 定时任务（宿主统一回收） |
| `globalShortcuts` | `contributions.registerGlobalShortcuts()` | 全局快捷键 |
| `windows` | `services.windows.create()` | 插件窗口（悬浮字幕/登录窗等；支持 transparent/skipTaskbar/focusable/x/y/url/contentPath，创建后自动纳入广播目标） |
| `nativeModules` | `services.native.borrow()/modulePath()` | 租借宿主原生模块（ABI 一致；插件禁止自带 .node） |
| `legacyMigration` | migration ctx 的 `legacy` / `legacy.kms` | 内核主库只读（`kms` 字段额外暴露 KMS 向量库只读，如 kms_voice_tasks；仅内置插件迁移） |

## 5. IPC 约定

- preload 只暴露通用桥：`window.electronAPI.plugin.invoke(pluginId, channel, payload)` / `onEvent(pluginId, channel, cb)`，preload 不随插件膨胀
- 主进程通道一律 `plugin:<id>:<channel>`，宿主拒绝插件覆盖内核通道
- 主进程推送：`ctx.ipc.broadcast(event, payload)` → 该插件所有渲染端（主窗口 + 独立窗口 + 插件自建窗口）
- 插件 agent 工具 handler 上下文为 `PluginToolContext`：`{ onProgress?, employeeId? }`（`employeeId` 在数字员工执行场景由宿主注入，MCP 等外部调用为 null）

## 6. 存储与迁移

- 插件一律使用 `ctx.storage.openSqlite()` 获得独立分库（WAL），**禁止直连内核主库**
- 原生模块只能 `borrow('better-sqlite3')` 等租借，禁止自带 .node（启动扫描拒绝）
- 内置插件迁出内核数据：`migrations: [{ version, run(ctx) }]`，宿主保证：
  - 每个迁移在插件库事务内执行，失败回滚并禁用该插件（不阻塞宿主与其他插件）
  - 成功后写 `plugin_migrations(version, applied_at)`，幂等
  - 内核旧表在全部插件迁移完成 + 一个稳定版本后才由内核 migration DROP（兜底窗口期）

## 7. 渲染端约定

- 路由挂载于 `/plugin/<id>/` 命名空间；独立窗口复用 `#/window/plugin/<id>` 加载时序
- **共享库单例**：react / react-dom / antd / i18next 由宿主提供，SDK 构建模板强制 external 并 shim 到 `globalThis.__WA_HOST__`；插件包内若检出自带 react 则拒绝加载
- 主题：插件 UI 只用 antd token / CSS 变量，明暗主题自动继承
- i18n：插件 locale 文件由宿主代注册（namespace = 插件 id），渲染端直接 `t()`

## 8. agent 工具贡献

- `ctx.contributions.registerAgentTools(tools)`：注入宿主 ToolRegistry，参与员工三态配置（on/on_demand/off）
- 宿主 EmployeeAgentService 在构建 agent 时合并插件工具（handler 自动注入 `employeeId` 上下文）；工具分类 UI（getUnifiedBuiltinToolCatalog）与 KMS MCP（buildAllBuiltinToolDefinitions）同样纳入插件工具
- 工具 id 沿用现名（如 `calendar_event_list`），**老员工的工具配置无需迁移**
- 插件禁用 → 工具不注册；现有 `getToolLookupMap` 已容忍分类中工具缺失
- 工具分类聚合（TOOL_CATEGORY_DEFS）改为按"已注册工具"动态计算归属分类

## 9. 版本策略

- `engine` semver 启动校验：不兼容 → 禁用 + 设置页提示，不崩溃
- ctx API 只增不改：新增字段/方法为 minor；删除或语义变更为 major
- 宿主实现须同时兼容 `engine` 声明范围内的旧插件

## 10. 安全边界（一期）

- 可信插件模型：内置插件随包分发；用户插件由用户自行放入（责任自负）
- 启动时静态扫描：拒绝自带 `.node`、拒绝 manifest 通道越权
- 第三方开放（远期）：签名校验 + utilityProcess 进程隔离，本协议预留 `permissions` 扩展位
