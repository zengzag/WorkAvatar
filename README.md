# WorkAvatar - 数字员工自动生成平台

<div align="center">

![Version](https://img.shields.io/badge/version-1.0.0-blue)
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

数字员工配备智能代理系统，支持工具调用、技能扩展、思维链推理，能够自主完成复杂任务。

### 核心价值主张

- ✅ **零代码构建**：不需编写一行代码，上传资料即可生成数字员工
- ✅ **智能角色分析**：基于知识库自动分析业务场景，智能生成员工角色、职责和技能
- ✅ **强大的工具生态**：内置 13+ 实用工具，支持 Claude Skills 技能扩展和 MCP 服务器集成
- ✅ **思维链推理**：支持 Tree-of-Thought 思维链，复杂任务多步规划
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

### 2. 智能角色分析与数字员工生成

#### 智能员工画像分析
- 基于知识库内容自动分析业务场景
- 智能生成员工角色名称和详细描述
- 自动识别员工职责清单
- 推荐合适的工作风格和性格特质
- 支持用户补充说明和期望，引导分析方向
- 提供 LLM 分析、启发式分析、默认模板三种 fallback 策略
- 流式展示分析过程，实时查看思考进度

#### 自动技能推荐
- 根据业务场景自动推荐适用技能
- 技能类型包括：信息提取/审核、问答与咨询、内容生成/填充、分类与路由、数据查询/比对、计算与推导等
- 每个技能包含：提示模板、业务规则、测试用例、输入输出 schema
- 支持手动启用/禁用技能，调整技能参数

#### 创建流程
1. **选择知识库**：关联一个或多个知识库作为员工的知识基础
2. **智能分析**：系统自动分析知识库，生成员工画像和技能建议
3. **确认与调整**：查看分析结果，可手动编辑角色信息、职责、技能
4. **配置工具**：选择员工可使用的内置工具、技能和 MCP 服务器
5. **完成创建**：命名数字员工，配置 LLM 提供商，正式启用

---

### 3. LightAgent 智能代理系统

#### 核心特性
- **工具调用（Function Calling）**：支持 OpenAI 格式的工具调用，自动处理多轮工具调用
- **技能系统**：支持 Claude Skills 格式的技能加载、激活和引用读取
- **思维链（Tree-of-Thought）**：支持 ToT 推理模式，复杂任务多步规划
- **流式响应**：支持 SSE 流式输出，包括思考过程和工具调用实时展示
- **可中断**：支持 AbortController 实时中断生成

#### 内置工具集（13+ 实用工具）
- **文件操作**：`read_file`（读取文件）、`write_file`（写入文件）、`list_dir`（列出目录）
- **系统工具**：`shell_exec`（执行 shell 命令）、`system_info`（系统信息）、`env_vars`（环境变量）
- **网络工具**：`web_search`（网络搜索）、`web_fetch`（获取网页内容）
- **实用工具**：`calculator`（计算器）、`date_time`（日期时间）、`string_utils`（字符串处理）、`json_utils`（JSON 处理）、`random_utils`（随机工具）

#### 渐进式知识查询工具
Agent 内置知识库查询工具，支持分层查询：
- `kb_overview`：获取知识库概览（文件列表和摘要）
- `query_global_summary`：查询全局摘要
- `query_knowledge_graph`：查询知识图谱和实体关系
- `query_chapters`：按章节检索知识
- `query_fulltext`：全文检索
- `get_document_content`：获取原始文档内容
- `generate_timeline`：生成时间线

---

### 4. Claude Skills 技能生态

#### 技能管理
- 支持从目录安装 Claude Skills 格式的技能
- 支持从 ZIP 压缩包安装技能
- 技能注册表管理：查看、启用/禁用、卸载已安装技能
- 技能与员工关联：为每个数字员工分配专属技能集

#### Claude Skills 格式
```
skill-name/
├── SKILL.md          # 技能定义（包含 front-matter 和说明）
├── references/       # 参考资料目录
│   ├── doc1.md
│   └── data.json
└── scripts/          # 脚本目录（可选）
    └── helper.py
```

#### 技能特性
- **自动发现**：Agent 启动时自动扫描技能目录
- **按需激活**：通过 `activate_skill` 工具动态加载技能指令
- **引用读取**：通过 `read_reference` 工具读取技能附带的参考资料
- **标签分类**：支持标签管理和分类筛选

---

### 5. MCP 服务器集成

#### Model Context Protocol 支持
- 集成 `@modelcontextprotocol/sdk`
- 支持配置和管理多个 MCP 服务器
- 每个数字员工可独立配置启用哪些 MCP 服务器
- MCP 工具自动注册到 Agent 工具注册表

---

### 6. 数字员工工作台

#### 沉浸式对话界面
- **极简顶栏**：仅显示员工名称、状态、LLM 选择器和快捷操作图标
- **对话优先布局**：对话区域占据绝大部分版面，消息列表居中显示
- **面板按需展开**：历史对话列表和知识检索面板默认隐藏，通过顶部图标一键切换
- **消息气泡**：用户与助手消息样式区分，支持思考过程折叠/展开
- 流式响应的打字机效果，支持 `Enter` 发送 / `Shift+Enter` 换行
- 实时中断生成功能（真正中断后端 LLM 请求）

#### 智能滚动行为
- 模型输出新内容时，仅在用户在消息列表底部时自动滚动
- 用户上翻查看历史消息时，新内容不会导致跳动

#### 知识检索结果内联展示
- Wiki 检索结果和 RAG 检索结果内联在消息列表顶部
- 可折叠面板展示，支持点击来源文件跳转
- Wiki/RAG 开关快捷切换（底部标签）

#### 工具调用可视化
- 工具调用过程实时展示
- 支持查看工具调用参数和返回结果
- 支持展开/折叠工具调用详情

---

### 7. 独立知识库管理

#### 知识库与项目解耦
- 知识库独立于项目管理，支持跨项目共享复用
- 同一文件只需解析一次，多项目共享已解析结果
- 知识库可关联到多个项目，员工可直接使用知识库内容
- 基于文件哈希值(SHA-256)自动识别重复文件，避免重复解析
- 侧边栏独立入口：「知识库」管理页面

#### 知识库文档管理
- 上传文件到知识库，支持多格式（PDF/Word/Excel/图片/Markdown/TXT/HTML）
- 文档解析进度跟踪（待解析/解析中/已完成/失败）
- 支持逐文档解析和批量全部解析
- 解析进度实时展示

#### 知识处理结果可视化
- 全局知识摘要展示（含核心主题和关键实体标签）
- 文档摘要列表（支持查看章节、原文）
- 章节详情查看（摘要、关键词、实体）
- 实体图谱（按类型筛选、关系网络导航、关联实体跳转）
- 关系网络总览（源实体-关系-目标实体列表）
- 原始文档内容查看
- 时间线生成与展示

---

### 8. 后台任务队列

#### 任务进度面板
- 全局任务进度指示器，位于侧边栏底部
- 实时展示：文档上传、文件解析、Wiki 编译、知识处理等后台任务
- 支持查看任务详情、各任务状态（等待中/运行中/已完成/失败/已取消）
- 可一键清除已完成任务

---

### 9. RAG 增强检索与 LLM Wiki 知识库

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
- 渐进式知识查询：Agent 工具支持分层查询（全局摘要→实体关系→章节检索→全文检索→原始文档），每层返回关联信息和下一步查询建议，LLM 可精准定位知识

---

### 10. 多 LLM 提供商支持

- 支持多种 LLM 提供商：
  - **国产服务商**：
    - DeepSeek（深度求索）— 支持 deepseek-chat、deepseek-reasoner 等模型，支持思考模式
    - 通义千问（Qwen）— 支持 qwen-plus、qwen-max、QwQ 等模型，支持思考模式
    - 智谱 AI（GLM）— 支持 glm-4-flash、GLM-Z1 等模型
    - 火山引擎（豆包）— 支持 doubao 系列模型
    - Moonshot（Kimi）— 支持 moonshot-v1 系列模型
    - 零一万物（Yi）— 支持 yi-lightning 等模型
  - **国际服务商**：
    - OpenAI
    - OpenAI 兼容接口（如 Llama.cpp、vLLM、Ollama OpenAI 模式）
    - Groq
    - Mistral AI
    - xAI (Grok)
    - Azure OpenAI
    - Google Vertex AI
    - AWS Bedrock

- **思考模式（Reasoning/Thinking）**：
  - 每个模型可独立配置是否开启思考模式
  - 支持 DeepSeek Reasoner 的 `reasoning_content` 字段
  - 支持 `<think/>` 标签解析（兼容 DeepSeek Chat 等）
  - 支持通义千问的 `enable_thinking` 参数
  - 可配置思考预算（thinking_budget）
  - 工作台对话界面支持思考过程折叠/展开展示

- **专业模型配置**：
  - 每个模型可独立设置 Temperature、Max Tokens、Top P
  - 支持频率惩罚（frequency_penalty）和存在惩罚（presence_penalty）
  - 支持额外请求头（extra_headers）和额外请求体（extra_body）
  - 选择服务商类型时自动填充默认端点和模型

- 连接测试功能：轻量 ping 验证连通性和延迟

---

### 11. 全局配置管理

- **LLM 配置**：多提供商增删改查，连接测试
- **MCP 服务器配置**：管理 MCP 服务器连接
- **技能管理**：查看和管理已安装的 Claude Skills
- **存储设置**：数据存储目录选择，自动备份配置
- **外观设置**：亮色/暗色主题，字体大小，界面语言
- **关于页面**：版本信息，检查更新，导出日志

---

## 当前实现方案

### 1. 进程架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          主进程 (Main Process)                           │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │   Database Service    │  │   File Parser Svc     │                  │
│  │   (better-sqlite3)    │  │                       │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │   LLM Client Service  │  │   RAG Service         │                  │
│  │                       │  │   (LanceDB)           │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │   OCR Service         │  │   Project Mgmt Svc    │                  │
│  │   (Tesseract.js)      │  │                       │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │   KB Service          │  │   Task Queue Svc      │                  │
│  │   (独立知识库)        │  │                       │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                     LightAgent 智能代理系统                        │ │
│  │  ┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────┐ │ │
│  │  │  Agent Core         │  │  Tool Registry      │  │  Skill Mgr  │ │ │
│  │  │  (思维链/工具调用)  │  │  (13+内置工具)      │  │  (Claude)   │ │ │
│  │  └─────────────────────┘  └─────────────────────┘  └─────────────┘ │ │
│  │  ┌─────────────────────┐  ┌─────────────────────┐                  │ │
│  │  │  Tool Dispatcher    │  │  Knowledge Query    │                  │ │
│  │  │                     │  │  Tools              │                  │ │
│  │  └─────────────────────┘  └─────────────────────┘                  │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │  Employee Profiling   │  │  Skill Registry Svc   │                  │
│  │  Svc (智能画像分析)   │  │                       │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │  Employee Agent Svc   │  │  Knowledge Processor  │                  │
│  │                       │  │  Svc                  │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────┐  ┌───────────────────────┐                  │
│  │  Tool Engine Svc      │  │  MCP Integration      │                  │
│  │                       │  │                       │                  │
│  └───────────────────────┘  └───────────────────────┘                  │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                  模块化 IPC 处理器 (类型安全)                        │ │
│  │  app | employee | kb | llm | project | task | tool                 │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
                                        │
                              ┌───────────────┐
                              │  Preload 桥接 │
                              │  (contextBridge)│
                              └───────────────┘
                                        │
┌────────────────────────────────────────────────────────────────────────┐
│                      渲染进程 (Renderer Process)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │Dashboard │  │ Project  │  │ Employee │  │Employee  │  │ Settings │  │
│  │  Page    │  │ Detail   │  │Workbench │  │Settings  │  │  Page    │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐                                          │
│  │   KB     │  │ Employee │                                          │
│  │  Page    │  │ Manager  │                                          │
│  └──────────┘  └──────────┘                                          │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │                  Zustand Store (全局状态管理)                      │ │
│  └───────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```


### 2. 核心数据流

#### 智能数字员工创建流程（最新）

```
用户选择知识库
    ↓
Employee Profiling Service 加载知识库内容
    ├─ 全局摘要
    ├─ 文档摘要
    ├─ 关键实体
    └─ 章节样本
    ↓
LLM 智能分析（流式输出思考过程
    ↓
生成员工画像
    ├─ 角色名称
    ├─ 角色描述
    ├─ 职责列表
    ├─ 性格特质
    ├─ 工作风格
    └─ 建议工具
    ↓
生成技能建议
    ├─ 技能类型
    ├─ 技能描述
    ├─ Prompt 模板
    ├─ 业务规则
    └─ 测试用例
    ↓
用户确认/编辑配置
    ↓
创建数字员工记录（employees 表）
    ↓
关联知识库关联
    ↓
配置工具/技能/MCP
    ↓
数字员工启用完成
    ↓
进入工作台对话
```

#### 传统数字员工创建流程（兼容）

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

#### LightAgent 智能代理对话流程（最新）

```
用户输入消息
    ↓
LightAgent 初始化
    ├─ 加载员工配置
    ├─ 注册可用工具（内置/MCP/技能）
    ├─ 构建系统 Prompt
    └─ 加载对话历史
    ↓
思维链（可选）
    ├─ 分析用户需求
    ├─ 规划工具使用
    └─ 过滤工具列表
    ↓
LLM 调用（流式）
    ├─ 输出思考过程（reasoning_content）
    ├─ 输出文本内容
    └─ 或决定调用工具
    ↓
如果需要工具调用？
    ├─ 是 → Tool Dispatcher 执行工具
    │       ├─ 内置工具（13+）
    │       ├─ MCP 服务器工具
    │       ├─ Claude Skills 工具
    │       └─ 知识库查询工具
    │           ├─ kb_overview
    │           ├─ query_global_summary
    │           ├─ query_knowledge_graph
    │           ├─ query_chapters
    │           ├─ query_fulltext
    │           ├─ get_document_content
    │           └─ generate_timeline
    │       ↓
    │       获取工具结果
    │       ↓
    │       将结果添加到对话上下文
    │       ↓
    │       回到 LLM 调用（循环）
    │
    └─ 否 → 继续
    ↓
最终回答生成
    ↓
流式输出到前端
    ├─ 思考过程折叠显示
    ├─ 文本内容打字机效果
    └─ 工具调用详情展示
    ↓
对话消息保存
```

#### RAG 增强对话流程（兼容）

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
│   ├── main/                          # 主进程入口和服务
│   │   ├── index.ts                   # 主进程入口，窗口管理
│   │   ├── ipc-handlers.ts            # IPC 处理器注册（统一入口）
│   │   ├── ipc/                       # 模块化 IPC 处理器
│   │   │   ├── app.handlers.ts        # 应用相关 IPC
│   │   │   ├── employee.handlers.ts   # 员工相关 IPC
│   │   │   ├── kb.handlers.ts         # 知识库相关 IPC
│   │   │   ├── llm.handlers.ts        # LLM 相关 IPC
│   │   │   ├── project.handlers.ts    # 项目相关 IPC
│   │   │   ├── task.handlers.ts       # 任务队列相关 IPC
│   │   │   ├── tool.handlers.ts       # 工具相关 IPC
│   │   │   └── index.ts               # IPC 处理器导出
│   │   └── services/                  # 核心服务
│   │       ├── agent/                 # LightAgent 智能代理系统
│   │       │   ├── agent.ts           # LightAgent 核心类
│   │       │   ├── agent.types.ts     # Agent 相关类型定义
│   │       │   ├── tool-registry.ts   # 工具注册表
│   │       │   ├── tool-dispatcher.ts # 工具调用分发器
│   │       │   ├── skill-manager.ts   # Claude Skills 管理
│   │       │   ├── skill.types.ts     # 技能相关类型
│   │       │   ├── builtin-tools.ts   # 内置工具导出
│   │       │   ├── tools/             # 内置工具实现
│   │       │   │   ├── calculator.tool.ts
│   │       │   │   ├── date-time.tool.ts
│   │       │   │   ├── string-utils.tool.ts
│   │       │   │   ├── shell-exec.tool.ts
│   │       │   │   ├── read-file.tool.ts
│   │       │   │   ├── write-file.tool.ts
│   │       │   │   ├── list-dir.tool.ts
│   │       │   │   ├── system-info.tool.ts
│   │       │   │   ├── web-search.tool.ts
│   │       │   │   ├── web-fetch.tool.ts
│   │       │   │   ├── json-utils.tool.ts
│   │       │   │   ├── random-utils.tool.ts
│   │       │   │   ├── env-vars.tool.ts
│   │       │   │   ├── utils.ts
│   │       │   │   └── index.ts
│   │       │   └── index.ts           # Agent 模块导出
│   │       ├── database.service.ts    # SQLite 数据库服务
│   │       ├── file-parser.service.ts # 文件解析服务
│   │       ├── llm-client.service.ts  # LLM 客户端服务
│   │       ├── rag.service.ts         # RAG 向量检索服务
│   │       ├── knowledge-processor.service.ts  # 知识处理服务
│   │       ├── kb.service.ts          # 独立知识库服务
│   │       ├── employee-profiling.service.ts   # 员工画像分析服务
│   │       ├── employee-agent.service.ts       # 员工代理服务
│   │       ├── skill-registry.service.ts       # 技能注册表服务
│   │       ├── tool-engine.service.ts          # 工具引擎服务
│   │       ├── task-queue.service.ts  # 后台任务队列服务
│   │       ├── ocr.service.ts         # OCR 识别服务
│   │       ├── project-manager.service.ts # 项目管理服务
│   │       ├── rule-extraction.service.ts # 规则抽取引擎
│   │       └── sandbox-tester.service.ts  # 沙盒测试服务
│   ├── preload/                       # 预加载脚本
│   │   └── index.ts                   # ContextBridge API 暴露
│   └── shared/                        # 共享类型和常量
│       ├── channels/                  # IPC 通道定义（模块化）
│       │   ├── app.ts
│       │   ├── employee.ts
│       │   ├── kb.ts
│       │   ├── llm.ts
│       │   ├── project.ts
│       │   ├── tool.ts
│       │   └── index.ts
│       ├── ipc-channels.ts            # IPC 通道统一导出
│       └── types.ts                   # 共享数据类型
├── skills/                            # Claude Skills 技能目录
│   └── example/                       # 示例技能
│       └── SKILL.md
├── src/                               # 渲染进程（React 前端）
│   ├── pages/                         # 页面组件
│   │   ├── Dashboard.tsx              # 仪表盘首页
│   │   ├── ProjectDetail.tsx          # 项目详情/文件管理
│   │   ├── CreationWizard.tsx         # 数字员工创建向导
│   │   ├── DocumentViewer.tsx         # 文档预览/解析结果
│   │   ├── KnowledgeBase.tsx          # 独立知识库管理页面
│   │   ├── EmployeeWorkbench.tsx      # 数字员工工作台
│   │   ├── EmployeeSettings.tsx       # 数字员工配置管理
│   │   ├── employee-settings/         # 员工配置子组件
│   │   │   ├── EmployeeLLMConfig.tsx
│   │   │   ├── ToolConfigPanel.tsx
│   │   │   ├── MCPServerPanel.tsx
│   │   │   └── SkillRegistryPanel.tsx
│   │   ├── EmployeeManager.tsx        # 员工管理列表
│   │   ├── ProjectManager.tsx         # 项目管理列表
│   │   └── Settings.tsx               # 全局设置
│   ├── components/                    # 通用组件
│   │   ├── common/                    # 基础组件
│   │   │   ├── EmptyState.tsx
│   │   │   ├── PageHeader.tsx
│   │   │   └── TaskProgressPanel.tsx
│   │   ├── file/                      # 文件相关组件
│   │   │   ├── FileList.tsx
│   │   │   └── FileUploadZone.tsx
│   │   └── llm/                       # LLM 相关组件
│   │       └── LLMSelector.tsx
│   ├── stores/                        # Zustand 状态管理
│   │   └── app.store.ts
│   ├── types/                         # TypeScript 类型定义
│   │   └── index.ts
│   ├── router/                        # 路由配置
│   │   └── index.tsx
│   ├── styles/                        # 全局样式
│   │   └── index.css
│   ├── App.tsx                        # 应用根组件
│   └── main.tsx                       # 应用入口
├── resources/                         # 打包资源
│   └── icons/                         # 应用图标
├── tests/                             # 测试目录
│   ├── unit/                          # 单元测试
│   └── e2e/                           # E2E 测试
├── .trae/                             # Trae IDE 配置
│   └── rules/                         # 项目规则
│       └── 进展规范.md
├── package.json                       # 项目配置
├── package-lock.json                  # 依赖锁定文件
├── tsconfig.json                      # TypeScript 配置
├── tsconfig.node.json                 # Node TypeScript 配置
├── vite.config.ts                     # Vite 配置
├── electron-builder.yml               # Electron Builder 打包配置
├── index.html                         # HTML 入口
└── README.md                          # 本文档
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
