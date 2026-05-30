# WorkAvatar - 数字员工自动生成平台

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6-blue)
![License](https://img.shields.io/badge/license-ISC-green)

**本地优先、隐私安全的 Windows 桌面数字员工平台**

</div>

---

## 项目定位

WorkAvatar 是一款**本地优先**的 Windows 桌面软件。用户上传日常工作资料（合同、报表、操作手册、邮件等），系统解析并构建本地知识库，辅助创建可在本地运行的"数字员工"——具备知识检索、工具调用、跨会话记忆等能力的 AI 代理。

与云端智能体不同，WorkAvatar 的所有数据和处理均在本地完成，不主动上传任何文件至云端。

---

## 设计特色

### 本地知识库优先

多数智能体方案将知识库作为可选插件或依赖云端 RAG 服务，WorkAvatar 将本地知识库作为核心能力内置：

- **结构化知识构建**：文档上传后自动完成段落切分（保留标题层级路径）、目录提取、LLM 摘要生成，形成"全局摘要→文档摘要→段落摘要→原文"的分层知识结构
- **渐进式知识检索**：Agent 通过分层知识库工具（概览→目录→摘要→原文）逐步精确定位所需知识，避免一次性灌入大量上下文
- **混合搜索**：FTS5 全文检索 + Embedding 向量语义搜索 + BM25/余弦相似度加权混合搜索，兼顾关键词精确匹配和语义理解
- **对话级知识库选择**：知识库与员工无绑定关系，每次对话可按需选择不同知识库组合

### KV Cache 友好设计

LLM 提供商对请求前缀进行 KV cache，相同前缀可复用缓存避免重复计算。WorkAvatar 在架构层面系统性地优化缓存命中率：

- **运行时上下文统一注入系统提示词**：记忆、知识库上下文、技能指令等全部作为系统提示词段落注入，而非拼接到用户消息中，确保同一对话内历史消息前缀不变
- **工具定义稳定**：工具的 function schema 在 Agent 生命周期内保持不变，行为通过动态引用在运行时决定，始终发送全部注册工具
- **Agent 缓存键不含运行时状态**：仅包含不可变配置（员工/供应商/模型/思考模式），不包含知识库选择、记忆内容等运行时参数

### 跨会话记忆

数字员工具备"越用越懂用户"的能力，对话结束后自动提取用户偏好、决策结论、事实知识等持久化记忆，下次对话时按优先级注入系统提示词。记忆系统包含自动提取、过时清理、LLM 驱动的精炼合并、重要性分级、容量控制等完整机制，且记忆注入系统提示词而非用户消息，保障 KV Cache 命中。

### 本地化工具链

- **Office 文档生成**：内置 Node.js 沙箱执行器，Agent 可直接创建和编辑 Word/PowerPoint/Excel 文档，无需用户安装额外环境
- **互联网搜索**：通过 BrowserWindow 加载搜索引擎页面提取结果，支持 Google/Bing/百度/DuckDuckGo 多引擎自动降级，无需 API Key
- **员工工作区**：每个数字员工拥有独立工作区目录，Agent 可安全读写文件
- **Claude Skills 生态**：支持安装和管理 Claude Skills 格式的技能，按需激活

### 多模型与对比

- 支持 OpenAI 兼容接口的任意 LLM 提供商，模型按供应商分组管理
- 多模型对比模式：同时向 2-3 个模型发送同一问题并排对比回答
- 切换模型重新生成：对已有回答切换不同模型重新生成，保留原始回答为分支

---

## 主要功能

- **多源资料接入与智能解析**：支持 PDF、Word、Excel、图片（OCR）、Markdown、TXT、HTML 等格式
- **智能员工画像生成**：基于知识库内容自动分析生成员工角色、职责和技能建议
- **LightAgent 智能代理**：自研代理系统，支持工具调用、流式响应、多步推理（ReAct/PlanExecute/ToolFilter）
- **知识库管理**：独立知识库模块，支持导入导出、文档→目录→段落的层级知识浏览
- **工作流编排**：可视化 DAG 编排器，支持多员工协同，含调试模式
- **定时任务调度**：Cron 定时调度，系统托盘驻留后台运行
- **数字员工导入导出**：配置导出（JSON）和完整包打包（.avatar），含 SHA-256 校验
- **LLM 调用日志**：所有 LLM 交互自动记录，便于回溯排查

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Electron 35 |
| 前端 | React 19 + TypeScript 6 |
| 构建 | Vite 8 |
| 状态管理 | Zustand |
| UI 组件库 | Ant Design 6 |
| 数据库 | better-sqlite3（含 FTS5 全文索引） |
| 文件解析 | file2md, unpdf, mammoth, SheetJS, Tesseract.js |
| 流程编排 | @xyflow/react |
| 国际化 | i18next |

---

## 快速开始

### 环境要求

- Node.js >= 20.x
- npm >= 10.x
- Windows 10/11

### 安装依赖

```bash
npm install
```

### 开发模式启动

```bash
npm run dev
```

应用将在 Electron 窗口中启动，同时 Vite 开发服务器在后台运行，支持热更新。

### 生产构建

```bash
npm run build
```

将执行 TypeScript 类型检查、Vite 前端构建和 Electron Builder 打包（输出到 `dist/` 目录）。

---

## 架构概览

项目采用 Electron 双进程架构：

- **主进程**（`electron/main/`）：Node.js 环境，包含所有后端服务——数据库、文件解析、知识处理、搜索引擎、LLM 客户端、Agent 系统、任务调度等。服务层采用单例模式 + 外观模式，Agent 子系统（LightAgent）独立实现工具注册/调度/中间件链
- **渲染进程**（`src/`）：React 前端，通过 `contextBridge` 暴露的 IPC API 与主进程通信。核心业务逻辑集中在自定义 Hook 中，全局状态仅管理外观偏好、交互队列和工作流画布
- **共享层**（`electron/shared/`）：IPC 通道定义和类型，主进程与渲染进程共享

---

## 许可证

[ISC](LICENSE)

---

<div align="center">

**WorkAvatar - 让数字员工为您工作**

</div>
