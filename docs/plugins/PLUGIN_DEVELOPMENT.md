# WorkAvatar 插件开发与打包教程

> 供给外部开发者独立生产、打包、分发插件。协议细节见 [PLUGIN_API.md](./PLUGIN_API.md)，类型契约与示例见 [plugins/plugin-sdk](../../plugins/plugin-sdk/) 与三个示例插件 `plugins/notes`、`plugins/calendar`、`plugins/voice`。

## 目录

1. [前置准备](#1-前置准备)
2. [插件工程结构](#2-插件工程结构)
3. [编写 manifest.json](#3-编写-manifestjson)
4. [编写主进程入口](#4-编写主进程入口)
5. [编写渲染端入口](#5-编写渲染端入口)
6. [本地开发调试](#6-本地开发调试)
7. [构建与打包 zip](#7-构建与打包-zip)
8. [安装与分发到用户](#8-安装与分发到用户)
9. [发布建议与版本策略](#9-发布建议与版本策略)

---

## 1. 前置准备

- Node.js ≥ 20。
- 一个可运行的 WorkAvatar（dev 或已安装 release 版）。
- 参考插件结构与类型：`plugins/notes`、`plugins/calendar`、`plugins/voice`，类型契约在 `plugins/plugin-sdk/src`。

## 2. 插件工程结构

推荐的源码目录（构建脚本 `scripts/build-plugins.mjs` 会从 `src/` 编译出 `dist/`）：

```
my-plugin/
├── manifest.json           # 唯一信任入口（手写）
├── src/
│   ├── main/index.ts       # 主进程入口（编译为 dist/main/index.cjs）
│   └── renderer/index.tsx  # 渲染端入口（编译为 dist/renderer/index.js，可省略）
├── resources/              # 自包含重资源（onnx 模型等），只读，随 zip 分发
└── locale/                 # zh-CN.json / en-US.json（多语言文案）
```

主进程入口编译为 **CJS**，渲染端入口编译为 **ESM**。渲染端对 `react` / `antd` / `i18next` 等的 import 由构建脚本自动 shim 到宿主 `__WA_HOST__`，你**无需安装这些依赖**，直接 `import React from 'react'` 即可。

## 3. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": ">=0.1.0",
  "description": "插件的功能描述",
  "author": "you@example.com",
  "main": "dist/main/index.cjs",
  "renderer": "dist/renderer/index.js",
  "locale": "locale",
  "ipc": ["list-things", "create-thing"],
  "permissions": ["storage"],
  "nav": {
    "label": "navLabel",
    "icon": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.2\"><circle cx=\"8\" cy=\"8\" r=\"6.5\"/></svg>",
    "order": 100,
    "detachable": true
  }
}
```

要点：
- `id` 用 `[a-z]` 开头的小写连字符，长度 ≤64；避开保留字 `settings/tasks/employees/list/invoke/event`。
- `engine` 声明与宿主协议的兼容范围，不满足会被禁用（不崩溃）。
- `ipc` 列出你会在主进程注册的通道短名（配合 `ctx.ipc.handle`）。
- `permissions` 声明需要的服务，未声明则对应服务为 `undefined`。
- `nav` 只对"要有页面"的插件有意义；纯后台插件可整体省略。

## 4. 编写主进程入口

`src/main/index.ts`：

```ts
import type { PluginContext, PluginMigrationContext } from '../../plugin-sdk/src'

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

export function activate(ctx: PluginContext): void {
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
}

export function deactivate(): void {
  // 关闭定时器 / 窗口 / DB 连接
}
```

- 数据读写一律用 `ctx.storage.openSqlite()`，**不要**碰内核主库。
- 定时任务用 `ctx.services.scheduler.every/cron`，不要自己裸开 `setInterval`（宿主统一回收）。
- 原生模块用 `ctx.services.native.borrow('better-sqlite3')` 租借，禁止自带 `.node`。

## 5. 编写渲染端入口

`src/renderer/index.tsx`：

```tsx
import MyPage from './MyPage'
import type { PluginRendererEntry, PluginRendererHost } from '../../plugin-sdk/src/renderer'

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: MyPage }],
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

- 路由挂载于 `/plugin/my-plugin/`；`nav` 存在时导航项自动出现在侧边栏。
- 明/暗主题：只用 antd token / CSS 变量，自动继承宿主主题。
- 文案：放 `locale/zh-CN.json`、`locale/en-US.json`，渲染端 `host.i18n.t('myPlugin.someKey')`（宿主代注册会话）。

## 6. 本地开发调试

把你的插件源码放入 WorkAvatar 仓库 `plugins/`（与 `notes`/`calendar`/`voice` 同级），dev 启动时会**直接加载**该项目目录（含你自己的插件），无需拷贝。

- dev 阶段扫描顺序：项目 `plugins/`（优先）→ `userData/plugins`（用户安装）。若两者撞 `id`，优先加载项目里的 dev 插件；**不会拷贝或覆盖**你通过 release 安装的用户插件，避免开发误伤已装版本。
- 改源码后先执行 `node scripts/build-plugins.mjs my-plugin`（生成 dist），再重启应用即可生效。
- release 版本不扫描项目 `plugins/`，只加载 `userData/plugins`。

如果你的插件是**仓库外独立工程**：不与主程序共用 dev 目录，直接 `--zip` 打包后在应用内「导入插件」安装调试即可，与仓库完全解耦。

## 7. 构建与打包 zip

WorkAvatar 仓库提供统一构建脚本 `node scripts/build-plugins.mjs`：

```bash
# 构建全部插件（主进程 CJS + 渲染端 ESM）到各插件 dist/ 下
node scripts/build-plugins.mjs

# 构建单个
node scripts/build-plugins.mjs my-plugin

# 构建并产出独立分发包 zip → release/plugins/<id>-v<version>.zip
node scripts/build-plugins.mjs my-plugin --zip
```

- 主进程 → `platform=node target=node20 format=cjs`，external 内置模块与 electron。
- 渲染端 → `platform=browser target=es2020 format=esm jsx=automatic`，共享库 shim 到 `__WA_HOST__`，CSS 自动内联。
- zip 内容仅含运行时必需文件：`manifest.json` + `dist/**` + `locale/**` + `resources/**`。

如果你在**独立仓库**开发插件，复制上述构建思路即可（核心是主进程出 CJS、渲染端出被 shim 的 ESM、产出约定结构的 zip）。ship 产物是单个 `<id>-v<version>.zip`。

## 8. 安装与分发到用户

用户侧有两种安装方式（效果一致）：

1. **导入 zip**：应用设置 → 插件 → 「导入插件」，选择一个 `.zip`。
   - 若已安装相同 `id`，会弹出覆盖/升级确认（显示旧版本 → 新版本），确认后删除旧安装目录并用新包重装。
   - 导入校验：必须有合法 `manifest.json`、`main` 存在、`id` 合法、不携带 `.node` 原生模块、路径不越界。
2. **手动放入目录**：解压 zip 到 `userData/plugins/<id>/`，重启应用自动识别。

任意方式安装后**重启应用生效**。插件数据目录 `userData/plugin-data/<id>/` 在重装/禁用时不删除，升级不丢用户数据。

## 9. 发布建议与版本策略

- **版本兼容**：`engine` 声明宿主协议范围，宿主 `engineSatisfies` 做 semver 校验。请确保语义版本随功能变更递增。
- **升级覆盖**：宿主按 `id` 判定"已安装"，升级即删除旧安装目录重装新包；**运行时数据保留**（在 `plugin-data`）。
- 分发物就是 `release/plugins/<id>-v<version>.zip`，可直接发给用户或在应用内「导入插件」安装。
- 提交新插件时，若想被 dev 自动安装，需把插件目录放入 WorkAvatar 仓库的 `plugins/` 下（与 `notes/calendar/voice` 同级），并确保含 `manifest.json`。