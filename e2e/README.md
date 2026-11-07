# WorkAvatar UI 端到端自动化测试

面向真实用户操作路径的 Electron UI 自动化测试体系。测试直接启动构建后的桌面应用，
通过点击、输入、页面跳转、窗口渲染来验证可用性与稳定性，而不是只调用接口。

> 定位：E2E 套件是**验收层**，覆盖核心用户旅程；`tests/unit` 保留为**快速回归层**，
> 负责算法、纯函数与危险边界的高密度校验。两层互补，提交前跑单测、合并前跑 E2E。

## 技术栈

| 能力 | 选型 |
| --- | --- |
| 测试框架 / 断言 / 报告 | `@playwright/test` |
| 桌面应用驱动 | Playwright Electron（`_electron.launch`） |
| 模型依赖 | 本地 OpenAI 兼容 Mock LLM（真实 SSE + 工具调用协议） |
| 数据隔离 | 每个测试独立 `WORKAVATAR_DATA_DIR` 与 Electron `userData` |
| 执行模型 | 串行（Electron 单实例锁 + 原生模块约束） |

## 目录结构

```
e2e/
├─ playwright.config.ts        # 超时、重试、报告、产物目录
├─ tsconfig.json               # 仅类型检查（npm run test:e2e:typecheck）
├─ fixtures/
│  ├─ app.fixture.ts           # 启动 Electron、独立数据目录、失败日志附加
│  └─ mock-llm-server.ts       # OpenAI 兼容 Mock（SSE / 工具调用 / 错误注入）
├─ support/
│  ├─ env.ts                   # 构建产物校验与路径常量
│  ├─ seed.ts                  # 通过真实 IPC 写入测试前置数据
│  └─ waits.ts                 # 应用启动/路由等待
├─ pages/                      # 页面对象（POM），只暴露用户行为
│  ├─ app-shell.page.ts        # 左侧导航与路由
│  ├─ tasks.page.ts            # 任务对话（发送、停止、队列、消息操作、侧栏、工作区、权限、委派）
│  ├─ employees.page.ts        # 员工列表、创建、编辑、删除
│  ├─ settings.page.ts         # 模型供应商、外观、插件管理
│  └─ onboarding.page.ts       # 新用户引导
└─ tests/
   ├─ smoke.spec.ts            # 启动与最小对话闭环
   ├─ onboarding.spec.ts       # 引导正常/边界/异常
   ├─ employees.spec.ts        # 员工全生命周期
   ├─ tasks.spec.ts            # 对话、流式、停止、队列（编辑/删除/立即发送）、工具、重试、纯对话、多任务切换
   ├─ tasks-messages.spec.ts   # 复制/删除、自动标题、重新生成分支、编辑重发、切换模型、思考/Token/上下文、压缩
   ├─ tasks-sidebar.spec.ts    # 重命名、标题/全文搜索、分组视图、导出、右键删除、批量删除
   ├─ tasks-workspace.spec.ts  # 工作区文件树/预览、终端、权限确认（允许/拒绝/完全允许）
   ├─ tasks-delegation.spec.ts # 员工委派、委托卡与子任务抽屉
   ├─ tasks-attachments.spec.ts# 图片多模态、普通文件路径令牌
   ├─ settings.spec.ts         # 供应商、主题/语言、插件启停
   ├─ kms.spec.ts              # 资料库索引与关键词检索
   └─ plugins-*.spec.ts        # 笔记 / 日历 / 自动化插件
```

## 运行方式

```bash
# 1. 安装依赖（首次）
npm install

# 2. 构建 E2E 运行产物（主进程 + preload + 渲染端 + 全部插件）
npm run build:e2e

# 3. 执行
npm run test:e2e            # 全部用例
npm run test:e2e -- tasks   # 只跑文件名包含 tasks 的用例
npm run test:e2e:debug      # 逐步调试
npm run test:e2e:typecheck  # 测试代码类型检查
npm run test:e2e:report     # 打开 HTML 报告

# 一键：构建 + 执行（CI / 发布前）
npm run test:e2e:ci
```

Electron 由 Playwright 直接驱动，无需执行 `playwright install` 下载浏览器。
Linux CI 需要提供显示环境：`xvfb-run -a npm run test:e2e:ci`；Windows / macOS 可直接运行。

产物位置：

- HTML 报告：`e2e/report/html`
- JSON / JUnit：`e2e/report/results.json`、`e2e/report/junit.xml`
- 失败截图、trace、渲染端错误日志：`e2e/report/test-results/<用例>/`

## 设计要点

### 1. 每个测试一个独立应用实例

`app.fixture.ts` 为每个测试创建独立临时数据目录，并注入：

- `WORKAVATAR_E2E=1`：加载已构建产物而不是 dev server，并关闭 DevTools
- `WORKAVATAR_DATA_DIR=<临时目录>`：主库、插件库、附件、工作区全部隔离

Electron 默认 `userData` 也指向该临时目录，测试之间互不污染，也不会读写用户的真实数据。

### 2. Mock LLM 保持真实协议

`mock-llm-server.ts` 实现了 OpenAI `chat/completions` 的 SSE 流式响应、
`GET /models` 连通性探测、`/embeddings` 兜底，以及工具调用往返。
在用户消息中写入标记即可触发场景：

| 标记 | 行为 |
| --- | --- |
| `[[tool:file_list]]` | 先返回 tool_call，工具结果回传后返回最终文本 |
| `[[tool:file_write]]` | 写工作区外文件 `../e2e-permission.txt`，触发权限确认 |
| `[[tool:file_write_local]]` | 写工作区内 `e2e-artifact.txt`，用于文件树预览 |
| `[[tool:delegate:<employeeId>]]` | 委派给指定员工，验证委托卡与子任务抽屉 |
| `[[thinking]]` | 返回 reasoning_content 流，验证思考段 |
| `[[http-error]]` | 返回 500，用于验证错误提示与重试入口 |
| `[[slow-stream]]` | 逐字慢速输出，用于验证停止生成与发送队列 |
| 无标记 | 返回包含 `E2E 回复` 的普通文本 |

自动标题请求由系统提示词中的 `conversation title generator` 识别并返回固定标题 `E2E 自动标题`；
pi-ai 的聚合式 `chat()` 同样以 `stream:true` 发起，因此不能依赖 `stream` 标记区分。
`failNext(n)` 只让真实对话流式请求失败，不会提前消费自动标题等系统请求的失败配额。

### 3. 前置数据走真实 IPC

`support/seed.ts` 通过渲染端 `window.electronAPI` 创建供应商、默认模型与员工，
再 `reload` 让语言/主题/路由按持久化配置生效。这样数据库结构变更时测试会明确失败，
而不是依赖直写 SQLite 的脆弱种子脚本。

### 4. 选择器规范

- 优先 `data-testid`、`data-nav-key`、`data-task-id` 等稳定语义属性
- 禁止 `nth-child`、坐标点击、绝对 DOM 层级
- 文本选择器只用于用户可见文案断言；涉及多语言时先固定 `locale: 'en-US'`
- 每个页面对象只暴露“用户能做的事”，不暴露 DOM 细节

### 5. 串行执行

Electron 单实例锁、SQLite、ONNX 运行时不支持同机并发。默认 `workers: 1`；
如需并行，必须按 worker 拆分数据目录并确认所有原生资源可并发。

## 覆盖矩阵

| 模块 | 正常流程 | 边界 / 异常 |
| --- | --- | --- |
| 启动与路由 | 首次启动进引导、已完成引导进任务页 | — |
| 新用户引导 | 配置模型 → 创建员工 → 进入任务 | 必填校验、不可达地址、跳过引导 |
| 数字员工 | 列表、搜索、向导创建、改名、删除 | 无匹配结果、创建后即时刷新 |
| 任务对话 | 流式回复、列表回看、多任务切换、新建任务选择员工/模型、自动标题 | 停止生成、模型失败原地重试、纯对话冻结 |
| 发送队列 | 排队后自动续发、立即发送（中断当前回复） | 内联编辑、删除排队项 |
| 消息操作 | 复制、重新生成并切换分支、编辑用户消息重发、切换模型重生成、压缩上下文 | 删除消息、失败重试 |
| 任务侧栏 | 重命名、标题搜索、全文搜索、员工/工作区分组、导出 Markdown | 无匹配结果、右键删除、多选批量删除 |
| 工作区 | 文件树预览产物、终端执行命令 | 工作区外写入确认（允许/拒绝）、完全允许模式免确认 |
| 委派 | 主管委派子员工、委托卡状态、子任务抽屉 | — |
| 附件 | 图片多模态消息、普通文件路径令牌 | — |
| 上下文 | 思考段、Token 用量、上下文占用、压缩摘要 | — |
| 设置 | 供应商增删/连通性、主题与语言持久化、插件启停 | 重新运行引导 |
| 本地资料库 | 建索引后关键词检索命中 | 空状态、设置抽屉 |
| 插件 | 笔记创建编辑保存、日历日程/待办、自动化任务 | — |

## 新增用例指南

1. 在 `pages/` 补充页面对象方法，保持“行为级”命名（如 `sendMessage`、`togglePlugin`）。
2. 在 `tests/` 新建 `*.spec.ts`，用 `app.fixture` 的 `app`：
   ```ts
   import { expect, test } from '../fixtures/app.fixture'
   import { TasksPage } from '../pages/tasks.page'

   test('示例：发送消息', async ({ app }) => {
     await app.seed({ employee: { name: 'E2E 助手' }, locale: 'en-US' })
     const tasks = new TasksPage(app.window)
     await tasks.expectReady()
     await tasks.send('你好')
     await tasks.waitForReplyContains('E2E 回复')
   })
   ```
3. 断言用户可观察结果（文案、可见状态、列表变化），不要断言内部实现。
4. 需要新的稳定定位点时，在组件上加 `data-testid`，命名遵循 `模块-元素`，例如
   `task-sidebar-new`、`employee-settings-save`。

## 排障

- **提示缺少构建产物**：先执行 `npm run build:e2e`
- **窗口空白 / 插件未加载**：E2E 以 `electron.exe` 直接拉起主进程时 Electron 会判定
  `app.isPackaged=true`，运行时已通过 `WORKAVATAR_E2E` 恢复开发态资源解析与插件扫描
- **流式回复一直“生成中”**：检查 Mock SSE 是否在 `finish_reason` 后发送 `[DONE]` 并结束响应
- **失败排查**：打开 `trace.zip`（`npx playwright show-trace <path>`），
  失败时 fixture 会自动附加渲染端 `pageerror` / `console.error` 日志

## 已知边界

- 不评估真实模型输出质量，只验证 UI 与协议行为
- 不自动操作系统原生文件对话框（目录选择、导入导出），相关能力通过 IPC 前置数据覆盖
- Electron 下 Playwright 不派发页面级 `download` 事件：导出 Markdown 用例改为拦截
  `a[download]` 读取 Blob 内容，仍然执行真实的导出处理函数
- 托盘、系统通知、多显示器、独立弹窗的窗口管理不在当前 E2E 范围

## 本次 E2E 建设中发现并修复的问题

- 笔记插件空库创建首个笔记时，`rc-tree` 首次挂载 `listRef` 未就绪导致 `scrollTo` 未捕获异常；
  通过避免按钮抢焦点 + 树空→非空短窗口焦点守卫修复
- E2E 以 `electron.exe` 拉起主进程时 `app.isPackaged` 为 true，导致插件不扫描、资源目录错误；
  增加 `WORKAVATAR_E2E` 运行态判定，保持开发态资源与插件加载行为
- Mock LLM 在 HTTP keep-alive 下把请求体读完误判为连接关闭，导致永不发送 `finish_reason`；
  改为监听响应侧关闭
- 自动标题请求实际走流式聚合，原 Mock 按非流式识别导致标题被回复文本覆盖；改为按系统提示词识别
- 工具业务失败（权限被拒、命令失败）时，前端展示值误用协议成功标记，导致界面显示为成功且无错误原因；
  `pi-agent-adapter` 改为按业务 `result.success` 选择 output/error，`isError` 仍保留协议语义供历史回放
