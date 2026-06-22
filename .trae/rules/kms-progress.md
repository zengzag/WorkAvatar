# AI原生本地知识库搜索引擎（KMS）开发进度

## 项目概述

构建一个AI Agent原生的本地知识库工具，让AI主智能体能像使用`grep`一样快速、精准地检索海量本地文档，并具备上下文隔离和渐进式学习能力。

## 三阶段计划

### 第一阶段：独立搜索引擎

**目标**：构建高性能底层搜索引擎，独立文件夹放置，功能无耦合。

**状态**：✅ 已完成

#### 已完成文件

| 文件 | 职责 |
|---|---|
| `electron/main/services/kms/kms-database.service.ts` | KMS独立SQLite数据库，管理索引目录、文件注册表、FTS5索引、向量嵌入、冷热数据、访问追踪 |
| `electron/main/services/kms/kms-crawler.service.ts` | 目录爬虫，扫描索引目录、检测文件变更（新增/修改/删除）、增量索引、访问统计 |
| `electron/main/services/kms/kms-search-engine.service.ts` | 核心搜索引擎，FTS5全文检索+向量语义搜索+混合搜索+时间范围过滤+文件扩展名过滤 |
| `electron/main/services/kms/kms-index-manager.service.ts` | 索引管理器，全量/增量/重建索引、向量嵌入生成、冷热数据晋升/降级评估 |
| `electron/main/services/kms/kms.service.ts` | 顶层外观服务，组合爬虫/搜索引擎/索引管理器，提供统一API |
| `electron/shared/channels/kms.ts` | KMS IPC通道定义（13个通道） |
| `electron/main/ipc/kms.handlers.ts` | KMS IPC处理器注册 |
| `electron/main/services/path.service.ts` | 新增`getKMSDbPath()`方法 |

#### 数据库表结构

- `kms_index_dirs` — 索引目录配置（路径、是否递归、文件扩展名过滤）
- `kms_files` — 文件注册表（路径、hash、索引状态、冷热层级）
- `kms_paragraphs` — 文件内容段落（热数据：深度摘要和向量化后的段落）
- `kms_file_summaries` — 文件摘要（热数据）
- `kms_search_index` — 搜索索引（标题/摘要/段落/原文内容段落）
- `kms_fts` — FTS5全文检索虚拟表（unicode61分词）
- `kms_embeddings` — 向量嵌入表（BLOB格式Float32Array）
- `kms_access_log` — 访问追踪表（用于冷热数据判定）

#### IPC通道清单

| 通道 | 功能 |
|---|---|
| `kms:list-dirs` | 列出所有索引目录 |
| `kms:add-dir` | 添加索引目录 |
| `kms:update-dir` | 更新索引目录配置 |
| `kms:delete-dir` | 删除索引目录 |
| `kms:search` | 搜索（关键词/语义/混合） |
| `kms:get-file-content` | 获取文件内容（段落/偏移/行号定位） |
| `kms:get-file-summary` | 获取文件摘要 |
| `kms:build-index` | 构建全量索引 |
| `kms:incremental-index` | 增量索引 |
| `kms:rebuild-dir-index` | 重建指定目录索引 |
| `kms:cancel-index` | 取消索引任务 |
| `kms:get-stats` | 获取统计信息 |
| `kms:index-progress` | 索引进度通知（主→渲染） |

#### 核心特性

1. **FTS5全文检索**：unicode61分词，支持前缀匹配，FTS5失败时降级为手动关键词匹配
2. **向量语义搜索**：余弦相似度计算，内存缓存嵌入向量
3. **混合搜索**：BM25权重0.6 + 向量权重0.4，合并去重后按加权分排序
4. **时间范围过滤**：按文件修改时间筛选
5. **文件扩展名过滤**：按文件类型筛选
6. **冷热数据管理**：
   - 冷数据：仅索引文件名和关键词
   - 热数据：额外生成摘要和段落索引
   - 晋升条件：30天内搜索命中≥5次或读取≥3次
   - 降级条件：90天无访问
7. **增量索引**：基于文件hash检测变更，仅处理新增/修改的文件
8. **访问追踪**：记录搜索命中和读取行为，用于冷热数据判定
9. **LRU搜索缓存**：TTL 60秒，最大100条

---

### 第二阶段：UI层搜索工具

**目标**：基于Electron提供独立UI面板，放到导航中知识库下面。

**状态**：✅ 已完成

#### 已完成文件

| 文件 | 职责 |
|---|---|
| `src/pages/KMS.tsx` | KMS主页面，搜索为主视图 + 设置Drawer（目录管理/索引管理） + 文件预览Modal |
| `src/hooks/useKMS.ts` | KMS业务逻辑Hook，封装所有IPC调用和状态管理，含openFile/openFileDir/getFileFullContent/previewFile |
| `src/components/kms/HighlightText.tsx` | 关键词高亮组件，支持highlights范围和keywords关键词数组两种模式 |
| `src/components/kms/KMSSearchPanel.tsx` | 搜索面板，搜索输入/模式选择/高级筛选（目录/格式/时间范围）/结果列表（含高亮、操作按钮） |
| `src/components/kms/KMSFilePreview.tsx` | 文件预览Modal，全文本展示+关键词高亮+自动定位到搜索结果位置 |
| `src/components/kms/KMSDirPanel.tsx` | 索引目录管理面板，目录列表/添加/删除/启用禁用 |
| `src/components/kms/KMSIndexPanel.tsx` | 索引管理面板，统计卡片/构建索引/增量更新/进度显示 |
| `src/components/kms/index.ts` | 组件统一导出 |
| `src/router/index.tsx` | 新增`/kms`路由 |
| `src/App.tsx` | 侧边栏新增"本地搜索"导航项 |
| `src/i18n/locales/zh-CN.ts` | 新增`kms.*`共50+个中文翻译键 |
| `src/i18n/locales/en-US.ts` | 新增`kms.*`共50+个英文翻译键 |

#### 第一阶段优化（UI开发中发现并完善）

- **搜索引擎增强**：`SearchResult`新增`highlights`（高亮范围数组）和`matched_keywords`（匹配关键词列表）字段
- **高亮计算**：新增`computeHighlights()`方法，在文本中定位所有关键词出现位置，合并重叠范围
- **FTS搜索**：`ftsSearch`和`fallbackKeywordSearch`均返回高亮信息
- **混合搜索**：`hybridSearch`结果同样包含高亮信息
- **MD5去重**：文件注册和更新时检查相同hash，相同内容文件复用索引数据（`cloneIndexData`），避免重复计算
- **增量索引独立**：`incrementalIndex`不再委托`buildFullIndex`，独立实现并先删除modified文件旧索引
- **目录重建优化**：`rebuildDirIndex`不再调用`buildFullIndex`全量重建，只处理指定目录文件
- **IPC防克隆错误**：索引操作改用`ipcMain.on`/`ipcRenderer.send`（fire-and-forget），`safeHandle`返回值用`JSON.parse(JSON.stringify())`净化

#### UI功能

1. **搜索面板（主视图）**：
   - 搜索输入框 + Enter快捷搜索
   - 三种搜索模式切换（关键词/语义/混合）
   - 高级筛选（可折叠）：目录多选、文件格式多选、时间范围日期选择
   - 搜索结果卡片：文件图标、可点击文件名、路径、匹配类型标签、高亮文本、行号范围、匹配关键词标签
   - 结果操作按钮：打开文件（系统默认程序）、打开目录（资源管理器定位）、预览
   - 混合搜索模式显示分数条
   - 加载中/无结果空状态

2. **文件预览**：
   - 全屏Modal展示文件完整文本内容
   - 所有搜索关键词高亮
   - 自动滚动到搜索结果命中位置（start_line/start_offset）
   - 预览头部含打开文件/打开目录按钮

3. **设置Drawer**（齿轮按钮触发）：
   - 索引目录管理：目录列表、添加/删除、启用开关
   - 索引管理：8个统计卡片、构建/增量/重建索引、进度显示、取消

---

### 第三阶段：搜索智能体

**目标**：设计独立的搜索子智能体，与数字员工智能体协同。

**状态**：⬜ 未开始

#### 计划功能

- 接收主智能体Query → 自主规划检索步骤
- 上下文隔离：子智能体思考链仅在内部闭环，最终输出仅包含"总结"与"文件路径+页码"清单
- 懒加载学习：高频命中文件自动触发后台Embedding生成摘要
- MCP/Tool Call接口：对外暴露标准化接口供第三方工具调用
