# WorkAvatar - 数字员工自动生成平台

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0--dev-blue)
![Electron](https://img.shields.io/badge/Electron-35-green)
![React](https://img.shields.io/badge/React-19-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue)
![License](https://img.shields.io/badge/license-ISC-green)

**本地优先、零代码、隐私安全的 Windows 桌面数字员工生成平台**

</div>

---

## 目录

- [产品概述](#产品概述)
- [核心功能](#核心功能)
- [当前实现方案](#当前实现方案)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [开发指南](#开发指南)

---

## 产品概述

WorkAvatar 是一款**本地优先、隐私安全、零代码**的 Windows 桌面软件。用户通过上传或连接日常工作中的参考文件与资料（合同、报表、操作手册、邮件、流程图等），系统自动分析这些资料，提取其中的业务规则、知识体系与输出模板，进而自动创建可在本地独立运行的"数字员工"。

### 核心价值主张

- ✅ **零代码构建**：不需编写一行代码，上传资料即可生成数字员工
- ✅ **高还原度**：数字员工在判断逻辑、输出格式、知识引用上高度贴近用户真实工作要求，每一处输出均可追溯到源文件的具体段落
- ✅ **持续进化**：数字员工在使用中根据用户反馈（赞/踩）和新增资料不断优化，成为越用越懂业务的长期伙伴
- ✅ **数据主权完全归属用户**：所有资料文件永远保留在用户本地磁盘，不主动上传任何文件至云端；LLM 调用仅将脱敏后的文本摘要按用户配置的 API 发送，用户可在设置中预览并控制发送内容

---

## 核心功能

### 1. 资料接入与智能解析

#### 多源资料上传
- 支持从文件管理器直接拖入文件或文件夹到上传区，自动识别目录结构
- 点击上传按钮调起系统文件选择器，支持多选
- 支持文件格式：**PDF**（含扫描件）、**Word**（.doc/.docx）、**Excel**（.xls/.xlsx/.csv）、**PowerPoint**、**图片**（JPG/PNG/BMP/TIFF）、**邮件**（.eml）、**Markdown**、**TXT**、**HTML**
- 实时进度展示（文件级和总体级）
- 错误处理：对损坏文件、加密文件、格式不支持文件给出明确提示

#### 智能解析与结构化
- **文件类型识别与路由**：根据扩展名自动选择合适的解析器
- **PDF 解析**：使用 `pdf-parse` 提取纯文本及元数据
- **Word 解析**：使用 `mammoth` 转换为结构化文本
- **Excel 解析**：使用 `SheetJS` 提取所有工作表，保留行列结构
- **OCR 识别**：集成 `Tesseract.js` 引擎进行离线文字识别，支持 RapidOCR 降级方案
- **章节切分**：自动按标题层级切分为文档块
- **表格检测**：识别文档中的表格结构
- **规则抽取**：基于 LLM 自动从文档中提取业务规则、问答对、知识点

---

### 2. 数字员工自动生成

#### 技能模型
系统基于资料分析结果，自动拼装出数字员工的"技能集"：
- **信息提取/审核**：从输入文本/文件中提取关键字段，与规则比对，给出判定
- **问答与咨询**：基于知识库回答事实性问题，给出引用来源和置信度
- **内容生成/填充**：根据模板和输入数据生成标准文档
- **分类与路由**：将输入按规则分类，并指定后续动作
- **数据查询/比对**：在表格数据中查询、汇总、比对
- **计算与推导**：根据规则执行数值计算或逻辑推导

#### 系统内置工具
数字员工自带丰富的系统工具，可在对话中直接调用：

| 工具名称 | 功能说明 | 适用场景 |
|---------|---------|---------|
| `calculator` | 数学计算器，支持加减乘除、幂运算、百分比 | 数值计算、公式验证 |
| `date_time` | 获取当前时间、格式化日期、日期加减 | 时间戳生成、日期推算 |
| `string_utils` | 字符串截取、替换、分割、大小写转换、统计 | 文本预处理、格式转换 |
| `json_utils` | JSON 解析、格式化、路径查询、验证、压缩 | 数据转换、API 响应处理 |
| `random_utils` | 随机数、UUID、随机选择、打乱顺序 | 生成唯一标识、抽样 |
| `shell_exec` | 执行系统 Shell 命令（支持 Windows CMD/PowerShell） | 文件操作、系统查询、网络测试 |
| `ask_user` | 暂停对话并询问用户，支持预设选项 | 需要用户确认或补充信息时 |
| `read_file` | 读取本地文本文件，支持分页和行号 | 查看日志、读取配置文件 |
| `write_file` | 写入内容到本地文件，自动创建目录 | 保存结果、生成报告 |
| `list_dir` | 列出目录内容，支持递归和忽略临时目录 | 浏览项目结构、查找文件 |
| `system_info` | 获取系统平台、CPU、内存、磁盘、网络信息 | 环境诊断、资源监控 |
| `web_search` | 使用 DuckDuckGo 进行网络搜索 | 查询最新信息、验证事实 |
| `web_fetch` | 获取网页内容并提取纯文本 | 读取文档、获取在线数据 |
| `env_vars` | 安全读取允许列表中的环境变量 | 路径查询、环境诊断 |

> **安全提示**：`shell_exec` 工具内置危险命令拦截（如 `rm -rf`、`format`、`diskpart` 等），且仅在用户本地环境执行。`env_vars` 仅允许读取 PATH、HOME、USER 等安全环境变量。

#### 四步创建向导
1. **选择资料源**：勾选要用于训练数字员工的文件
2. **解析结果确认**：预览提取的规则、知识片段、输出模板
3. **技能配置**：启用/禁用技能，调整技能参数
4. **完成创建**：命名数字员工，配置 LLM 提供商，正式启用

---

### 3. 数字员工工作台

#### 对话式操作界面
- 聊天窗口交互，支持流式响应的打字机效果
- 消息类型支持：文本消息、文件消息
- 支持 `Enter` 发送，`Shift+Enter` 换行
- 实时中断生成功能

#### 工作过程可视化（溯源面板）
- **知识检索**：列出检索到的 top-K 知识片段，每条含相关度分和来源文件名
- **规则匹配**：展示本次触发和应用的规则条目
- **目的**：让用户理解并信任数字员工的决策逻辑，而非黑盒输出

#### 人工复核与反馈
- 用户对每次输出可标注"赞"或"踩"
- 反例学习：被标注"踩"的结果自动收集为反例
- 支持复制输出内容

---

### 4. RAG 增强检索与 LLM Wiki 知识库

#### RAG 增强检索
- 基于 **LanceDB** 嵌入式向量数据库，零服务器依赖
- 智能文档分块：1000字符/块，200字符重叠，优先在句号/换行处切分
- 语义检索：基于 OpenAI 兼容嵌入 API 的余弦相似度搜索
- 可配置 top-K 数量和最小相似度阈值
- 检索结果实时推送到工作台右侧面板

#### LLM Wiki 知识库（编译时结构化）
- **核心思想**：让大模型扮演"知识编译器"，将原始资料转化为结构化、相互链接的 Markdown Wiki 文件
- **3+1 文件夹结构**：
  - `raw/` - 存放原始材料（只读，事实来源）
  - `wiki/` - AI 生成的结构化 Markdown（主题页、实体页、索引、标签）
  - `outputs/` - 问答记录与生成报告（可反馈为新材料）
  - `AGENTS.md` - AI 指引文件，定义知识库规则
- **知识编译**：LLM 自动提取实体、主题、关系，生成双向链接的 Wiki 页面
- **多维搜索**：基于标题、内容、标签的混合搜索，比纯向量检索更精准
- **滚雪球效应**：每添加新资料，自动与已有 Wiki 关联更新，知识持续积累
- **双模式对话**：工作台支持 Wiki 模式 / RAG 模式 / 双模式同时启用

---

### 5. 多 LLM 提供商支持

- 支持多种 LLM 提供商：
  - OpenAI
  - OpenAI 兼容接口（如 Llama.cpp、vLLM、Ollama OpenAI 模式）
  - Groq
  - Mistral AI
  - Azure OpenAI
  - Google Vertex AI
  - AWS Bedrock
  - xAI

- 连接测试功能：轻量 ping 验证连通性和延迟
- 数据发送控制开关：可全局禁用 LLM 调用，降级为仅本地规则执行
- 预览即将发送的数据：可配置每次调用前弹窗确认

---

### 6. 全局配置管理

- **LLM 配置**：多提供商增删改查，连接测试
- **存储设置**：数据存储目录选择，自动备份配置
- **外观设置**：亮色/暗色主题，字体大小，界面语言
- **关于页面**：版本信息，检查更新，导出日志

---

## 当前实现方案

### 1. 进程架构

```
┌─────────────────────────────────────────────────────────────┐
│                    主进程 (Main Process)                      │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │  Database Svc  │  │  File Parser   │  │  LLM Client    │ │
│  │  (better-sqlite3) │  │  Service     │  │  Service      │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │  RAG Service   │  │  OCR Service   │  │  Project Mgmt  │ │
│  │   (LanceDB)    │  │ (Tesseract.js) │  │  Service       │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              IPC 处理器 (类型安全)                       │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                      ┌───────────────┐
                      │  Preload 桥接 │
                      │  (contextBridge)│
                      └───────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                  渲染进程 (Renderer Process)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Dashboard│  │ Project  │  │ Employee │  │ Settings │    │
│  │  Page    │  │ Detail   │  │ Workbench│  │  Page    │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │          Zustand Store (全局状态管理)                   │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```


### 2. 核心数据流

#### 数字员工创建流程

```
用户上传文件
    ↓
文件存储到本地项目目录
    ↓
文件解析队列 → 文件解析服务
    ├─ PDF/Word/Excel → 文本提取
    └─ 图片/扫描件 → OCR 识别 → 文本提取
    ↓
解析结果存储到 files.parsed_json
    ↓
规则抽取引擎 → LLM 智能提取规则/知识/模板
    ↓
用户在创建向导中确认解析结果
    ↓
自动生成技能配置和 Prompt 模板
    ↓
创建数字员工记录（employees 表）
    ↓
创建关联技能记录（skills 表）
    ↓
LanceDB 向量索引构建
    ↓
数字员工启用完成，可进入工作台对话
```

#### RAG 增强对话流程

```
用户输入问题
    ↓
获取数字员工关联的项目 ID
    ↓
调用 LLM 嵌入 API → 问题向量
    ↓
LanceDB 向量检索 → top-K 相关文档块
    ↓
组装 Prompt：系统提示 + 知识上下文 + 用户问题
    ↓
调用 LLM 流式聊天 API
    ↓
SSE 事件推送 → 前端打字机效果渲染
    ↓
检索结果实时推送到右侧溯源面板
    ↓
对话消息保存到 conversations.messages_json
```

---

## 快速开始

### 环境要求

- Node.js >= 20.x
- npm >= 10.x
- Windows 10/11（开发和运行平台）

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

将执行：
1. TypeScript 类型检查
2. Vite 前端构建
3. Electron Builder 打包（输出到 `dist/` 目录）

### 运行测试

```bash
# 单元测试
npm run test:unit

# E2E 测试
npm run test:e2e
```

---

## 项目结构

```
WorkAvatar/
├── electron/                          # Electron 主进程代码
│  ├─ main/                          # 主进程入口和服务
│  │   ├─ index.ts                   # 主进程入口，窗口管理
│  │   ├─ ipc-handlers.ts            # IPC 处理器注册
│  │   └─ services/                  # 核心服务
│  │       ├─ database.service.ts    # SQLite 数据库服务
│  │       ├─ file-parser.service.ts # 文件解析服务
│  │       ├─ llm-client.service.ts  # LLM 客户端服务
│  │       ├─ rag.service.ts         # RAG 向量检索服务
│  │       ├─ llm-wiki.service.ts    # LLM Wiki 知识库服务
│  │       ├─ ocr.service.ts         # OCR 识别服务
│  │       ├─ project-manager.service.ts # 项目管理服务
│  │       ├─ rule-extraction.service.ts # 规则抽取引擎
│  │       └─ sandbox-tester.service.ts  # 沙盒测试服务
│   ├── preload/                       # 预加载脚本
│   │   └── index.ts                   # ContextBridge API 暴露
│   └── shared/                        # 共享类型和常量
│       ├── ipc-channels.ts            # IPC 通道定义和类型
│       └── types.ts                   # 共享数据类型
├── src/                               # 渲染进程（React 前端）
│   ├── pages/                         # 页面组件
│   │   ├── Dashboard.tsx              # 仪表盘首页
│   │   ├── ProjectDetail.tsx          # 项目详情/文件管理
│   │   ├── CreationWizard.tsx         # 数字员工创建向导
│   │   ├── DocumentViewer.tsx         # 文档预览/解析结果
│   │   ├── WikiManager.tsx            # LLM Wiki 知识库管理
│   │   ├── EmployeeWorkbench.tsx      # 数字员工工作台
│   │   ├── EmployeeSettings.tsx       # 数字员工配置管理
│   │   └── Settings.tsx               # 全局设置
│   ├── components/                    # 通用组件
│   │   ├── common/                    # 基础组件
│   │   │   ├── EmptyState.tsx
│   │   │   └── PageHeader.tsx
│   │   └── file/                      # 文件相关组件
│   │       ├── FileList.tsx
│   │       └── FileUploadZone.tsx
│   ├── stores/                        # Zustand 状态管理
│   │   └── app.store.ts
│   ├── types/                         # TypeScript 类型定义
│   ├── router/                        # 路由配置
│   │   └── index.tsx
│   ├── styles/                        # 全局样式
│   ├── App.tsx                        # 应用根组件
│   └── main.tsx                       # 应用入口
├── resources/                         # 打包资源
│   ├── icons/                         # 应用图标
│   └── rapidocr/                      # RapidOCR 可执行文件（可选）
├── tests/                             # 测试目录
│   ├── unit/                          # 单元测试
│   └── e2e/                           # E2E 测试
├── package.json                       # 项目配置
├── tsconfig.json                      # TypeScript 配置
├── vite.config.ts                     # Vite 配置
├── electron-builder.yml               # Electron Builder 打包配置
├── README.md                          # 本文档
└── 进展.md                            # 项目进展与计划
```

---

## 开发指南

### 添加新的 IPC 通道

1. 在 `electron/shared/ipc-channels.ts` 中定义通道名和类型
2. 在 `electron/main/ipc-handlers.ts` 中注册处理器
3. 在 `electron/preload/index.ts` 中通过 `contextBridge` 暴露 API
4. 在前端通过 `window.electronAPI` 调用

### 添加新的服务

1. 在 `electron/main/services/` 下创建新的服务类（单例模式）
2. 在 `ipc-handlers.ts` 中注册相关的 IPC 处理器
3. 在预加载脚本中暴露对应的 API 方法

### 添加新的前端页面

1. 在 `src/pages/` 下创建页面组件
2. 在 `src/router/index.tsx` 中添加路由配置
3. 在侧边栏菜单（`App.tsx`）中添加导航入口

---

## 许可证

ISC License

---

<div align="center">

**WorkAvatar - 让数字员工为您工作**

</div>
