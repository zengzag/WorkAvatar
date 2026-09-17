# WorkAvatar - 办公数字员工工作台

<div align="center">

![Version](https://img.shields.io/badge/version-1.2.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![License](https://img.shields.io/badge/license-MIT-green)

**本地优先的 Windows 桌面数字员工工作台 —— 以资料库管理文档知识，以插件扩展能力边界**

文档解析、检索与模型推理全程在本机完成，敏感数据不出本地。

</div>

---

## 为什么做 WorkAvatar

日常办公中积累了大量本地文档——项目资料、合同报表、技术文档、会议记录。想让 AI 真正用好这些知识，常见方案各有取舍：

- **纯关键词检索**：上手快，但只能字面匹配，跨文档汇总、概念理解类需求力不从心
- **RAG 语义检索**：能理解语义，但通常需要先全量向量化，文档越多等待越久；纯语义匹配也存在"看着相关、实际不对"的情况
- **知识图谱**：关联能力强，但构建与维护成本高，适合特定领域的深度应用

WorkAvatar 选择了"**轻量起步、渐进沉淀**"的中间道路：添加目录先用轻量关键词索引跑起来，再随使用逐步补齐语义向量、摘要与知识卡片，让检索质量在使用过程中持续提升。

---

## 数字员工：会使用工具的 AI 同事

<div align="center">
  <img src="images/agent-chat.gif" alt="数字员工任务对话" width="88%" />
</div>

数字员工是 WorkAvatar 的核心：为每个角色配置专属档案——系统提示词、默认模型、可用工具、外部 MCP 服务与持久化记忆。选择员工、描述需求，它自主调用工具完成任务，过程全程可视。

<div align="center">
  <img src="images/employees.png" alt="数字员工管理" width="88%" />
</div>

- **流式对话**：响应流式输出，思考过程与工具调用分步展示；支持同时向多个模型提问并排对比
- **工具系统**：文件读写/编辑/删除（删除移入回收站可恢复）、代码执行、联网搜索、资料库检索、Office 文档生成等内置工具，按"常驻 / 按需 / 关闭"三态配置；MCP 工具动态接入
- **任务委托**：数字员工之间可互相委托子任务，支持并行派发与结果追问，深度≤3 防止递归失控；子任务过程独立运行，仅回传摘要
- **持久化记忆**：对话中的偏好与经验自动沉淀为记忆，后续任务按需注入
- **Skills 扩展**：兼容社区 Skills 标准（SKILL.md），支持安装第三方技能
- **独立工作区**：每个任务拥有独立子目录互不干扰；员工配置可导入导出，方便团队复用
- **内置与插件员工**：宿主随应用发布「资料搜索助手」等内置员工，插件也可声明专属数字员工；内置/插件员工分组展示、只读，可另存副本后个性化

---

## 本地资料库（KMS）：把散落的文档变成可对话的知识

<div align="center">
  <img src="images/kms-search.gif" alt="本地资料库混合检索" width="88%" />
</div>

把本地文件夹交给资料库管理，面向个人与团队的文档检索场景：

- **即加即用**：添加目录后先构建关键词索引，无需等待全量向量化即可搜索；文件增删改自动同步索引，也支持从指定节点增量重建
- **混合检索**：全文关键词（SQLite FTS5 + 中文分词）、语义向量、文件名三路并行检索，经 RRF 融合排序——精确匹配打底，语义查找扩展，兼顾精准与召回
- **渐进式沉淀（冷热分层）**：冷数据仅保存轻量索引；被频繁查阅的文件自动晋升为热数据，补齐章节摘要、语义向量与知识卡片，越用越顺手；长期未访问的内容自动降级，控制资源占用
- **资料合集**：手动挑选文件组成专题合集，自动生成全局摘要与目录结构，便于按主题检索或喂给数字员工
- **格式覆盖**：PDF、Word、Excel、PPT、Markdown、TXT、HTML、图片（OCR）；LLM 不可用时自动降级为基础检索，保证可用性

> 隐私边界：文档解析、索引构建、向量化与推理均在本地完成；资料库检索能力还可通过内置 MCP 服务（仅绑定 127.0.0.1）输出给本机的其他 Agent 工具使用。

---

## 插件化能力扩展：核心功能即插件，能力可自由扩展

<div align="center">
  <img src="images/plugins.gif" alt="插件管理" width="88%" />
</div>

WorkAvatar 不把功能焊死在主程序里：**导航页功能（笔记、日历、语音识别、自动化、数据模型等）全部以插件形式交付**，与第三方插件走完全相同的加载逻辑。插件采用 **manifest 声明 + 双入口插件包 + 宿主扩展点** 架构，并以**能力域授权（capabilities）**开放数据访问、统一执行入口、事件总线与 UI 注入，在可控的前提下最大化扩展空间。

- **独立分发**：插件打包为 `.wap`（zip 归档），在「设置 → 插件」导入、启停、删除与覆盖升级，全部即时生效、无需重启
- **独立存储**：每个插件使用独立 SQLite 分库（`userData/plugin-data/<id>/`），互不干扰，卸载不留残留
- **UI 注入**：插件可注册导航页、设置页 Tab、对话页工具栏等视图；渲染端共享宿主 React/antd 单例，自动继承明暗主题与多语言
- **AI 二次开发**：内置 plugin-dev Skill，安装包即可让数字员工辅助开发插件——脚手架、编码、构建、安装一条龙
- **插件数字员工**：插件可在 manifest 中声明专属数字员工（如「日历助手」），与内置员工分组展示，可另存副本后个性化

| 随应用分发的插件 | 说明 |
|------|------|
| **笔记** | `.md` 文件存储的 Markdown 笔记，仓库可被外部工具与同步盘直接访问；文件树/编辑器/大纲三栏，分屏预览、全文搜索 |
| **日历与待办** | 月/周/日视图日程 + 零负担 TODO 速记，重复规则与提醒，支持 Outlook 单向同步；数字员工可代为创建修改 |
| **语音识别** | 本地离线语音识别（sherpa-onnx），录音转写实时字幕、悬浮窗投屏，结束后生成结构化会议纪要 |
| **自动化** | 定时调度数字员工执行固定任务，每日/每周/每月等重复规则，失败重试与完成通知，执行历史可回溯对话 |
| **数据模型** | 画布式表结构设计，DBML 导入导出；对话式 AI 建模，编辑实时反映到画布 |
| **AI 助手集** | 单栏/双栏/标签页打开豆包、DeepSeek 等 AI 网页版，各站点独立持久化登录态，便于多模型对照 |

<div align="center">
  <table><tr>
    <td><img src="images/notes.png" alt="笔记" width="100%" /></td>
    <td><img src="images/calendar.png" alt="日历与待办" width="100%" /></td>
  </tr><tr>
    <td><img src="images/voice.png" alt="语音识别" width="100%" /></td>
    <td><img src="images/automation.png" alt="自动化" width="100%" /></td>
  </tr></table>
</div>

插件协议规范与开发资料：

- 插件协议规范：[plugin-sdk/PROTOCOL.md](plugin-sdk/PROTOCOL.md)
- 插件 API 参考：[plugin-sdk/API_REFERENCE.md](plugin-sdk/API_REFERENCE.md)
- 插件能力矩阵：[plugin-sdk/CAPABILITY_MATRIX.md](plugin-sdk/CAPABILITY_MATRIX.md)
- 插件开发与打包教程：[plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md](plugins/examples/hello-world/PLUGIN_DEVELOPMENT.md)
- 插件示例工程：[plugins/examples/](plugins/examples/)

---

## 快速上手

1. **添加资料目录**：打开左侧导航「资料库」→「文档管理」→ 添加目录，索引自动构建、增量同步
2. **搜索资料**：顶部搜索框输入关键词即得结果，支持混合/关键词/语义/文件四种模式，可按文件类型与时间范围筛选
3. **组建合集**：在文档管理中挑选文件组成专题合集，自动生成全局摘要与目录
4. **派发任务**：切换到「数字员工」，选择或新建员工开始对话；它会自动检索资料库、调用工具、生成 Word/Excel/PPT 等交付物

---

## 主要特点

| 特点 | 说明 |
|------|------|
| **轻量起步** | 关键词索引即可用，无需等待全量向量化 |
| **混合检索** | 关键词 + 语义 + 文件名三路检索，RRF 融合排序 |
| **渐进精准** | 冷热分层自动晋升/降级，频繁查阅的内容深度加工，越用越顺手 |
| **全本地运行** | 解析、索引、推理在本机完成，数据不出本地 |
| **插件化扩展** | 核心功能即插件，能力域授权，独立启停与二次开发 |
| **多智能体协作** | 员工间任务委托与并行派发，子任务隔离执行 |
| **LLM 容错** | LLM 不可用时自动降级基础检索，保证基本可用 |

## 适用场景

- **个人知识管理**：本地资料秒级定位，AI 辅助梳理、总结、生成文档
- **敏感资料处理**：合同、报表、内部文档等不便上云的场景
- **团队内部资料库**：私有化部署，支撑日常资料查询与业务分析
- **智能体开发**：通过内置 MCP 服务为其他 Agent 提供稳定的本地文档检索能力
- **专题研究**：用合集组织主题资料，渐进式深度加工

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Electron 35 |
| 前端 | React 19 + TypeScript 6 + Ant Design 6 |
| 构建 | Vite 8 |
| 状态管理 | Zustand |
| 数据库 | better-sqlite3（FTS5 全文索引 + sqlite-vec 向量检索） |
| 中文分词 | @node-rs/jieba |
| 文件解析 | PDF / Word / Excel / PPT / OCR |
| 语音识别 | sherpa-onnx |
| 国际化 | i18next |

> **仓库结构**：内置插件源码（笔记/日历/语音/自动化/数据模型）独立为 git 子仓库 `WorkAvatar-Plugins`，作为本仓库 `plugins/` 的 submodule 依赖；`plugin-sdk/`（插件协议类型契约）由本仓库持有。克隆后需执行 `git submodule update --init --recursive` 拉取插件源码。

---

## 快速开始

### 环境要求

- Node.js >= 20.x
- npm >= 10.x
- Windows 10/11

### 安装依赖

```bash
# 拉取插件子仓库（内置插件源码）
git submodule update --init --recursive

npm install
```

### 开发模式启动

```bash
npm run dev
```

### 生产构建

```bash
npm run build
```

---

## 许可证

[MIT](LICENSE)

---

<div align="center">

**WorkAvatar - 让数字员工为您工作**

</div>
