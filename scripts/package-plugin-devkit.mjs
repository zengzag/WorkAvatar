#!/usr/bin/env node
// scripts/package-plugin-devkit.mjs
//
// 打包 WorkAvatar 插件开发包（面向第三方开发者，脱离本仓库独立开发）。
// plugin-devkit/ 目录即开发包内容，本脚本负责：
//   1. 同步 SDK 类型契约（plugins/plugin-sdk → plugin-devkit/plugin-sdk）
//   2. 同步文档（docs/plugins/*.md → plugin-devkit/docs/）
//   3. 生成开发包 README
//   4. 压缩 plugin-devkit/ 成 release/plugin-devkit-v<version>.zip
//
// 用法：
//   node scripts/package-plugin-devkit.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')

// 开发包版本（与宿主协议版本对齐，便于第三方判断兼容性）
const DEVKIT_VERSION = '0.2.0'

const devkitRoot = path.join(projectRoot, 'plugin-devkit')

/** 复制目录（递归，跳过 node_modules / dist / release 等构建产物） */
function copyDir(src, dest, skip = ['node_modules', 'dist', 'release']) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d, skip)
    else fs.copyFileSync(s, d)
  }
}

/** 复制单个文件 */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
}

/** 生成开发包根 README（使用说明） */
function buildReadme() {
  return `# WorkAvatar 插件开发包 v${DEVKIT_VERSION}

本开发包面向第三方开发者，让你**脱离 WorkAvatar 源码仓库**独立创建、编译、打包一个可用的 WorkAvatar 插件。

## 目录结构

\`\`\`
plugin-devkit/
├── README.md                    # 本文件
├── docs/                        # 插件开发文档
│   ├── PLUGIN_DEVELOPMENT.md    # 开发与打包教程（从零开始）
│   ├── API_REFERENCE.md         # 接口签名参考
│   └── CAPABILITY_MATRIX.md     # 能力矩阵
├── plugin-sdk/                  # 插件协议类型契约（TypeScript 类型）
└── plugin-template/             # 独立模板工程（自包含，可 npm install + 构建）
    ├── package.json
    ├── tsconfig.json
    ├── build-plugin.mjs         # 参数化构建脚本（可在任意目录运行）
    ├── manifest.json
    ├── src/main/index.ts        # 主进程入口
    ├── src/renderer/index.tsx   # 渲染端入口
    └── locale/                  # 多语言文案
\`\`\`

## 快速开始

1. **复制模板**：把 \`plugin-template/\` 整个复制一份，改名为你的插件名（如 \`my-plugin/\`）。
2. **安装依赖**：在模板目录执行 \`npm install\`（仅需一次）。
3. **改 manifest**：编辑 \`manifest.json\`，修改 \`id\`（小写连字符，≤64 字符，避开保留字 \`settings/tasks/employees/list/invoke/event\`）、\`name\`、\`version\`、\`engine\`（当前为 \`>=0.2.0\`）、\`ipc\`、\`capabilities\`、\`nav\`。
4. **写代码**：在 \`src/main/index.ts\` 写主进程逻辑，在 \`src/renderer/index.tsx\` 写界面。
5. **构建**：在模板目录执行 \`npm run build\`（或 \`node build-plugin.mjs\`）。
6. **打包**：执行 \`npm run build:zip\`（或 \`node build-plugin.mjs --zip\`），产出 \`release/plugins/<id>-v<version>.zip\`。

## 安装到 WorkAvatar

用户侧两种方式（效果一致）：

1. **导入 zip**：应用设置 → 插件 → 「导入插件」，选择 \`<id>-v<version>.zip\`。
2. **手动放入目录**：解压 zip 到 \`userData/plugins/<id>/\`，重启应用自动识别。

任意方式安装后**重启应用生效**。插件数据目录 \`userData/plugin-data/<id>/\` 在重装/禁用时不删除，升级不丢用户数据。

## 类型引用

模板源码通过 \`@workavatar/plugin-sdk\` 引用类型（tsconfig \`paths\` 已映射到 \`../plugin-sdk/src\`）：

\`\`\`ts
import type { PluginContext } from '@workavatar/plugin-sdk'
import type { PluginRendererEntry, PluginRendererHost } from '@workavatar/plugin-sdk/renderer'
\`\`\`

## 构建脚本说明

\`build-plugin.mjs\` 是参数化构建脚本，可在任意目录运行：

\`\`\`bash
node build-plugin.mjs [pluginDir]        # 构建到 dist/（默认当前目录）
node build-plugin.mjs [pluginDir] --zip  # 构建并产出分发包 zip
\`\`\`

- 主进程入口（\`dist/main/index.cjs\`）→ CJS
- 渲染端入口（\`dist/renderer/index.js\`）→ ESM，react/antd 等经 \`__WA_HOST__\` 单例 shim，无需安装这些运行时依赖
- zip 仅含运行时必需文件：\`manifest.json\` + \`dist/**\` + \`locale/**\` + \`resources/**\`

## 版本兼容

- \`engine\` 声明宿主协议兼容范围（当前 \`>=0.2.0\`），不满足会被禁用（不崩溃）。
- 升级插件：宿主按 \`id\` 判定已安装，升级即删除旧安装目录重装新包，运行时数据保留。

## 详细文档

- 开发与打包教程：[docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md)
- 接口签名：[docs/API_REFERENCE.md](docs/API_REFERENCE.md)
- 能力矩阵：[docs/CAPABILITY_MATRIX.md](docs/CAPABILITY_MATRIX.md)
`
}

async function main() {
  const AdmZip = require('adm-zip')

  // 1. 同步 SDK 类型契约
  const sdkSrc = path.join(projectRoot, 'plugins', 'plugin-sdk')
  const sdkDest = path.join(devkitRoot, 'plugin-sdk')
  fs.rmSync(sdkDest, { recursive: true, force: true })
  copyDir(sdkSrc, sdkDest)

  // 2. 同步文档
  const docsDest = path.join(devkitRoot, 'docs')
  fs.rmSync(docsDest, { recursive: true, force: true })
  for (const name of ['PLUGIN_DEVELOPMENT.md', 'API_REFERENCE.md', 'CAPABILITY_MATRIX.md']) {
    copyFile(path.join(projectRoot, 'docs', 'plugins', name), path.join(docsDest, name))
  }

  // 3. 复制模板（单一权威源 plugins/examples/hello-world → plugin-template，随开发包分发）
  const templateSrc = path.join(projectRoot, 'plugins', 'examples', 'hello-world')
  const templateDest = path.join(devkitRoot, 'plugin-template')
  fs.rmSync(templateDest, { recursive: true, force: true })
  copyDir(templateSrc, templateDest)

  // 4. 同步构建脚本（单一权威源 scripts/build-plugin.mjs → 模板，随开发包分发）
  copyFile(
    path.join(projectRoot, 'scripts', 'build-plugin.mjs'),
    path.join(templateDest, 'build-plugin.mjs')
  )

  // 5. 改写模板 tsconfig 的 SDK paths 为开发包内相对路径
  //    （仓库内 hello-world 在 plugins/examples/ 深 3 层，开发包内模板在 plugin-template/ 深 2 层，
  //     相对 plugin-sdk 的级数不同，需改写为开发包级数）
  const tsconfigPath = path.join(templateDest, 'tsconfig.json')
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'))
  if (tsconfig.compilerOptions?.paths?.['@workavatar/plugin-sdk']) {
    tsconfig.compilerOptions.paths['@workavatar/plugin-sdk'] = ['../plugin-sdk/src']
    tsconfig.compilerOptions.paths['@workavatar/plugin-sdk/*'] = ['../plugin-sdk/src/*']
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + '\n', 'utf-8')
  }

  // 6. 生成 README
  fs.writeFileSync(path.join(devkitRoot, 'README.md'), buildReadme(), 'utf-8')

  // 7. 清理模板构建产物（node_modules/dist/release 不进开发包，第三方自行 npm install）
  for (const dir of ['node_modules', 'dist', 'release']) {
    fs.rmSync(path.join(templateDest, dir), { recursive: true, force: true })
  }

  // 8. 压缩 plugin-devkit/ 成 zip
  const outDir = path.join(projectRoot, 'release', 'plugin-devkit')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `plugin-devkit-v${DEVKIT_VERSION}.zip`)
  const zip = new AdmZip()
  zip.addLocalFolder(devkitRoot, 'plugin-devkit')
  zip.writeZip(outPath)

  const size = fs.statSync(outPath).size
  console.log(`[package-plugin-devkit] 开发包已生成：${path.relative(projectRoot, outPath)} (${(size / 1024).toFixed(1)} KB)`)
}

main().catch((err) => {
  console.error(`[package-plugin-devkit] 执行失败: ${err?.message || err}`)
  process.exit(1)
})
