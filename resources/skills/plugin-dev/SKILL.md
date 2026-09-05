---
name: plugin-dev
description: "当用户想要为 WorkAvatar 开发、创建、编写插件（plugin），或询问插件开发机制（manifest、capabilities 能力声明、主进程入口、渲染端入口、构建打包 .wap、安装分发），或想要修改已安装插件的功能源码时使用此技能。指导从需求分析、能力选型、工程脚手架、manifest 编写、主进程/渲染端编码、构建打包到安装交付的完整流程，也覆盖对已安装插件（userData/plugins/<id>/，自带源码）的二次开发。不适用于宿主本身的功能开发（那是仓库内普通代码，不是插件）。"
version: 1.2.0
license: Proprietary
---

# WorkAvatar 插件开发

WorkAvatar 插件 = **manifest 声明 + 双入口插件包（主进程 CJS + 渲染端 ESM）+ 宿主扩展点**。插件运行在能力域授权（capabilities）沙箱内，通过 `ctx` 访问宿主受控服务。

本技能自带全部开发资料（协议文档 + 模板源码 + 构建脚本 + SDK 类型契约），**无需 WorkAvatar 源码仓库**即可完整开发出可安装的插件。

## 前置准备（先检查，不满足先告知用户）

- **Node.js ≥ 20 + npm**：构建必需。先用 shell_exec 执行 `node --version` 检查；未安装则引导用户安装 Node.js 后再继续
- **网络**：`npm install` 需要联网安装构建依赖（esbuild/typescript 等）
- **用户安装的 WorkAvatar 本体**：用于最终安装调试

## 开发工作流（按此顺序执行）

1. **需求分析**：明确插件要做什么，对照能力选型表确定需要的 capabilities
2. **环境检查**：Node/npm 版本（见前置准备）
3. **脚手架**：在工作区内创建工程（见"脚手架步骤"，从模板文件复制起步）
4. **编写 manifest.json**：声明 id、入口、ipc 通道白名单、capabilities、nav
5. **编写主进程入口** `src/main/index.ts`：activate/deactivate + IPC + 存储贡献点
6. **编写渲染端入口** `src/renderer/index.tsx`（纯后台插件可省略）
7. **npm install + 构建打包**：`npm install` 后执行 `node build-plugin.mjs --zip` 产出 `.wap`
8. **交付安装**：指导用户导入 `.wap` 并重启应用

## 工程结构

```
<工作区>/my-plugin/
├── manifest.json           # 唯一信任入口（手写）
├── package.json            # 依赖声明（见"依赖声明约定"）
├── tsconfig.json           # 类型检查配置（可选）
├── build-plugin.mjs        # 构建脚本（从本技能 references 复制）
├── src/
│   ├── main/index.ts       # 主进程入口 → 编译为 dist/main/index.cjs
│   └── renderer/index.tsx  # 渲染端入口 → 编译为 dist/renderer/index.js
├── resources/              # 自包含重资源（onnx 模型等），只读，随包分发（无则省略）
└── locale/                 # zh-CN.json / en-US.json（多语言文案）
```

> 工程必须建在**当前工作区内**（file_write 写工作区外需要用户逐次确认）。构建产物 `dist/`、`release/` 由构建脚本自动生成。

## 脚手架步骤（从模板复制起步）

先用 read_reference 读取下列模板文件，复制到工程后改写（id/name/capabilities/入口逻辑）。逐文件对应关系：

| 工程文件 | 来源（read_reference 读取后 file_write 写入） | 改写要点 |
|---|---|---|
| `manifest.json` | `hello-world.manifest.json` | 改 id/name/version/ipc/capabilities/nav |
| `package.json` | `hello-world.package.json` | 改 name；devDependencies **不要删**（构建脚本需要 require react/antd 等枚举导出生成 shim） |
| `build-plugin.mjs` | `hello-world.build-plugin.mjs` | 原样复制，无需修改 |
| `tsconfig.json` | `hello-world.tsconfig.json` | paths 深度按 SDK 实际位置调整（见"类型契约"），不用 typecheck 可删掉 paths |
| `src/main/index.ts` | `hello-world.main.ts` | 改 IPC 通道与业务逻辑 |
| `src/renderer/index.tsx` | `hello-world.renderer.tsx` | 自包含最小示例（页面组件内联），照此结构扩展 |
| `locale/zh-CN.json` | `hello-world.locale.zh-CN.json` | 扁平 key-value；manifest.nav.label 填 i18n key（如 "navLabel"） |
| `locale/en-US.json` | `hello-world.locale.en-US.json` | 同上 |

## manifest.json

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
    "icon": "<svg .../>",
    "order": 100,
    "detachable": true
  }
}
```

要点：
- `id`：小写字母开头的小写连字符，≤64 字符；**避开保留字** `settings/tasks/employees/list/invoke/event`
- `engine`：当前为 `>=0.2.0`，不满足会被禁用（不崩溃）
- `ipc`：主进程要注册的通道**短名**白名单（配合 `ctx.ipc.handle`），宿主自动加 `plugin:<id>:` 前缀
- `capabilities`：未声明的能力域对应服务为 `undefined`；**最小权限原则**，只声明实际需要的
- `nav`：只有"要有侧边栏页面"的插件才需要；纯后台插件整体省略。`label` 填 locale 文件中的 key

### 能力选型表

| 需求 | 能力域 | 入口 |
|---|---|---|
| 访问宿主数据（对话/员工/模型/记忆/设置） | `data` | `services.data.query/mutate` |
| 委派数字员工 / 调用 LLM | `execute` | `services.execute.execute` |
| 订阅/发布事件 | `events` | `services.events.subscribe/publish` |
| 在宿主界面注入组件 | `ui` | 渲染端 `views` |
| 通知/定时任务/开窗口/租借原生模块 | `system` | `services.notification/scheduler/windows/native` |
| 插件间共享数据 / 跨插件 RPC | `collaboration` | `services.shared` / `services.bus` |
| 给数字员工加 agent 工具 | —（无需声明） | `contributions.registerAgentTools` |
| 通过 MCP 对外暴露工具 | — | `contributions.registerMcpTools` |
| 关联文件类型 / 全局快捷键 / 命令 | — | `contributions.registerFileAssociations/registerGlobalShortcuts/registerCommand` |

## 主进程入口（src/main/index.ts）

```ts
import type { PluginContext, PluginMigrationContext } from '@workavatar/plugin-sdk'

// 可选：数据迁移（首次激活时原子事务执行，幂等）
export const migrations = [{
  version: '1-init-schema',
  run(mig: PluginMigrationContext) {
    const db = mig.storage.openSqlite('index')
    db.exec(`CREATE TABLE IF NOT EXISTS my_items (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()))`)
  },
}]

export function activate(ctx: PluginContext): void {
  // IPC（短名必须在 manifest.ipc 白名单内）
  ctx.ipc.handle('list-things', () => {
    const db = ctx.storage.openSqlite('index')
    return db.prepare('SELECT * FROM my_items').all()
  })
  ctx.ipc.handle('create-thing', (payload: any) => {
    const db = ctx.storage.openSqlite('index')
    db.prepare('INSERT INTO my_items (id, name) VALUES (?, ?)').run(crypto.randomUUID(), payload?.name ?? '')
    ctx.ipc.broadcast('data-changed', { ts: Date.now() })  // 推送到本插件渲染端
    return { success: true }
  })

  // 访问宿主数据（需 capabilities.data）；注意宿主不 await activate，
  // 异步调用用 .then() 处理，耗时初始化不要阻塞 activate
  ctx.services.data?.query('conversations', { limit: 5 }).then((rows) => { /* ... */ })

  // 注册 agent 工具（无需 capabilities）
  ctx.contributions.registerAgentTools([{
    id: 'my_thing_lookup', name: 'my_thing_lookup',
    title: '查询我的插件数据', description: '按关键字查询插件数据',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } } },
    handler: (args, context) => '查询结果...',
    onDemand: true,
  }])
}

export function deactivate(): void { /* 关定时器/窗口/DB 连接 */ }
```

## 渲染端入口（src/renderer/index.tsx）

最小自包含示例（完整可运行版见 `hello-world.renderer.tsx`）：

```tsx
import { useState } from 'react'
import { Button, Card, Typography } from 'antd'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'

let hostRef: PluginRendererHost | null = null

function MyPage() {
  const [message, setMessage] = useState('')
  return (
    <Card title="My Plugin" style={{ maxWidth: 480, margin: 24 }}>
      <Button onClick={async () => {
        // 调用主进程 IPC（通道短名同 manifest.ipc）
        const res = await hostRef?.bridge.invoke('list-things')
        setMessage(JSON.stringify(res))
      }}>查询</Button>
      {message && <Typography.Text>{message}</Typography.Text>}
    </Card>
  )
}

const entry: PluginRendererEntry = {
  routes: [{ path: '', component: MyPage }],          // 挂载于 /plugin/<id>/
  // UI 注入到宿主界面（需 capabilities.ui.views；不需要就删掉这行）
  views: [{ view: 'chat.toolbar', component: MyPage }],
  init(host: PluginRendererHost): void { hostRef = host }, // 路由挂载前调用一次
  dispose(): void { hostRef = null },
}
export default entry
```

约定：
- `react`/`react-dom`/`antd`/`i18next` 由宿主 `__WA_HOST__` 单例注入，**直接 import，不要安装进 dependencies、不打包**
- 页面组件**写在同一入口文件或同目录下自建**（如 `./MyPage.tsx`），不要引用模板中不存在的文件
- 主题：只用 antd token / CSS 变量，自动继承宿主明暗主题
- 文案放 `locale/zh-CN.json`、`locale/en-US.json`（扁平 key-value），渲染端 `hostRef.i18n.t('myPlugin.someKey')`

## 依赖声明约定（package.json）

| 字段 | 去向 | 示例 |
|---|---|---|
| `dependencies` | esbuild 打包进 `dist/` 随插件分发 | `dayjs`、`zustand`、`@xyflow/react` |
| `nativeDependencies` | 不打包，运行时经 `ctx.services.native.borrow()` 租借，**仅限宿主白名单**，zip 禁止携带 `.node` | `sherpa-onnx-node` |
| `devDependencies` | 仅构建期：共享库（shim 用）+ esbuild/typescript/adm-zip 等 | `antd`、`esbuild` |

## 构建与打包

```bash
npm install                        # 安装构建依赖（需网络）
node build-plugin.mjs              # 构建到 dist/
node build-plugin.mjs --zip        # 构建并产出 release/plugins/<id>-v<version>.wap
```

- 主进程 → CJS（node20）；渲染端 → ESM（共享库自动 shim，CSS 自动内联）
- `.wap` 内部为 zip 归档，**默认含源码**（`src/**` + `package.json` + `tsconfig.json`，即完整构建输入，便于在已安装插件基础上二次开发重建）；追加 `--no-source` 打包为仅含运行时必需文件（`manifest.json + dist/** + locale/** + resources/**`）的精简包
- 构建脚本会校验 `nativeDependencies` 是否在宿主白名单内（白名单文件在 SDK 的 `host-native-dependencies.json`，见"类型契约"）
- 构建失败先看报错：主进程常见是 import 了不存在的模块；渲染端常见是引用了未安装的包（非共享库的包要加进 dependencies）

## 安装交付

产出 `.wap` 后告知用户三种安装方式（效果一致）：
1. **应用内导入**：设置 → 插件 → 「导入插件」，选择 `.wap`（推荐，同 id 可覆盖升级）
2. **双击 `.wap`**：系统打开方式选 WorkAvatar，确认后安装并热重载
3. **手动放目录**：解压到 `userData/plugins/<id>/`，重启应用

安装后需**重启应用生效**（方式 2 热重载除外）。插件数据在 `userData/plugin-data/<id>/`，升级/禁用不丢数据。

**修改已安装插件（AI 二次开发）**：`.wap` 默认带源码，安装目录 `userData/plugins/<id>/` 下有完整 `src/**` + `package.json`（+ `tsconfig.json`）。找到用户要改造的插件安装目录后：`npm install`（需要网络）→ 直接修改 `src/` 与 `manifest.json` → 用 `build-plugin.mjs` 重建并重新导入覆盖升级即可。

## 类型契约（可选，用于 typecheck）

本技能目录下自带完整 SDK 类型契约：`<技能根目录>/assets/plugin-sdk/`（含 `src/`、`package.json`、`host-native-dependencies.json`）。

- **构建不需要它**：esbuild 会剥离 `import type`，最小闭环跳过本节即可
- 需要 `tsc --noEmit` 类型检查时，用 shell_exec 把它复制到插件工程旁（file 工具没有目录复制命令）：
  - Windows：`Copy-Item -Recurse "<技能根目录>/assets/plugin-sdk" "<工作区>/plugin-sdk"`
  - macOS/Linux：`cp -r "<技能根目录>/assets/plugin-sdk" "<工作区>/plugin-sdk"`
- 然后把工程 tsconfig 的 `paths` 指向实际相对位置（**注意深度**，模板里的 `../../../plugin-sdk/src` 是仓库内深度，照抄必错）：
  ```json
  "paths": {
    "@workavatar/plugin-sdk": ["../plugin-sdk/src"],
    "@workavatar/plugin-sdk/*": ["../plugin-sdk/src/*"]
  }
  ```

## 红线（必须遵守）

- 数据存储**只用** `ctx.storage.openSqlite()` 独立分库，禁止直连宿主内核主库
- **禁止**在包内携带 `.node` 原生模块（启动扫描直接拒绝）
- IPC 通道用 manifest 白名单内的短名注册，禁止尝试覆盖宿主内核通道
- 定时任务用 `ctx.services.scheduler.every/cron`，禁止裸开 `setInterval`
- 共享库（react/antd/i18next）不安装进 dependencies、不打包，构建脚本自动 shim
- 宿主不 await `activate`：耗时初始化放后台/scheduler，不要阻塞 activate
- 每次改完 manifest 结构或 capabilities 后提醒用户：插件变更需重启应用生效

## 参考资料（用 read_reference 工具按需读取）

- `PROTOCOL.md` — 完整协议规范（包结构/生命周期/能力域/依赖/安全边界）
- `API_REFERENCE.md` — ctx 全部接口签名（data/execute/events/system/contributions/渲染端）
- `CAPABILITY_MATRIX.md` — 能力域 × 实体 × 安全级别 × 示例插件矩阵
- `hello-world.PLUGIN_DEVELOPMENT.md` — 从零开始的完整开发与打包教程（细节疑惑优先查此文档）
- `hello-world.manifest.json` / `hello-world.main.ts` / `hello-world.renderer.tsx` — 最小可运行模板源码
- `hello-world.build-plugin.mjs` — 构建脚本（脚手架时原样复制此文件）
- `hello-world.package.json` / `hello-world.tsconfig.json` — 模板工程配置
- `hello-world.locale.zh-CN.json` / `hello-world.locale.en-US.json` — 多语言文案示例

**建议**：脚手架前先通读 `hello-world.PLUGIN_DEVELOPMENT.md`；写主进程逻辑拿不准 ctx 接口时查 `API_REFERENCE.md`；能力拿不准能不能声明时查 `CAPABILITY_MATRIX.md`。
