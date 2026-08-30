#!/usr/bin/env node
// scripts/sync-plugin-dev-skill.mjs
//
// 同步内置 plugin-dev skill（resources/skills/plugin-dev/）。
// 该 skill 是 WorkAvatar 插件开发 kit 的唯一来源（面向无源码的最终用户），本脚本从单一事实源刷新其内容：
//   1. references/：plugin-sdk 三份协议文档 + hello-world 开发教程与模板源文件（扁平化命名）
//   2. assets/plugin-sdk/：完整 SDK 类型契约（含 src/package.json/host-native-dependencies.json，
//      脚手架时复制到插件工程旁以支持 typecheck）
//   3. 对 PLUGIN_DEVELOPMENT.md 做场景适配改写：仓库内路径/命令 → skill 内 read_reference 提示
//
// 用法：
//   node scripts/sync-plugin-dev-skill.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')

const skillRoot = path.join(projectRoot, 'resources', 'skills', 'plugin-dev')

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

/** PLUGIN_DEVELOPMENT.md 场景适配：仓库内相对链接/命令在用户机器（只有安装包）上无效，改写为 skill 内提示 */
function adaptDevDoc(content) {
  return content
    // 开头文档链接 → read_reference 提示
    .replace(
      /协议细节见 \[API_REFERENCE\.md\]\(\.\.\/\.\.\/\.\.\/plugin-sdk\/API_REFERENCE\.md\)，能力矩阵见 \[CAPABILITY_MATRIX\.md\]\(\.\.\/\.\.\/\.\.\/plugin-sdk\/CAPABILITY_MATRIX\.md\)，类型契约见 \[plugin-sdk\]\(\.\.\/\.\.\/\.\.\/plugin-sdk\/\)；/,
      '协议细节用 read_reference 读取 `API_REFERENCE.md`，能力矩阵见 `CAPABILITY_MATRIX.md`，完整协议见 `PROTOCOL.md`（均为本技能 references）；'
    )
    // 仓库内构建命令 → 随技能分发的 build-plugin.mjs
    .replace(
      'WorkAvatar 仓库提供统一构建脚本 `node scripts/build-plugins.mjs`：',
      '构建脚本 `build-plugin.mjs` 随本技能提供（见参考资料 `hello-world.build-plugin.mjs`，复制到插件工程根目录使用）：'
    )
    .replaceAll('`scripts/build-plugins.mjs`', '`build-plugin.mjs`')
    .replaceAll('node scripts/build-plugins.mjs my-plugin', 'node build-plugin.mjs my-plugin')
    .replaceAll('node scripts/build-plugins.mjs', 'node build-plugin.mjs')
    // 独立仓库建议 → 使用随技能的构建脚本
    .replace(
      /如果你在\*\*独立仓库\*\*开发插件，复制上述构建思路即可（核心是主进程出 CJS、渲染端出被 shim 的 ESM、产出约定结构的包）。/,
      '本教程面向**脱离 WorkAvatar 源码仓库**的开发者：构建脚本 `build-plugin.mjs` 随本技能提供，复制到插件工程根目录即可使用。'
    )
}

function main() {
  // 1. references/：文档与模板源文件（扁平化命名，入 skill DB 供 read_reference 按需读取）
  const refsDir = path.join(skillRoot, 'references')
  fs.rmSync(refsDir, { recursive: true, force: true })
  fs.mkdirSync(refsDir, { recursive: true })

  const sdk = path.join(projectRoot, 'plugin-sdk')
  for (const doc of ['PROTOCOL.md', 'API_REFERENCE.md', 'CAPABILITY_MATRIX.md']) {
    copyFile(path.join(sdk, doc), path.join(refsDir, doc))
  }

  const tpl = path.join(projectRoot, 'plugins', 'examples', 'hello-world')
  const devDoc = fs.readFileSync(path.join(tpl, 'PLUGIN_DEVELOPMENT.md'), 'utf-8')
  fs.writeFileSync(path.join(refsDir, 'hello-world.PLUGIN_DEVELOPMENT.md'), adaptDevDoc(devDoc), 'utf-8')
  copyFile(path.join(tpl, 'manifest.json'), path.join(refsDir, 'hello-world.manifest.json'))
  copyFile(path.join(tpl, 'src', 'main', 'index.ts'), path.join(refsDir, 'hello-world.main.ts'))
  copyFile(path.join(tpl, 'src', 'renderer', 'index.tsx'), path.join(refsDir, 'hello-world.renderer.tsx'))
  copyFile(path.join(tpl, 'package.json'), path.join(refsDir, 'hello-world.package.json'))
  copyFile(path.join(tpl, 'tsconfig.json'), path.join(refsDir, 'hello-world.tsconfig.json'))
  copyFile(path.join(tpl, 'locale', 'zh-CN.json'), path.join(refsDir, 'hello-world.locale.zh-CN.json'))
  copyFile(path.join(tpl, 'locale', 'en-US.json'), path.join(refsDir, 'hello-world.locale.en-US.json'))
  copyFile(path.join(projectRoot, 'scripts', 'build-plugin.mjs'), path.join(refsDir, 'hello-world.build-plugin.mjs'))

  // 2. assets/plugin-sdk/：完整 SDK 类型契约（不进 DB，脚手架时用 shell_exec 复制到插件工程旁）
  const sdkDest = path.join(skillRoot, 'assets', 'plugin-sdk')
  fs.rmSync(sdkDest, { recursive: true, force: true })
  copyDir(sdk, sdkDest)

  console.log('[sync-plugin-dev-skill] 内置 plugin-dev skill 已同步（references + assets/plugin-sdk）')
}

main()
