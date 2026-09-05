# WorkAvatar 插件开发与打包教程

> 面向外部开发者：独立开发、打包、分发 WorkAvatar 插件。协议细节见 [API\_REFERENCE.md](../../../plugin-sdk/API_REFERENCE.md)，能力矩阵见 [CAPABILITY\_MATRIX.md](../../../plugin-sdk/CAPABILITY_MATRIX.md)，类型契约见 [plugin-sdk](../../../plugin-sdk/)；也可在 WorkAvatar 内通过内置 plugin-dev skill 获取全部资料并由数字员工代为脚手架。

## 目录

1. [前置准备](#1-前置准备)
2. [插件工程结构](#2-插件工程结构)
3. [编写 manifest.json（含 capabilities）](#3-编写-manifestjson含-capabilities)
4. [编写主进程入口](#4-编写主进程入口)
5. [编写渲染端入口](#5-编写渲染端入口)
6. [能力选型指南](#6-能力选型指南)
7. [构建与打包 zip](#7-构建与打包-zip)
8. [安装与分发到用户](#8-安装与分发到用户)
9. [发布建议与版本策略](#9-发布建议与版本策略)

***

## 1. 前置准备

* Node.js ≥ 20。

* 一个可运行的 WorkAvatar（用于安装调试）。

* 参考插件结构与类型：本模板工程即最小可构建示例，类型契约在 `plugin-sdk/src`。

## 2. 插件工程结构

推荐的源码目录（构建脚本 `build-plugin.mjs` 会从 `src/` 编译出 `dist/`）：

```
my-plugin/
├── manifest.json           # 唯一信任入口（手写）
├── package.json            # 依赖声明（dependencies/nativeDependencies/devDependencies）
├── src/
│   ├── main/index.ts       # 主进程入口（编译为 dist/main/index.cjs）
│   └── renderer/index.tsx  # 渲染端入口（编译为 dist/renderer/index.js，可省略）
├── resources/              # 自包含重资源（onnx 模型等），只读，随 zip 分发
├── skills/                 # 可选：内置 Skills（每个子目录含 SKILL.md，见 §5.1），随 zip 分发
└── locale/                 # zh-CN.json / en-US.json（多语言文案）
```

主进程入口编译为 **CJS**，渲染端入口编译为 **ESM**。渲染端对 `react` / `antd` / `i18next` 等的 import 由构建脚本自动 shim 到宿主 `__WA_HOST__`，你**无需安装这些依赖**，直接 `import React from 'react'` 即可。

### package.json 依赖声明约定

插件**自带** `package.json` 显式声明其依赖，构建脚本据此决定打包或借用。三个字段各有定义：

| 字段                   | 说明                                                                                                                                                                                       | 示例                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `dependencies`       | 会被 esbuild **打包进 dist/** 的运行时纯 JS 依赖。它们随插件分发，不依赖宿主预装                                                                                                                                     | `vditor`、`@dbml/core`、`@xyflow/react`、`dayjs`、`zustand` |
| `nativeDependencies` | **宿主借用的原生模块**（`.node`），构建时加入 external **不打包**，运行时经 `ctx.services.native.borrow(name)` 租借。**只能在宿主白名单内选择**（清单见 `plugin-sdk/host-native-dependencies.json`，随 devkit 分发），插件 zip 禁止携带 `.node` | `sherpa-onnx-node`                                      |
| `devDependencies`    | 仅构建/类型检查用的依赖（**不随分发**）：共享库（`react`/`react-dom`/`antd`/`@ant-design/icons`/`i18next`/`react-i18next`，构建时 shim 到 `__WA_HOST__`）+ 构建工具（`esbuild`/`typescript`/`adm-zip` 等）                  | `antd`、`esbuild`                                        |

> **第三方如何知道宿主有哪些原生模块？** 宿主原生依赖白名单（`plugin-sdk/host-native-dependencies.json`）随 devkit 分发，是**单源真相**。构建时 `build-plugin.mjs` 会比对你在 `nativeDependencies` 声明的模块是否在白名单内，不在则警告（运行时借用会被宿主以明确报错拒绝）；运行时也可经 `ctx.services.host.listNativeModules()` 查询宿主实际提供的原生模块名与版本范围。原生依赖无法像构建期 `dependencies` 那样"即想即用"，只能选用宿主已提供的能力。

> 请勿把 `nativeDependencies` 里的原生模块放进 `dependencies`——它们无法被 esbuild 打包，且导入校验会拒绝自带 `.node`。

## 3. 编写 manifest.json（含 capabilities）

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": ">=0.2.0",
  "description": "插件的功能描述",
  "author": "you@example.com",
  "main": "dist/main/index.cjs",
  "renderer": "dist/renderer/index.js",
  "locale": "locale",
  "ipc": ["list-things", "create-thing"],
  "capabilities": [
    { "domain": "data", "entities": ["conversations"], "access": "read" },
    { "domain": "execute", "kinds": ["llm-stream"] },
    { "domain": "events", "subscribe": ["conversation:deleted"], "publish": true },
    { "domain": "ui", "views": ["chat.toolbar"] },
    { "domain": "system", "features": ["notification", "scheduler"] }
  ],
  "nav": {
    "label": "navLabel",
    "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"><circle cx=\"8\" cy=\"8\" r=\"6.5\"/></svg>",
    "order": 100,
    "detachable": true
  }
}
```

要点：

* `id` 用 `[a-z]` 开头的小写连字符，长度 ≤64；避开保留字 `settings/tasks/employees/list/invoke/event`。

* `engine` 声明与宿主协议的兼容范围（当前为 `>=0.2.0`），不满足会被禁用（不崩溃）。

* `ipc` 列出你会在主进程注册的通道短名（配合 `ctx.ipc.handle`）。

* `capabilities` 声明你需要的能力域（见 §6 能力选型），未声明则对应服务为 `undefined`。

* `nav` 只对"要有页面"的插件有意义；纯后台插件可整体省略。

## 4. 编写主进程入口

`src/main/index.ts`：

```ts
import type { PluginContext, PluginMigrationContext } from '@workavatar/plugin-sdk'

export const migrations = [
  {
    version: '1-init-schema',
    description: '初始化插件库',
    run(mig: PluginMigrationContext) {
      const db = mig.storage.openSqlite('index')
      db.exec(`CREATE TABLE IF NOT EXISTS my_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`)
    },
  },
]

export async function activate(ctx: PluginContext): Promise<void> {
  // 注册 IPC（短名必须在 manifest.ipc 白名单内；宿主自动加 plugin:my-plugin: 前缀）
  ctx.ipc.handle('list-things', () => {
    const db = ctx.storage.openSqlite('index')
    return db.prepare('SELECT * FROM my_items').all()
  })

  ctx.ipc.handle('create-thing', (payload: any) => {
    const db = ctx.storage.openSqlite('index')
    db.prepare('INSERT INTO my_items (id, name) VALUES (?, ?)').run(crypto.randomUUID(), payload?.name ?? '')
    ctx.ipc.broadcast('data-changed', { ts: Date.now() })
    return { success: true }
  })

  // 数据访问（需 capabilities.data 授权）
  const convs = await ctx.services.data?.query('conversations', { limit: 5 })

  // 统一执行（需 capabilities.execute 授权）
  ctx.services.execute?.execute({ kind: 'llm-chat', prompt: '你好' })

  // 事件订阅/发布（需 capabilities.events 授权）
  ctx.services.events?.subscribe('conversation:deleted', (id) => console.log('deleted', id))
  ctx.services.events?.publish('data-changed', { ts: Date.now() })

  // 注册 agent 工具（可选）
  ctx.contributions.registerAgentTools([{
    id: 'my_thing_lookup',
    name: 'my_thing_lookup',
    title: '查询我的插件数据',
    description: '按关键字查询插件数据',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } } },
    handler: (args, context) => '查询结果...',
    onDemand: true,
  }])

  // 注册命令（可被斜杠菜单/宿主调用）
  ctx.contributions.registerCommand({
    id: 'my-command',
    title: 'myPlugin.command',
    handler: () => ({ ok: true }),
  })
}

export function deactivate(): void {
  // 关闭定时器 / 窗口 / DB 连接
}
```

* 数据读写一律用 `ctx.storage.openSqlite()`，**不要**碰内核主库。

* 宿主调用 `activate` 时**不 await**：耗时初始化不要阻塞在 activate 里（可后台执行或用 scheduler 调度）。

* 访问宿主数据用 `ctx.services.data`，执行任务/LLM 用 `ctx.services.execute`，事件用 `ctx.services.events`。

* 定时任务用 `ctx.services.scheduler.every/cron`，不要自己裸开 `setInterval`（宿主统一回收）。

* 原生模块用 `ctx.services.native.borrow('better-sqlite3')` 租借，禁止自带 `.node`。

### 5.1 内置 Skills（可选，纯目录约定）

插件可将自己擅长的领域知识以内置 Skill 形式随插件分发：**无需任何代码与 manifest 声明**，只需在插件根目录放 `skills/<技能名>/SKILL.md`（对齐 [agentskills.io](https://agentskills.io/) 开放标准格式，要求 `name` 与目录名一致）：

```
my-plugin/
└── skills/
    └── quick-json/
        ├── SKILL.md                      # YAML frontmatter + Markdown 正文
        └── references/*.md               # 可选：渐进披露第 3 层的按需参考资料
        └── scripts/                      # 可选：可执行脚本（需技能声明 allowed-tools 含 run_skill_script）
```

插件激活时宿主自动注册这些技能（来源标记「插件」），安装插件即扩充系统的技能池：

* 技能进入员工设置 → 技能 Tab 的「可用 Skills」列表，**分配给数字员工**后被该员工发现与调用（`activate_skill` / references 按需读取三步渐进披露照常生效）。
* 禁用/删除插件时技能随之从可用池下线，禁用期间员工分配记录保留，重新启用后自动恢复。
* 技能能力无需新增 capabilities 授权：`skills/` 属纯静态资源，随 `.wap` 打包分发（与 `resources/` 同级处理）。

## 5. 编写渲染端入口

`src/renderer/index.tsx`：

```tsx
import MyPage from './MyPage'
import MyToolbar from './MyToolbar'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: MyPage }],
  // UI 注入（需 capabilities.ui.views 授权）：在宿主界面指定注入点渲染组件
  views: [{ view: 'chat.toolbar', component: MyToolbar }],
  init(host: PluginRendererHost): void {
    // 路由挂载前调用一次：保存 bridge / i18n，订阅事件
  },
  dispose(): void { /* 清理订阅 */ },
}
export default entry
```

页面里调用主进程：

```tsx
const list = await window.electronAPI.plugin.invoke('my-plugin', 'list-things')
const bridge = host.bridge            // 或从 init 保存的 bridge 调用
bridge.invoke('create-thing', { name })
bridge.onEvent('data-changed', () => load())   // 返回取消订阅函数
```

* 路由挂载于 `/plugin/my-plugin/`；`nav` 存在时导航项自动出现在侧边栏。

* 明/暗主题：只用 antd token / CSS 变量，自动继承宿主主题。

* 文案：放 `locale/zh-CN.json`、`locale/en-US.json`，渲染端 `host.i18n.t('myPlugin.someKey')`（宿主代注册会话）。

## 6. 能力选型指南

| 需求                     | 能力域       | 入口                                       |
| ---------------------- | --------- | ---------------------------------------- |
| 访问宿主数据（对话/员工/模型/记忆/设置） | `data`    | `services.data.query/mutate`             |
| 委派数字员工 / 调用 LLM        | `execute` | `services.execute.execute`               |
| 订阅/发布事件（含插件间协作）        | `events`  | `services.events.subscribe/publish`      |
| 在宿主界面注入组件              | `ui`      | 渲染端 `views`                              |
| 系统通知                   | `system`  | `services.notification`                  |
| 定时任务                   | `system`  | `services.scheduler`                     |
| 创建窗口                   | `system`  | `services.windows`                       |
| 租借原生模块                 | `system`  | `services.native`                        |
| 全局快捷键                  | `system`  | `contributions.registerGlobalShortcuts`  |
| 给数字员工加工具               | —         | `contributions.registerAgentTools`       |
| 通过 MCP 对外暴露            | —         | `contributions.registerMcpTools`         |
| 关联文件类型                 | —         | `contributions.registerFileAssociations` |
| 对话消息快捷操作               | —         | `contributions.registerMessageActions`   |
| 注册命令                   | —         | `contributions.registerCommand`          |

**最小权限原则**：只声明你实际需要的能力域，减少攻击面。

## 7. 构建与打包 zip

构建脚本 `build-plugin.mjs` 随本技能提供（见参考资料 `hello-world.build-plugin.mjs`，复制到插件工程根目录使用）：

```bash
# 构建全部插件（主进程 CJS + 渲染端 ESM）到各插件 dist/ 下
node build-plugin.mjs

# 构建单个
node build-plugin.mjs my-plugin

# 构建并产出独立分发包 .wap → release/plugins/<id>-v<version>.wap
node build-plugin.mjs my-plugin --zip
```

* 主进程 → `platform=node target=node20 format=cjs`，external 内置模块与 electron，以及 `package.json.nativeDependencies` 声明的宿主原生依赖（不打包）。

* 渲染端 → `platform=browser target=es2020 format=esm jsx=automatic`，共享库 shim 到 `__WA_HOST__`，CSS 自动内联。

* `dependencies` 会被打包进 `dist/`，随包分发；`nativeDependencies` 不打包、由宿主借用；`devDependencies` 不随分发。

* 分发包（`.wap`，内部仍为 zip 归档）**默认包含源码**：`src/**` + `package.json` + `tsconfig.json` 随包分发。已安装插件目录（`userData/plugins/<id>/`）因此自带源码与依赖声明，可 `npm install` 后直接修改 `src/` 再用构建脚本重建（AI / 用户二次开发）；如需分发仅含运行时必需文件（`manifest.json` + `dist/**` + `locale/**` + `resources/**` + `skills/**`）的精简包，在 `--zip` 基础上追加 `--no-source`。

本教程面向**脱离 WorkAvatar 源码仓库**的开发者：构建脚本 `build-plugin.mjs` 随本技能提供，复制到插件工程根目录即可使用。ship 产物是单个 `<id>-v<version>.wap`。

## 8. 安装与分发到用户

用户侧有三种安装方式（效果一致）：

1. **导入插件包**：应用设置 → 插件 → 「导入插件」，选择一个 `.wap` 文件。

   * 若已安装相同 `id`，会弹出覆盖/升级确认（显示旧版本 → 新版本），确认后删除旧安装目录并用新包重装。

   * 导入校验：必须有合法 `manifest.json`、`main` 存在、`id` 合法、不携带 `.node` 原生模块、路径不越界。
2. **直接打开** **`.wap`** **文件**：双击 `.wap`（或系统右键"打开方式"选择 WorkAvatar），弹出确认框询问是否加载，确认后直接安装并热重载生效。
3. **手动放入目录**：解压包到 `userData/plugins/<id>/`，重启应用自动识别。

任意方式安装后**重启应用生效**（直接打开 `.wap` 会立即热重载生效）。插件数据目录 `userData/plugin-data/<id>/` 在重装/禁用时不删除，升级不丢用户数据。

## 9. 发布建议与版本策略

* **版本兼容**：`engine` 声明宿主协议范围，宿主做 semver 校验。请确保语义版本随功能变更递增。

* **升级覆盖**：宿主按 `id` 判定"已安装"，升级即删除旧安装目录重装新包；**运行时数据保留**（在 `plugin-data`）。

* 分发物就是 `release/plugins/<id>-v<version>.wap`，可直接发给用户或在应用内「导入插件」安装。

