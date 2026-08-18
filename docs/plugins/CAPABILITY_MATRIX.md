# WorkAvatar 插件能力矩阵

> 能力 × 能力域 × 安全级别 × 示例插件 一览表。
> 协议细节见 [PROTOCOL.md](../../plugins/plugin-sdk/PROTOCOL.md)，接口签名见 [API_REFERENCE.md](./API_REFERENCE.md)。

## 能力域总览

| 能力域 | 入口 | 说明 | 授权粒度 |
|---|---|---|---|
| `data` | `services.data.query/mutate` | 通用数据访问 | 实体 + 读写 |
| `execute` | `services.execute.execute` | 统一执行入口 | 执行类型 kind |
| `events` | `services.events.subscribe/publish` | 事件总线 | 订阅白名单 + 发布开关 |
| `ui` | 渲染端 `views` + `contributions.registerView` | UI 注入 | 注入点 |
| `system` | `services.notification/scheduler/windows/native` | 系统能力 | 特性 feature |

---

## 数据访问层（services.data）

| 实体 | 查询 | 写操作 | 安全级别 | 说明 |
|---|---|---|---|---|
| `conversations` | ✅ | create/update/delete | 中 | 对话读写，FTS 一致性由宿主保证 |
| `employees` | ✅ | create/update/delete | 中 | 数字员工，含工作区目录管理 |
| `llmProviders` | ✅ | create/update/delete | 高 | 模型供应商，api_key 自动剥离 |
| `memories` | ✅ | create/update/delete | 中 | 员工记忆，软删除语义由宿主处理 |
| `settings` | ✅ | ❌ 只读 | 高 | 全局配置只读，插件私有配置用自身 KV |

**安全规则**：
- 实体必须在 `capabilities.data.entities` 白名单内，否则拒绝。
- `access=read` 的实体调用 `mutate` 拒绝。
- `llmProviders` 返回前剥离 `api_key`。

---

## 宿主能力层（services.execute）

| kind | 说明 | 返回 | 安全级别 |
|---|---|---|---|
| `agent-task` | 委派数字员工执行任务 | `{ conversationId, text }` | 中 |
| `agent-chat` | 底层对话流式执行 | `void` | 中 |
| `llm-chat` | 受控 LLM 单次调用 | `string` | 中 |
| `llm-stream` | 受控 LLM 流式调用 | `string`（累积） | 中 |

**安全规则**：`kind` 必须在 `capabilities.execute.kinds` 白名单内。

---

## 系统集成层（services.events）

| 能力 | 说明 | 安全级别 |
|---|---|---|
| `subscribe` | 订阅宿主事件或其他插件事件 | 低（白名单） |
| `publish` | 发布事件（强制 `plugin:<id>:` 前缀） | 低 |

**宿主事件**：`conversation:deleted`、`model:renamed`。
**插件事件**：`plugin:<id>:<event>`，可被其他插件订阅。

---

## UI 扩展层（渲染端 views + contributions）

| 注入点 | 位置 | 说明 | 安全级别 |
|---|---|---|---|
| `chat.toolbar` | 对话输入框工具栏 | 插件在输入框旁加按钮/组件 | 低 |
| `sidebar.footer` | 侧边栏底部 | 插件在导航底部加状态/入口 | 低 |
| `settings.tab` | 设置页 Tab | 插件在设置页加配置 Tab | 低 |
| `message.menu` | 对话消息操作菜单 | 插件在消息上加快捷操作 | 低 |

**其他贡献点**：`registerAgentTools` / `registerMcpTools` / `registerFileAssociations` / `registerGlobalShortcuts` / `registerCommand`。

---

## 系统能力（services.system）

| 特性 | 服务 | 说明 | 安全级别 |
|---|---|---|---|
| `notification` | `services.notification` | 系统通知 | 低 |
| `scheduler` | `services.scheduler` | 定时任务 | 中 |
| `windows` | `services.windows` | 创建插件窗口 | 中 |
| `native` | `services.native` | 租借宿主原生模块 | 高 |
| `globalShortcuts` | `contributions.registerGlobalShortcuts` | 全局快捷键 | 高 |

---

## 基础能力（无需授权）

| 能力 | 入口 | 说明 |
|---|---|---|
| 日志 | `services.logger` | 插件作用域日志 |
| 宿主路径 | `services.host.getDataDir` | 数据目录 |
| 插件路径 | `ctx.paths` | root/data/resources |
| IPC | `ctx.ipc.handle/broadcast` | 插件私有通道 |
| 存储 | `ctx.storage` | 独立分库 + KV |
| 迁移 | `migrations` + `ctx.legacy` | 数据迁出（需 legacyMigration） |

---

## 示例插件能力映射

| 插件 | 使用的能力域 |
|---|---|
| notes | ui（message.menu）、storage、ipc、legacyMigration |
| calendar | system（notification/scheduler/windows）、registerAgentTools、storage、ipc |
| voice | execute（llm-stream）、system（windows/native）、storage、ipc |
| automation | data（conversations write）、execute（agent-chat）、events（subscribe）、system（notification/scheduler）、registerAgentTools |
