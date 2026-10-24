<div align="center">

# WorkAvatar

### 能自己动手干活的 AI 数字员工，跑在你自己的电脑上。

WorkAvatar 是一个开源的 AI 智能体桌面应用。你可以创建自己的数字员工：它有固定的角色、模型和工具集，能自己规划步骤、调用工具、读写本地文件，最后把结果交给你。笔记、日历、语音识别、自动化、模板任务和 AI 网页聚合都以插件形式提供，可以单独关掉，也可以换成自己写的。

[![Stars](https://img.shields.io/github/stars/zengzag/WorkAvatar?style=flat-square&color=yellow)](https://github.com/zengzag/WorkAvatar/stargazers)
[![Release](https://img.shields.io/github/v/release/zengzag/WorkAvatar?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![Downloads](https://img.shields.io/github/downloads/zengzag/WorkAvatar/total?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0aa?style=flat-square)](#快速上手)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](#参与贡献)

[**下载 Windows 版**](https://github.com/zengzag/WorkAvatar/releases/latest) · [主要特点](#主要特点) · [功能](#功能) · [插件开发](plugin-sdk/PROTOCOL.md) · [从源码构建](#从源码构建)

[English](README.md) | **简体中文**

<img src="images/agent-chat.gif" alt="数字员工规划任务、读取文件并写出结果" width="92%" />

</div>

---

## 主要特点

WorkAvatar 的重心不在聊天，而在让 AI 在你的电脑上真正做事：读文件、写文件、执行命令、查资料。为此做了几件具体的事情：

- **资料留在本地。** 文档解析、分词、索引和检索都在本机完成。只有任务实际需要的文件内容，才会发给你配置的模型服务。
- **命令跑在系统沙箱里。** Windows 使用受限令牌加目录 ACL，macOS 使用 Seatbelt。读取不受限制，写入只能落在任务工作区和私有临时目录；越界写入会被内核拒绝，命令直接失败。
- **功能以插件形式交付。** 笔记、日历、语音识别、自动化、模板任务、AI 网页聚合都是独立插件，可以单独启停、删除或替换，改动即时生效，不需要重启。
- **资料库加进来就能搜。** 关键词检索不用等向量化完成；向量、摘要和知识卡片在后台只为你常用的文件生成。

---

## 功能

### 数字员工

每个员工有独立的角色指令、默认模型、工具集和记忆。你描述任务，它自己规划步骤、调用工具，整个过程显示在对话里：在做什么、打开了哪个文件、写了什么、在哪里出错。

<img src="images/employees.png" alt="数字员工管理" width="92%" />

- **工具** — 文件读写、编辑、复制、删除，Shell 命令，网页搜索（本地浏览器或 DeepSeek / Tavily / Brave API），图片识别，Word / Excel / PPT 文档生成。工具可以按员工单独配置，也可以接入外部 MCP 服务。
- **子任务委托** — 把工作拆成子任务交给其他员工，可并行也可顺序，最多两层。每个子任务在独立工作区运行，只把结果摘要交回，主员工的上下文不会被过程细节占满。内置 `explore`（只读检索）和 `general`（全能力执行）两个子智能体角色。
- **记忆与技能** — 跨任务记忆保留你的偏好和之前踩过的坑；Skills 用 Markdown 定义专项能力，按需加载。内置知识搜索助手和插件开发助手。
- **文件权限** — 文件工具在任务工作区内自由读写。工作区之外，或涉及 `.env`、私钥、`.git` 这类敏感文件时，会先弹出确认并给出变更 diff。产物用 `file_copy` 交付到指定位置，文件和整个文件夹都只需授权一次。确实需要写全局位置时（比如安装共享库），命令可以带 `full_access` 针对本次申请，确认后才会执行；如果整个任务都无法在工作区内完成，模型可用 `task_full_access` 申请本轮任务的完整访问，批准后本任务不再受沙箱限制（敏感文件与删除仍逐次确认），也可随时在执行模式按钮切回手动审批。

### 本地资料库

<img src="images/kms-search.gif" alt="跨本地文档的混合检索" width="92%" />

把文件夹加入资料库，员工就能直接搜到里面的项目资料、合同、报告和会议纪要。

- **混合检索** — 全文关键词、语义向量、文件名匹配三条路径并行，再合并成统一排序。可以在混合 / 关键词 / 语义 / 文件名四种模式间切换，也可以按文件类型、时间范围、目录或合集过滤。
- **渐进式增强** — 经常打开或被命中的文件，会在后台补上段落摘要、向量和知识卡片；冷门文件保持轻量索引，开销随实际使用量增长。
- **合集** — 把主题相关的文件归为一组，自动生成摘要和目录，既能按主题浏览，也能作为上下文交给员工。
- **可以离线** — 解析、分词、索引和搜索都在本地。模型服务不可用时，关键词检索照常工作。支持 PDF、Word、Excel、PPT、Markdown、纯文本、HTML，以及经本地 OCR 处理的图片。
- **内置 MCP 服务** — 在 `127.0.0.1` 上把检索能力开放给本机其他 MCP 客户端，访问需要令牌。

### 插件生态

<img src="images/plugins.gif" alt="启用与管理插件" width="92%" />

插件可以在应用里添加导航页、设置项、聊天工具栏、Agent 工具、MCP 工具和快捷键，也可以提供自己的数字员工。插件自动跟随应用的明暗主题和语言，数据存放在独立的 SQLite 库里；启用、禁用、导入、删除、升级都在设置页完成，不用重启。

应用内置**插件开发助手**，可以让数字员工在应用内帮你写完一个插件并安装。分享出去的插件包是 `.wap` 格式。

| 插件 | 它能做什么 |
|------|------|
| **笔记** | Markdown 笔记直接存成 `.md`，同步服务和其他编辑器都能直接用。文件树、编辑器、大纲三栏，支持分屏预览和全文检索。 |
| **日历 & 待办** | 月 / 周 / 日视图，支持重复事件和提醒，可选单向同步 Outlook。员工可以按你的要求创建和修改事件。 |
| **语音识别** | 基于 sherpa-onnx 的离线识别，录音时显示实时字幕和浮窗字幕，录音结束后自动生成会议纪要。 |
| **自动化** | 按日 / 周 / 月定时运行员工任务，失败自动重试，完成后通知。每次运行都能追溯回对应会话。 |
| **模板任务** | 在画布上搭建多步工作流，支持智能体、评审、条件、循环、并行、人工节点，带通过 / 不通过判定和轮次控制。内置模板设计助手，能把一段需求描述变成可运行的模板。 |
| **AI 助手聚合页** | 把豆包、DeepSeek 等第三方 AI 网站内嵌进应用，支持单页、双页、标签页布局，各站点登录态隔离；也可以添加任意 HTTPS 网页。使用受对应网站的服务条款约束。 |
| **生图工作室** | 为 PPT 配图、科研配图与架构/流程图设计：内置 PPT 配图 / 封面、科研示意图、论文插图、数据图表、信息图、架构图、流程图、学术海报等场景预设，自动处理比例、留白、配色、无文字约束，并支持 AI 提示词优化；接入火山 Seedream、千问 Image 与 OpenAI GPT Image，支持透明背景、参考图与标题排版。作品自动落盘，数字员工也能直接调用生图工具。 |

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="笔记" width="100%" /></td>
    <td><img src="images/calendar.png" alt="日历 & 待办" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="语音识别" width="100%" /></td>
    <td><img src="images/automation.png" alt="自动化" width="100%" /></td>
  </tr><tr>
    <td colspan="2"><img src="images/workflow.png" alt="模板任务画布" width="100%" /></td>
  </tr></table>
</div>

---

## 快速上手

### 安装应用

从 [Releases](https://github.com/zengzag/WorkAvatar/releases/latest) 下载最新版本（Windows 10/11 安装包）。macOS 请[从源码构建](#从源码构建)。

首次启动会有一个引导向导，带你配置模型服务、创建第一个员工、把文件夹加进资料库。也可以跳过，之后在「设置 → 通用」里重新运行。

### 第一次使用

1. **添加资料库** — 在「资料库 → 文档管理」里添加文件夹，索引会自动建立并持续同步。
2. **搜一下** — 在顶部搜索框输入关键词，按需切换混合 / 关键词 / 语义 / 文件名模式。
3. **交一个任务** — 进入「数字员工」，选一个员工（或新建），描述任务。它会按需检索资料库，把产出写进任务的独立工作区；点任务右上角的侧边栏按钮，可以查看工作区文件、打开终端、就地预览产物。

### 从源码构建

**要求：** Windows 10/11 或 macOS、Node.js 24+、npm 11+。

```bash
git clone --recurse-submodules https://github.com/zengzag/WorkAvatar.git
cd WorkAvatar
npm install
npm run dev        # 开发模式
npm run build      # 生产构建
```

已经克隆过的话，用 `git submodule update --init --recursive` 拉取插件源码。

> Electron 42 起不再在 `npm install` 时下载二进制，首次运行 `npm run dev`（或 `npx install-electron`）时才按需下载。网络受限时可以保留仓库 `.npmrc` 里的 `electron_mirror`，或自行设置环境变量 `ELECTRON_MIRROR`。

---

## 适合哪些场景

| 场景 | WorkAvatar 怎么做 |
|------|------|
| **本地文档工作** | 合同比对、报告起草、项目调研，直接在你自己的文件夹上做，不用先把资料传到网盘。 |
| **长期使用的团队员工** | 角色、工具和记忆都固定下来，团队可以反复把同类工作交给它。 |
| **定时后台任务** | 每天自动生成晨报、每周汇总，结果写回对应会话。 |
| **把检索开放出去** | 通过内置 MCP 服务，让本机其他 AI 客户端也能搜你的文档。 |
| **内部工具插件** | 把内部流程打包成插件，带上导航页、设置项和 Agent 工具。 |

---

## 界面设计

2026 视觉方向为「精密灰阶 + 轻微液态玻璃」：信息密度优先，玻璃质感只用于标题栏、侧边导航、任务列表、输入区与工作区等壳层，内容区保持实色以保证长文与表格的可读性。

- 语义令牌集中在 `src/styles/theme.css`（`--wa-*`），明暗两套一一对应；antd 主题在 `src/main.tsx` 统一注入
- 保留明 / 暗 / 跟随系统、4 档字号、中英双语与 `prefers-reduced-motion` 降级
- 新增页面请复用语义变量或 antd token，不要引入硬编码色值

---

## 插件开发

一个插件就是一个文件夹：`manifest.json`、CommonJS 主进程入口、可选的 ESM 渲染端入口和语言文件。能力需要显式声明，宿主会在调用时检查，未声明的服务拿不到。

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "engine": ">=0.2.0",
  "main": "dist/main/index.cjs",
  "renderer": "dist/renderer/index.js",
  "ipc": ["list-things"],
  "capabilities": [
    { "domain": "data", "entities": ["conversations"], "access": "read" },
    { "domain": "execute", "kinds": ["llm-chat"] },
    { "domain": "ui", "views": ["chat.toolbar", "settings.tab"] }
  ]
}
```

```ts
import type { PluginContext } from '@workavatar/plugin-sdk'

export async function activate(ctx: PluginContext): Promise<void> {
  ctx.ipc.handle('list-things', () => ctx.storage.openSqlite('index').prepare('SELECT * FROM things').all())

  ctx.contributions.registerAgentTools([{
    id: 'my_thing_lookup',
    name: 'my_thing_lookup',
    title: '查询插件数据',
    description: '按关键字查询插件数据',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } } },
    handler: (args) => `查询 ${args.keyword} 的结果`,
    onDemand: true,
  }])
}
```

- 协议规范：[plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- API 参考：[plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- 能力矩阵：[plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- 开发打包教程：[plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- 最小示例：[plugins/examples/hello-world/](plugins/examples/hello-world/)

插件里的 React、ReactDOM、antd、i18next 由宿主通过 `__WA_HOST__` 注入，不需要自己安装，也不会出现多个 React 实例的问题。

---

## 架构

WorkAvatar 基于 Electron，智能体运行时、界面和插件宿主分别放在不同层。

- **主进程** — 智能体运行时（规划、工具执行、委托）、模型供应商、资料库（SQLite FTS5 + sqlite-vec）、文件权限服务和 Shell 沙箱。
- **渲染端** — React 19 和 Ant Design 界面、流式对话状态，插件页面通过 `plugin://` 协议加载。
- **插件** — 每个插件独立的 SQLite 库、显式能力声明、`plugin:<id>:` IPC 命名空间，启停不需要重启。
- **模型** — 支持 OpenAI、Azure、DeepSeek、通义千问、智谱、火山引擎、小米、LM Studio 以及任意 OpenAI 兼容端点，接口协议支持 Chat Completions、Responses 和 Anthropic Messages。

| 分类 | 技术 |
|------|------|
| 运行时 | Electron 44 |
| 前端 | React 19 + TypeScript 7 + Ant Design 6，Vite 8 |
| 本地数据库 | SQLite（FTS5 全文 + sqlite-vec 向量） |
| 文档解析 | PDF、Word、Excel、PPT、HTML、OCR（PaddleOCR） |
| 语音识别 | sherpa-onnx（离线） |
| 国际化 | i18next（中英文） |

> 内置插件源码位于独立仓库 `WorkAvatar-Plugins`，以 `plugins/` git 子模块引入；`plugin-sdk/` 维护在本仓库。

---

## 常见问题

**数据会不会离开我的电脑？**
索引和检索不会。任务只会把模型需要的上下文发给你配置的供应商，工作区始终在本地。

**能用本地模型吗？**
可以。把供应商指向 LM Studio 或任意 OpenAI 兼容的本地服务即可。即使完全不接模型，关键词检索也能用。

**有 macOS / Linux 版吗？**
macOS 目前需要从源码构建；Linux 暂未打包。

**会不会改坏我的文件？**
Shell 命令受操作系统沙箱约束，工作区外的写入会被拒绝。文件工具在目标位于工作区外或属于敏感文件时，会给出 diff 并要求确认。

**怎么发布自己的插件？**
先看[协议规范](plugin-sdk/PROTOCOL.md)，从 [hello-world](plugins/examples/hello-world/) 起步，或者让内置插件开发助手帮你搭脚手架。打成 `.wap` 包就可以分发。

---

## 参与贡献

欢迎提 Issue 和 PR。带复现步骤和截图的 bug 报告通常修得最快。

```bash
npm run test      # 核心测试
npm run test:all  # 核心 + 插件测试
```

插件、翻译、文档和示例模板同样欢迎。

如果 WorkAvatar 对你有帮助，欢迎点个 Star。

---

## 许可证

[MIT License](LICENSE)

文中提及的第三方产品名称与商标归各自所有者所有，仅作标识用途。
