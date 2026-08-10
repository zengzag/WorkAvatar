# D2 语法速查（v0.7.x · 本机实测验证）

> D2（Declarative Diagramming）：声明式图表脚本语言，文本即图表。
> 官方文档：https://d2lang.com/tour
> 图标库：https://icons.d2lang.com

## 1. 最小示例与命令行

```d2
# 注释用 #
用户 -> 系统: 请求
系统 -> 数据库: 查询
数据库: {
  shape: cylinder
}
```

```powershell
# 渲染为 SVG（矢量，推荐用于 Word/PPT）
& "C:\Program Files\D2\d2.exe" input.d2 output.svg
# 或用本 skill 的脚本
python scripts\render_d2.py input.d2
```

## 2. 基础元素

### 节点（Shape）
```d2
节点名            # 最简节点，key 即显示文本
节点名: {         # 带属性
  label: 显示文本  # 显示文本与 key 不同
  shape: rectangle
}
```

### 连接（Connection）
```d2
A -> B            # 有向
A -- B            # 无向
A <- B            # 反向
A <-> B           # 双向
A -> B: 标签       # 带标签
A -> B -> C       # 链式（等价于 A->B, B->C 两条）
```

### 容器（Container，层级嵌套，缩进表示）
```d2
服务层: {
  网关服务
  认证服务
}
# 跨容器连接用点号引用：客户端层.Web 门户 -> 服务层.认证服务
```

## 3. 常用 shape 类型

| shape | 用途 |
|---|---|
| `rectangle` | 默认矩形，通用 |
| `square` | 正方形 |
| `circle` / `oval` | 圆形 / 椭圆（开始/结束节点常用 oval） |
| `diamond` | 菱形（决策节点） |
| `parallelogram` | 平行四边形（输入/输出） |
| `hexagon` | 六边形（准备/处理） |
| `cylinder` | 圆柱（数据库/存储） |
| `queue` | 队列 |
| `page` | 页面/文档 |
| `cloud` | 云服务 |
| `person` | 人形图标 |
| `package` | 包/模块 |
| `step` | 步骤 |
| `text` | 纯文本（无边框） |
| `code` | 代码块（语法高亮） |
| `class` | UML 类图 |
| `sql_table` | 数据库表（带列定义） |

## 4. 样式（style）

```d2
节点: {
  style: {
    fill: "#e3f2fd"        # 填充色（支持 hex / 渐变）
    stroke: "#1565c0"       # 边框色
    stroke-width: 2         # 边框粗细 1-15
    stroke-dash: 3          # 虚线
    border-radius: 12       # 圆角 0-20
    shadow: true            # 阴影
    fill-pattern: dots      # 填充纹理：dots/lines/grain/none
    font-size: 16           # 字号 8-100
    font-color: "#333"      # 字色
    bold: true
    italic: true
    underline: true
    opacity: 0.8            # 透明度 0-1
  }
}
```

连接样式：
```d2
A -> B: {
  style: {
    stroke-dash: 3
    stroke: "#f00"
  }
}
```

## 5. 布局与方向

```d2
direction: right    # 全局方向：right / down / left / up（放文件顶部）
```

布局引擎（--layout 参数或 vars 配置）：
- `dagre`：默认，分层有向图（流程图首选）
- `elk`：ELK Layered，复杂分层架构图
- `grid`：网格布局

```d2
vars: {
  d2-config: {
    layout-engine: elk
    theme-id: 4        # 主题
  }
}
```

主题：`d2 themes` 查看全部；命令行 `--theme <ID>`。

## 6. 定位（near）——⚠️ 仅根级节点可用

> 实测（d2 v0.7.1）：`near` 限制严格，以下两种用法**都会报错**：
> - `node.near: 其他节点` → `"near" set to another object ... only supports constant values for near`（dagre/elk 均不支持）
> - 容器内节点 `C: { near: top-center }` → `constant near keys can only be set on root level shapes`
>
> **只有根级节点可用常量位置**：
```d2
B.near: top-center      # 仅根级 OK；top-left/top-center/top-right/center-left/
                        # center-right/bottom-left/bottom-center/bottom-right
```
想让某容器"靠边"布局：用独立根级容器 + 连接表达，不要用 near 引用。

## 7. 高级特性（简要）

```d2
# classes：复用样式
classes: {
  server: {
    style: {
      fill: "#e3f2fd"
      stroke: "#1565c0"
    }
  }
}
网关: class.server
认证: class.server

# 变量
vars: {
  d2-config: { theme-id: 300 }
}
```

- **箭头样式**：`source-arrowhead` / `target-arrowhead`，值：`triangle / diamond / circle / cf-one / cf-many`
- **多板（layers/scenarios）**：同一图表多种视图
- **LaTeX**：标签可用 `$公式$`（mathjax 渲染）
- **图标**：`icon: https://icons.d2lang.com/<name>.png`

## 8. 本机环境与陷阱（重要）

1. **d2.exe 不在 PATH**，必须用完整路径 `C:\Program Files\D2\d2.exe`（或设 D2_EXE 环境变量）。
2. **PNG/PPTX/PDF 导出需要 Playwright driver**，本机未安装 → 一律用 **SVG**；需要 PNG 时用 SKILL.md「Step 3.5 SVG → PNG 兜底」（Edge/Chrome headless，务必旧 `--headless` 模式）。
3. **`shape` 是节点属性，不能写在连接上**：
   - ❌ `A -> B: { shape: cylinder }`
   - ✅ `A -> B: 查询` + `B: { shape: cylinder }`
4. **中文标签**：.d2 文件必须 UTF-8 编码；默认不加字体参数中文即可正常渲染。如需固定字体只能用 **.ttf/.otf 单文件**（推荐 `C:\Windows\Fonts\simhei.ttf`）；**禁用 .ttc 集合字体**（msyh.ttc 等，d2 报 `expected .ttf file`）。
5. **保留字**（作 key 需加引号）：`shape style label width height icon tooltip link near direction`
6. **键名大小写不敏感**：`PostgreSQL` 与 `postgresql` 是同一节点。
7. 连接上的 `{}` 块只能写连接属性（`label` / `style` / `source-arrowhead` / `target-arrowhead`）。
8. **`near` 仅根级节点可用**（详见第 6 节）：节点引用、容器内 near 均报错。
9. **d2 成功信息走 stderr**：PowerShell `2>&1` 显示红色 `NativeCommandError` 属正常；渲染失败排查用 `render_d2.py` 或 `2> err.txt` 重定向（直接调用时 stderr 易丢失）。
10. SVG 插入 Word/PPT：矢量无损，可无限缩放；Word 的 docx 库要求 SVG 带 PNG fallback（fallback 必须含 `transformation`），PowerPoint 中可右键"转换为形状"后二次编辑。
