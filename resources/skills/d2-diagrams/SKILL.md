---
name: d2-diagrams
description: 使用 D2 声明式图表语言，将文本描述快速渲染为矢量 SVG 图，用于插入 Word/PPT 文档的系统架构图、业务流程图、网络拓扑、部署架构、ER 图、UML 图、时序图等。当用户要求"画一张架构图/流程图/拓扑图"、把文字描述变成图形、以可维护文本方式管理图表，且最终要放进 PPT 或 Word 时使用。产出 SVG 后可配合 pptx/docx skill 插入演示文稿或文档。不用于：照片/位图处理、数据统计图表（柱状/折线/饼图，应交给图表库）、纯手绘草图。
---

# D2 图表绘制（用于 PPT / Word）

## Overview

D2 是声明式图表语言：用缩进文本描述节点、连接、容器与样式，编译输出矢量 SVG。本 skill 负责「编写 .d2 → 渲染 SVG → 供 docx/pptx 插入」的完整链路。

**本机环境（已验证）**：
- d2 可执行文件：`C:\Program Files\D2\d2.exe`（**不在 PATH**，必须用完整路径，或设置环境变量 `D2_EXE`）
- 版本：v0.7.1；布局引擎：dagre（默认）、elk（均内置）
- ✅ **SVG 导出可用**（矢量、无损、中文正常）——本 skill 主推格式
- ❌ PNG/PPTX/PDF 直出需要 Playwright driver，本机未安装且不计划安装 → **一律输出 SVG**；如需 PNG（如 docx 插图的 fallback），用下方「SVG → PNG 兜底」方案

## 工作流

### Step 1 明确需求
确认图表类型与内容要点：
- 架构图（分层/组件/部署）→ 容器嵌套 + `layout: elk` 或 `direction: right`
- 流程图（业务/审批/决策）→ `direction: down` + `diamond` 决策节点
- 拓扑/ER/UML → 对应 shape（`cloud`/`cylinder`/`sql_table`/`class`）

### Step 2 编写 .d2 文件（UTF-8）
先读取语法速查 `references/d2-cheatsheet.md`，按需取用语法。要点：
- 文件保存为 **UTF-8**（无 BOM），中文标签直接写
- 大结构用容器缩进组织，跨容器连接用点号引用（`客户端层.Web 门户 -> 服务层.认证服务`）
- 决策/判断用 `shape: diamond`；数据库用 `shape: cylinder`；开始/结束用 `shape: oval`

### Step 3 渲染 SVG
```powershell
python <skill目录>\scripts\render_d2.py <input.d2> -o <output.svg> [--layout elk] [--theme 4]
```
脚本自动定位 d2.exe；SVG 输出后会打印像素尺寸，供文档排版参考。

**字体（重要）**：
- **默认不加字体参数即可**，中文正常渲染（SVG 由查看器回退系统字体，实测无异常）。
- 如需固定字体（防查看器回退差异），**只能用单文件 .ttf/.otf**，例如黑体 `C:\Windows\Fonts\simhei.ttf`：
```powershell
python scripts\render_d2.py input.d2 --font-regular C:\Windows\Fonts\simhei.ttf --font-bold C:\Windows\Fonts\simhei.ttf
```
- ⚠️ **禁止使用 .ttc 集合字体**（微软雅黑 `msyh.ttc`、宋体 `simsun.ttc` 等）：d2 直接报错 `expected .ttf file but ... has extension .ttc`，渲染失败且无 SVG 产出。

不要用 PNG/PPTX/PDF 格式（本机无 Playwright driver，脚本会报错并提示用 SVG）。

### Step 3.5 SVG → PNG 兜底（可选，供 docx/pptx 插图 fallback）
docx 库插入 SVG 时必须提供 PNG fallback（老版本 Word 兼容），本机无 Playwright，用 Edge/Chrome headless 截图实现（**务必用旧 `--headless` 模式**，`--headless=new` 实测偶发不产出文件）：
```powershell
# 先记下 SVG 像素尺寸（render_d2.py 会打印，或查 SVG 的 width/height）
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless --disable-gpu --hide-scrollbars --window-size=1025,1309 --screenshot="$(Join-Path (Get-Location) 'out.png')" "file:///C:/绝对/路径/out.svg"
```
要点：`--window-size` 填 SVG 实际像素宽高；`--screenshot` 用绝对路径；URL 必须是 `file:///` 形式（反斜杠转正斜杠）。Chrome 路径同理（`C:\Program Files\Google\Chrome\Application\chrome.exe`）。

### Step 4 插入文档
- **Word**：激活 docx skill，将 SVG 以图片形式插入（矢量，可缩放不糊）。⚠️ docx 库的 SVG `ImageRun` **必须提供 PNG fallback，且 fallback 必须带 `transformation`**（缺 transformation 时 SVG 会被静默丢弃、只写入 PNG）：
  ```js
  new ImageRun({
    type: "svg", data: svgBuf,
    fallback: { type: "png", data: pngBuf, transformation: { width: 460, height: 587 } },
    transformation: { width: 460, height: 587 },   // 单位 px（96dpi）
  })
  ```
  先用 Step 3.5 生成 PNG fallback。
- **PPT**：激活 pptx skill，将 SVG 插入幻灯片；PowerPoint 中可右键 SVG →「转换为形状」获得可编辑矢量图形

## D2 语法精要（完整版见 references/d2-cheatsheet.md）

```d2
direction: right            # 全局方向：right/down/left/up，放文件顶部

用户: { shape: person }     # 人形
用户 -> 前端: 访问          # 连接 + 标签

服务层: {                   # 容器（缩进嵌套）
  网关服务
  认证服务
}

数据库: { shape: cylinder } # 数据库
审核: { shape: diamond; label: 审核通过？ }  # 决策节点（分号可同行多属性）

# 样式
节点: {
  style: {
    fill: "#e3f2fd"
    stroke: "#1565c0"
    stroke-dash: 3          # 虚线
    border-radius: 12
    shadow: true
  }
}

# 连接样式：A -> B: { style: { stroke-dash: 3 } }
# 跨容器：客户端.Web 门户 -> 服务层.认证服务
```

## 常见错误与陷阱

1. **shape 是节点属性，不能写在连接上**：
   - ❌ `A -> B: { shape: cylinder }` → 编译失败
   - ✅ `A -> B: 查询`，再单独声明 `B: { shape: cylinder }`
2. **连接上的 `{}` 块**只能包含 `label` / `style` / 箭头相关属性。
3. **d2.exe 不在 PATH**：直接调 `d2` 会报"无法识别"；用脚本或完整路径 `C:\Program Files\D2\d2.exe`。
4. **别用 PNG/PPTX/PDF**：本机无 Playwright driver，导出失败。始终 SVG；需要 PNG 用 Step 3.5 兜底方案。
5. 键名大小写不敏感；保留字（`shape style label width height icon tooltip link near direction`）作 key 需加引号。
6. **渲染失败排查**（`d2 validate` 通过但仍渲染失败时）：
   - 优先用 `render_d2.py`（subprocess 捕获完整 stderr，能显示错误行号）；直接调 d2.exe 时用 `2> err.txt` 重定向保存错误，否则 PowerShell 环境下 stderr 易丢失。
   - 常见渲染期错误：用了 `near`（见下条）、`.ttc` 字体、特殊字符。逐条删除可疑行做**二分定位**（保留一半内容渲染测试，实测最快）。
7. **`near` 定位限制（本机实测）**：
   - `node.near: 其他节点`（引用对象）→ dagre/elk 均报错：`"near" set to another object ... only supports constant values for near`。**不可用**。
   - 容器内节点 `C: { near: top-center }` → 报错 `constant near keys can only be set on root level shapes`。**不可用**。
   - 仅根级节点可用常量位置：`B.near: top-center`（`top-left/top-center/top-right/center-left/center-right/bottom-left/bottom-center/bottom-right`）。要让某容器"靠边"放置，改用**独立根级容器 + 连接**表达，不要用 near 引用。
8. **d2 的编译成功信息走 stderr**（`success: successfully compiled ...`）：PowerShell 中 `2>&1` 会把 stderr 包装成红色 `NativeCommandError`，**属正常现象，不是报错**；`render_d2.py` 已正确处理。

## 参考文件
- `references/d2-cheatsheet.md` — D2 语法速查（shape 类型、样式、布局、陷阱）
- `examples/architecture.d2` — 三层架构图示例（可直接运行渲染）
- `examples/flowchart.d2` — 审批流程图示例（含决策菱形与样式）
- `scripts/render_d2.py` — 渲染封装脚本（UTF-8、自动定位 d2.exe、打印尺寸）
