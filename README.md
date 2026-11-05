<div align="center">

# WorkAvatar

### 一个能在你自己电脑上干活的 AI 数字员工

创建一个数字员工：给它角色、模型和工具。它自己拆解任务、调用工具、读写本地文件、跑命令，最后把结果交给你。笔记、日历、语音识别、自动化、模板任务、生图等能力以插件形式提供，可以按需安装。

[![Stars](https://img.shields.io/github/stars/zengzag/WorkAvatar?style=flat-square&color=yellow)](https://github.com/zengzag/WorkAvatar/stargazers)
[![Release](https://img.shields.io/github/v/release/zengzag/WorkAvatar?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![Downloads](https://img.shields.io/github/downloads/zengzag/WorkAvatar/total?style=flat-square)](https://github.com/zengzag/WorkAvatar/releases)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0aa?style=flat-square)](#安装)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](#参与贡献)

[**下载**](https://github.com/zengzag/WorkAvatar/releases/latest) · [主要特点](#主要特点) · [功能](#功能) · [插件](#插件) · [从源码构建](#从源码构建)

**简体中文** | [English](README.en.md)

<img src="images/agent-chat.gif" alt="数字员工拆解任务、检索本地资料、读取文件并写出结果" width="86%" />

</div>

---

## 主要特点

- **资料留在本地。** 文档解析、分词、索引和检索都在本机完成，关键词检索在模型服务不可用时照常工作。只有任务实际需要的文件内容，才会发给你配置的模型服务。
- **命令跑在系统沙箱里。** 可读全盘，写入只能落在任务工作区和私有临时目录；越界写入由内核拒绝，命令直接失败，而不是靠对命令文本做静态分析去猜。
- **资料库加进来就能搜。** 不用等向量化：加完文件夹，关键词检索立刻可用；向量、段落摘要和知识卡片在后台只为你真正用到的文件生成。
- **数字员工是长期的。** 角色、工具、记忆固定下来，任务产物留在各自的工作区；员工可以导出、在另一台机器上导入后接着用。
- **轻量可扩展。** 支持安装插件，桌面端已内置笔记、日历、语音、自动化、模板任务、生图等十来个可选插件（见[插件](#插件)）；也能用画布把多步流程搭成模板任务。

---

## 功能

### 数字员工

每个员工有独立的角色指令、默认模型、工具集和记忆。你描述任务，它自己规划步骤、调用工具，整个过程显示在对话里：在做什么、打开了哪个文件、写了什么、在哪里出错。

<img src="images/employees.png" alt="数字员工管理" width="86%" />

- **工具** — 文件读写 / 编辑 / 复制 / 删除、Shell 命令（含后台长时任务）、网页搜索与抓取、图片识别、本地 OCR、生成 Word / Excel / PowerPoint、检索资料库与历史会话。工具可以按员工单独配置，也能接入外部 MCP 服务。
- **子任务委托** — 把工作拆给其他员工或临时角色，最多 5 个并行、两层深度。每个子任务在独立工作区运行，只回传结果摘要，主员工的上下文不会被过程细节占满。内置 `explore`（只读检索）和 `general`（全能力执行）两个子智能体角色。
- **记忆与技能** — 跨任务记忆保留你的偏好和此前踩过的坑；Skills 用 Markdown 定义专项能力，按需加载，不占用常驻上下文。内置知识搜索助手。
- **文件权限** — 文件工具默认只能自由读写当前任务的工作区，其余位置的读写会先征求你的确认。任务确实需要更大范围时，助手会主动提出申请，你可以在弹窗里选择一次性允许、当前任务允许或切换执行模式；删除等不可逆操作仍会逐次确认。
- **可导出的员工** — 员工的人设、工具、技能和相关配置可以打包导出，在另一台机器上导入后接着用。

### 桌面小秘书

桌面上常驻一只小挂件（默认关闭，在「设置 → 小秘书」或托盘菜单开启），一句话就能派活：选员工、写一句话，任务在后台静默跑起来，并立即出现在任务列表里，点开就能看。开启后 `Ctrl+Alt+Space` 随时唤出，尺寸、免打扰和隐藏都在「设置 → 小秘书」里。

### 本地资料库

<img src="images/kms-search.gif" alt="跨本地文档的混合检索" width="86%" />

把文件夹加入资料库，员工就能直接搜到里面的项目资料、合同、报告和会议纪要。

- **混合检索** — 全文关键词、语义向量、文件名匹配三条路径并行，再合并成统一排序；可在混合 / 关键词 / 语义 / 文件名之间切换，并按文件类型、时间范围、目录或合集过滤。
- **Everything 加速（可选）** — Windows 上可将「文件名」搜索切到 Everything，启用其 HTTP 服务器后结果实时、无需维护目录元数据；服务不可用时自动回退内置搜索。
- **渐进式增强** — 经常打开或被命中的文件，会在后台补上段落摘要、向量和知识卡片，并支持知识卡片页；冷门文件保持轻量索引。
- **合集** — 把主题相关的文件归为一组，自动生成摘要和目录，既能按主题浏览，也能作为上下文交给员工。
- **支持的格式** — PDF、Word、Excel、CSV、PPT、Markdown、纯文本、HTML，以及经本地 OCR 处理的图片。
- **内置 MCP 服务** — 在 `127.0.0.1` 上把检索能力开放给本机其他 MCP 客户端，访问需要令牌。

### 插件

应用内置了一批可选插件，可在「设置 → 插件」里导入、启用、禁用或删除，改动即时生效、不用重启：

| 插件 | 它能做什么 |
|------|------|
| **笔记** | Markdown 笔记直接存成 `.md`，文件树、编辑器、大纲三栏，支持多标签与全文检索。 |
| **日历 & 待办** | 月 / 周 / 日视图，重复事件、提醒和可选单向同步 Outlook；员工可以按你的要求创建和修改日程。 |
| **语音识别** | 基于 sherpa-onnx 的离线识别，边录边转写，录音结束后生成会议纪要。 |
| **自动化** | 按日 / 工作日 / 周 / 月 / 年定时运行员工任务，失败自动重试并通知。 |
| **模板任务** | 在画布上搭建多步工作流，含评审、条件、循环、并行和人工节点；评审不通过可回退重跑。 |
| **生图工作室** | 为 PPT 配图、科研配图与架构 / 流程图设计，内置场景预设与提示词优化，接入火山 Seedream、千问 Image 与 OpenAI GPT Image。 |
| **数据模型** | 表 / 字段 / 关系的可视化建模，支持 DBML 导入导出。 |
| **Word 编辑器** | docx 导入、富文本编辑、AI 对话改稿与版本快照，导出 docx / PDF。 |
| **技能合集** | 深度研究、draw.io 架构图、科研绘图提示词、答辩 PPT 等技能，按需分配给员工。 |
| **AI 助手集** | 把豆包、DeepSeek 等第三方 AI 网站内嵌进应用，各站点登录态隔离。使用受对应网站的服务条款约束。 |

插件还能贡献导航页、设置项、Agent 工具、MCP 工具和快捷键，也可以提供自己的数字员工。想自己写一个？见[插件开发](#插件开发)，或让内置的插件开发助手在应用内帮你搭。

<img src="images/plugins.gif" alt="启用与管理插件" width="86%" />

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="笔记" width="100%" /></td>
    <td><img src="images/calendar.png" alt="日历 & 待办" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="语音识别与会议纪要" width="100%" /></td>
    <td><img src="images/automation.png" alt="自动化任务" width="100%" /></td>
  </tr><tr>
    <td><img src="images/workflow.gif" alt="模板任务" width="100%" /></td>
    <td><img src="images/image-studio.gif" alt="生图" width="100%" /></td>
  </tr></table>
</div>

---

## 快速上手

### 安装

从 [Releases](https://github.com/zengzag/WorkAvatar/releases/latest) 下载对应平台的安装包：Windows、macOS（Intel / Apple 芯片按需选择）。Linux 可[从源码构建](#从源码构建)。

首次启动会有一个引导向导，带你配置模型服务并创建第一个员工；也可以跳过，之后在「设置 → 通用」里重新运行。

### 三步开始干活

1. **添加资料库** — 在「资料库 → 文档管理」里添加文件夹，索引会自动建立并持续同步。
2. **搜一下** — 在顶部搜索框输入关键词，按需切换混合 / 关键词 / 语义 / 文件名模式。
3. **交一个任务** — 进入「数字员工」，选一个员工（或新建），描述任务。它会按需检索资料库，把产出写进任务的独立工作区；点任务右上角的侧边栏按钮，可以查看工作区文件、打开终端、就地预览产物。

> 想一直挂在桌面上，就从任务列表的头部唤出**桌面小秘书**，一句话派活。

### 从源码构建

**要求：** Windows、macOS 或 Linux，Node.js 24+、npm 11+。

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
| **长期使用的团队员工** | 角色、工具和记忆都固定下来，团队可以反复把同类工作交给它；换台电脑导出导入即可延续。 |
| **定时后台任务** | 每天自动生成晨报、每周汇总，结果写回对应会话并通知你。 |
| **多步且要过审的流程** | 用模板任务搭成「撰写 → 评审 → 不通过就打回重写」的流水线，多轮迭代直到通过。 |
| **把检索开放出去** | 通过内置 MCP 服务，让本机其他 AI 客户端也能搜你的文档。 |
| **内部工具插件** | 把内部流程做成插件，挂到应用里带自己的导航页和工具。 |

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

插件里的 React、ReactDOM、antd、i18next 由宿主通过 `__WA_HOST__` 注入，不需要自己安装，也不会出现多个 React 实例的问题。懒得自己敲？让内置的插件开发助手在应用里帮你搭。

---

## 架构

WorkAvatar 基于 Electron，智能体运行时、界面和插件宿主分处不同层。

- **主进程** — 智能体运行时（规划、工具执行、委托）、模型供应商、资料库（SQLite + 向量检索）、文件权限服务与 Shell 沙箱。
- **渲染端** — React 界面与流式对话；插件页面通过 `plugin://` 协议加载。
- **插件** — 每个插件独立的 SQLite 库和显式能力声明，启停不需要重启。
- **模型** — 支持国内外主流厂商、LM Studio 及任意 OpenAI 兼容端点。

| 分类 | 技术 |
|------|------|
| 运行时 | Electron 44 |
| 前端 | React 19 + TypeScript + Ant Design 6，Vite 8 |
| 本地数据库 | SQLite（FTS5 全文 + sqlite-vec 向量） |
| 文档解析 | PDF、Word、Excel、PPT、HTML、OCR（PaddleOCR） |
| 语音识别 | sherpa-onnx（离线） |

> 内置插件源码位于独立仓库 `WorkAvatar-Plugins`，以 `plugins/` git 子模块引入；`plugin-sdk/` 维护在本仓库。

---

## 常见问题

**数据会不会离开我的电脑？**
索引和检索不会。任务只会把模型需要的上下文发给你配置的供应商，工作区始终在本地。

**能用本地模型吗？**
可以。把供应商指向 LM Studio 或任意 OpenAI 兼容的本地服务即可。即使完全不接模型，关键词检索也能用。

**会不会改坏我的文件？**
Shell 命令受操作系统沙箱约束，工作区外的写入会被拒绝。文件工具在目标位于工作区外或属于敏感文件时，会给出 diff 并要求确认；删除等不可逆操作逐次确认。

**支持哪些模型？**
主流国内外厂商和本地模型都能接。

**怎么发布自己的插件？**
先看[协议规范](plugin-sdk/PROTOCOL.md)，从 [hello-world](plugins/examples/hello-world/) 起步，或者让内置插件开发助手帮你搭脚手架。打成 `.wap` 包就可以分发。

---

## 参与贡献

欢迎提 Issue 和 PR。带复现步骤和截图的 bug 报告通常修得最快。

```bash
npm run test      # 核心测试
npm run test:all  # 核心 + 插件测试
```

插件、翻译、文档和示例模板同样欢迎：写好的插件或模板任务，可以作为 PR 或 Issue 分享出来。

**如果 WorkAvatar 帮你省下了时间，一个 Star 能让更多人看到它。**

---

## 许可证

[MIT License](LICENSE)

文中提及的第三方产品名称与商标归各自所有者所有，仅作标识用途。
