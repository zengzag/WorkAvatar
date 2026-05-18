# WorkAvatar - 数字员工自动生成平台

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue)
![License](https://img.shields.io/badge/license-ISC-green)

**本地优先、隐私安全的 Windows 桌面数字员工生成平台**

</div>

---

## 产品概述

WorkAvatar 是一款**本地优先、隐私安全**的 Windows 桌面软件。用户通过上传日常工作中的参考文件与资料（合同、报表、操作手册、邮件等），系统解析这些资料并提取知识，辅助用户创建可在本地运行的"数字员工"。

数字员工配备智能代理系统，支持工具调用、技能扩展、多步推理，能够辅助完成业务任务。

### 核心价值主张

- ✅ **低门槛构建**：通过向导式流程创建数字员工，无需编写代码，上传资料后系统自动分析生成员工画像和技能建议
- ✅ **智能角色分析**：基于知识库内容自动分析业务场景，智能生成员工角色、职责和技能建议（支持 LLM 分析、启发式分析、默认模板三级降级策略）
- ✅ **丰富的工具生态**：内置多个实用工具 + 知识库查询工具，支持 Claude Skills 技能扩展和 MCP 服务器集成
- ✅ **多步推理与工具过滤**：支持"思考-反思-提取"三步链式推理，自动规划和筛选适用工具
- ✅ **知识驱动**：数字员工基于知识库内容回答问题，支持分层渐进式知识查询，逐步精确定位所需知识
- ✅ **数据主权归属用户**：所有资料文件保留在用户本地磁盘，不主动上传任何文件至云端

---

## 主要特性

- **多源资料接入与智能解析**：支持 PDF、Word、Excel、图片（OCR）、Markdown、TXT、HTML 等格式的文件上传与解析
- **智能员工画像生成**：基于知识库内容自动分析生成员工角色、职责、工作风格和技能建议
- **LightAgent 智能代理**：自研代理系统，支持工具调用（Function Calling）、流式响应、多步推理
- **渐进式知识查询**：10 种分层知识库查询工具（概览→摘要→实体→章节→全文），配合 FTS5 全文检索 + 向量语义混合搜索
- **员工工作区**：每个数字员工拥有独立工作区目录，可读写文件，安全沙盒隔离
- **任务调度**：支持 Cron 定时调度，可配置多个任务自动执行，系统托盘驻留后台运行
- **工作流编排**：可视化 DAG 编排器，支持多员工协同处理任务，实时查看执行状态
- **Claude Skills 生态**：支持安装和管理 Claude Skills 格式的技能，按需激活和引用
- **MCP 集成**：支持 Model Context Protocol，扩展 Agent 工具能力
- **知识库管理**：独立知识库模块，支持导入导出、实体关系浏览、知识图谱可视化
- **多 LLM 提供商**：支持 OpenAI 兼容接口，模型分类管理（对话/嵌入），连接测试
- **数字员工导入导出**：支持配置导出（JSON）和完整包打包（.avatar），含 SHA-256 完整性校验

---

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Electron 35 |
| 前端 | React 19 + TypeScript 5.6 |
| 构建 | Vite 6 |
| 状态管理 | Zustand |
| UI 组件库 | Ant Design 6 |
| 数据库 | better-sqlite3（含 FTS5 全文索引） |
| 文件解析 | pdf-parse, mammoth, SheetJS, Tesseract.js |
| 流程编排 | @xyflow/react（DAG 可视化） |
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

## 项目结构

```
WorkAvatar/
├── electron/           # Electron 主进程
│   ├── main/           # 主进程入口、IPC 处理器、核心服务
│   ├── preload/        # 预加载脚本（ContextBridge）
│   └── shared/         # 共享类型、IPC 通道定义
├── src/                # 渲染进程（React 前端）
│   ├── pages/          # 页面组件
│   ├── components/     # 通用组件
│   ├── hooks/          # 自定义 Hooks
│   ├── stores/         # Zustand 状态管理
│   ├── i18n/           # 国际化
│   └── router/         # 路由配置
├── skills/             # Claude Skills 技能目录
├── resources/          # 打包资源（图标等）
└── package.json
```

> 详细的代码目录结构和开发指南请参阅 [`.trae/rules/实现方案.md`](.trae/rules/实现方案.md)。

---

## 许可证

[ISC](LICENSE)

---

<div align="center">

**WorkAvatar - 让数字员工为您工作**

</div>
