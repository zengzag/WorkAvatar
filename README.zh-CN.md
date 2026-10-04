# WorkAvatar

<div align="center">

![Version](https://img.shields.io/badge/version-1.4.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | **简体中文**

</div>

WorkAvatar 是一款以**数字员工智能体**为核心的 Windows 桌面应用。每个数字员工都是一个可独立工作的 AI 角色，有自己的指令、默认模型和工具集，能够自主规划步骤、调用工具、读写本地文件并完成任务。两大特色能力支撑它更好地工作：**本地资料库检索引擎**让员工能快速查阅你电脑上的文档，**可扩展插件系统**让应用能力可以持续生长。

---

## 目录

- [数字员工](#数字员工)
- [本地资料库](#本地资料库)
- [插件生态](#插件生态)
- [快速上手](#快速上手)
- [适合哪些场景](#适合哪些场景)
- [开发者](#开发者)

---

## 数字员工

<div align="center">
  <img src="images/agent-chat.gif" alt="数字员工工作中" width="88%" />
</div>

数字员工是 WorkAvatar 的核心。你可以创建任意数量的员工，每个员工有独立的角色指令、默认模型、工具集和记忆。

描述一个任务，员工就会规划步骤、自主调用工具。整个执行过程以对话形式实时呈现——你能看到它在想什么、读了哪些文件、写了什么内容、遇到了什么问题。

<div align="center">
  <img src="images/employees.png" alt="数字员工管理" width="88%" />
</div>

**工具集** — 覆盖文件读写编辑删除、Shell 命令、JavaScript 执行、网页搜索、图片识别、以及 Word/Excel/PPT 文档生成。你可以按员工单独配置每个工具的可用状态，也可以接入外部 MCP 服务。

**文件安全** — 所有文件操作统一走权限检查。员工在授权工作区内自由读写，工作区外或敏感文件（如 `.env`、私钥、`.git`）需要确认，并提供变更 diff 预览。每次写盘和删除都有快照，任何改动都可以回滚。

**子任务委托** — 员工可以把工作拆成子任务交给其他员工，并行或顺序执行，最多三层。每个子任务在独立工作区运行，只把结果摘要返回，不污染主员工上下文。

**记忆与技能** — 跨任务记忆让员工记住之前的偏好和教训；Skills 以 Markdown 格式定义专项能力，员工可按需加载。应用内置知识搜索助手和插件开发助手，各插件也可以提供自己的员工。

---

## 本地资料库

<div align="center">
  <img src="images/kms-search.gif" alt="本地资料库检索" width="88%" />
</div>

资料库让数字员工能快速查阅你电脑上的文档——项目资料、合同、报告、会议纪要，都可以加进资料库。

**即加即用** — 把文件夹加入资料库，立即就能按关键词搜索，无需等待向量化完成。索引会自动跟踪文件变化，支持增量重建。

**混合检索** — 搜索同时跑三条路径：全文关键词、语义向量、文件名匹配，然后合并排序。可在混合 / 关键词 / 语义 / 文件名四种模式间切换，也可以按文件类型、时间范围、目录、合集过滤结果。

**冷热分层渐进式增强** — 常用文件（被频繁打开或命中）后台自动晋升，增加段落摘要、语义向量和知识卡片；冷门文件保持轻量索引，资源消耗与使用量成正比。这意味着资料库第一天就可用，用得越多越聪明。

**合集** — 你可以把主题相关的文件归为一个合集，每个合集自动生成摘要和目录，便于按主题浏览，或作为任务上下文交给员工。

**离线优先** — 文档解析、分词、索引和搜索都在本地完成。即使模型服务不可用，关键词搜索依然可用。支持的格式包括 PDF、Word、Excel、PPT、Markdown、纯文本、HTML，以及本地 OCR 识别的图片。

**对外服务** — 资料库内置 MCP 服务，绑定 127.0.0.1 并使用生成的访问令牌，本机其他 MCP 兼容应用可以调用它的搜索能力。

---

## 插件生态

<div align="center">
  <img src="images/plugins.gif" alt="插件管理" width="88%" />
</div>

WorkAvatar 从一开始就是插件化的。笔记、日历、语音识别、自动化、数据模型、文档编辑、模板任务、AI 助手聚合页——这些能力全部以插件形式交付。启用、禁用、导入、删除、升级都在设置页完成，即时生效，无需重启。

插件可以添加导航页、设置项、聊天工具栏，也可以提供自己的数字员工和工具。插件自动跟随应用的明暗主题和语言设置。

应用内置**插件开发助手**——你可以直接让数字员工在应用内开发一个插件并安装。他人分享的 `.wap` 插件包也可以导入使用。

### 内置插件一览

| 插件 | 说明 |
|------|------|
| **笔记** | Markdown 笔记，文件以 `.md` 存储在本地文件夹，便于和同步服务及其他编辑器配合使用。三栏布局：文件树、编辑器、大纲，支持分屏预览和全文检索。 |
| **日历 & 待办** | 月 / 周 / 日视图，支持重复事件和提醒，可选单向同步 Outlook。数字员工可应要求创建和编辑事件。 |
| **语音识别** | 基于 sherpa-onnx 的离线识别。录音时实时字幕、浮窗字幕，录音结束自动生成会议纪要。 |
| **自动化** | 按日 / 周 / 月定时运行数字员工任务，失败自动重试，完成后通知。每次运行可追溯到对应的任务会话。 |
| **数据模型** | 在画布上设计数据库表结构，支持 DBML 导入导出。也可以通过对话让员工帮你设计模型。 |
| **文档编辑** | Word 级保真度 `.docx` 编辑器，支持导入导出、PDF 导出、版本快照。AI 助手可以在编辑器上直接改写、替换、插入、删除、重排、调整样式。界面为中文。 |
| **模板任务** | 可视化画布上搭建多步工作流——智能体、评审、条件分支、循环、并行、人工节点，带通过 / 不通过判定和轮次控制。内置模板设计助手，可把一段需求描述转成可运行模板。 |
| **AI 助手聚合页** | 把豆包、DeepSeek 等第三方 AI 网站内嵌到应用中，单页 / 双页 / 标签页多种布局，各自独立的登录态。使用受对应网站服务条款约束。 |

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

首次启动时引导向导会带你完成模型服务配置、第一个数字员工创建和资料库基本操作。

手动操作也只需三步：

1. **添加资料库** — 左侧导航进入「资料库 → 文档管理」，添加本机文件夹，索引自动建立并持续同步。
2. **搜索文档** — 顶部搜索框输入关键词，在混合 / 关键词 / 语义 / 文件名模式间切换，按类型或时间过滤。
3. **开始对话** — 切到「数字员工」，选一个员工（或新建），描述你的任务。员工会按需检索资料库、把产出写入任务独立工作区。

---

## 适合哪些场景

- 让 AI 在**本地文档**上工作——合同比对、报告起草、项目资料检索，不上传云端。
- 给团队或个人搭一个**可长期复用的 AI 员工**，角色、工具、记忆都可定制。
- 把重复性工作交给**自动化**按计划执行，比如每天早上自动生成晨会纪要。
- 需要时把本机资料库通过 **MCP 服务**开放给其他 AI 应用调用。

---

## 开发者

### 插件开发

插件协议、API 文档和示例项目已随仓库提供：

- 插件协议规范：[plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- 插件 API 参考：[plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- 插件能力矩阵：[plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- 插件开发打包教程：[plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- 示例插件：[plugins/examples/hello-world/](plugins/examples/hello-world/)

### 技术栈

| 分类 | 技术 |
|------|------|
| 运行时 | Electron 35 |
| 前端 | React 19 + TypeScript 6 + Ant Design 6 |
| 构建 | Vite 8 |
| 本地数据库 | SQLite（FTS5 全文检索 + sqlite-vec 向量） |
| 文档解析 | PDF、Word、Excel、PPT、HTML、OCR（PaddleOCR） |
| 语音识别 | sherpa-onnx（离线） |
| 国际化 | i18next（中英文） |

> 内置插件（笔记、日历、语音、自动化、数据模型、文档编辑、模板任务）源码位于独立仓库 `WorkAvatar-Plugins`，以 git 子模块形式包含在 `plugins/` 目录中。`plugin-sdk/` 插件协议类型定义维护在本仓库。克隆后执行 `git submodule update --init --recursive` 拉取插件源码。

### 构建源码

**要求：** Windows 10/11、Node.js 20+、npm 10+

```bash
# 拉取插件子模块
git submodule update --init --recursive

npm install

# 开发模式
npm run dev

# 生产构建
npm run build
```

### 许可证

[MIT License](LICENSE)

文中提及的第三方产品名称、商标归其 respective 所有者所有，仅作标识用途。
