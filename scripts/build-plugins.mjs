#!/usr/bin/env node
// scripts/build-plugins.mjs
//
// 批量构建 plugins/ 下的所有插件（薄封装，核心逻辑见 scripts/build-plugin.mjs）：
// - 扫描 plugins/ 下各子目录（跳过 plugin-sdk），读取 manifest.json
// - 逐个调用 scripts/build-plugin.mjs 构建（主进程 CJS + 渲染端 ESM）
// - --zip 产出独立分发包 release/plugins/<id>-v<version>.wap
//
// 用法：
//   node scripts/build-plugins.mjs [pluginId]       # 构建全部或指定插件到 dist/
//   node scripts/build-plugins.mjs [pluginId] --zip # 构建并存放独立分发包 release/plugins/<id>-v<ver>.wap
//   node scripts/build-plugins.mjs [pluginId] --zip --no-source # 同上，但打包时排除源码（默认含源码）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const pluginsRoot = path.join(projectRoot, 'plugins')
const buildScript = path.join(scriptDir, 'build-plugin.mjs')

async function main() {
  const args = process.argv.slice(2)
  const zipMode = args.includes('--zip')
  const onlyId = args.find(a => !a.startsWith('--'))
  // 扫描 plugins/ 下各插件目录；examples/ 作为示例目录递归扫描其子目录
  // （plugins/ 为 git submodule，含 .git/node_modules/tests/ 等非插件目录，跳过）
  const dirs = []
  for (const e of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'plugin-sdk' || e.name === 'tests' || e.name === 'node_modules') continue
    if (e.name === 'examples') {
      for (const sub of fs.readdirSync(path.join(pluginsRoot, 'examples'), { withFileTypes: true })) {
        if (sub.isDirectory()) dirs.push(`examples/${sub.name}`)
      }
    } else {
      dirs.push(e.name)
    }
  }

  let targets
  if (onlyId) {
    // 支持两种写法：examples/hello-world 或 hello-world（后者匹配 examples/ 下子目录）
    targets = dirs.filter((id) => id === onlyId || id === `examples/${onlyId}`)
    if (targets.length === 0) {
      console.error(`[build-plugins] 未找到插件 "${onlyId}"（plugins/ 下现有：${dirs.join(', ') || '无'}）`)
      process.exit(1)
    }
  } else {
    targets = dirs
  }

  if (targets.length === 0) {
    console.log('[build-plugins] plugins/ 下没有可构建的插件')
    return
  }

  let built = 0
  let failed = 0

  for (const id of targets) {
    const pluginDir = path.join(pluginsRoot, id)
    const manifestPath = path.join(pluginDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) {
      console.warn(`[build-plugins] 跳过 ${id}：缺少 manifest.json`)
      continue
    }
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
      failed++
      console.error(`[build-plugins] ✗ ${id}: manifest.json 解析失败: ${err.message}`)
      continue
    }
    if (!manifest.main) {
      console.warn(`[build-plugins] 跳过 ${id}：manifest 缺少 main 入口（纯源码类型插件？）`)
      continue
    }

    const childArgs = [buildScript, pluginDir]
    if (zipMode) {
      childArgs.push('--zip')
      // 仓库内统一输出到项目根 release/plugins/（与文档/build.ps1 一致），保证 5 个插件 zip 集中产出
      childArgs.push('--out', path.join(projectRoot, 'release', 'plugins'))
      if (args.includes('--no-source')) childArgs.push('--no-source')
    }
    const res = spawnSync(process.execPath, childArgs, { stdio: 'inherit' })
    if (res.status === 0) built++
    else failed++
  }

  console.log(`[build-plugins] 完成：${built} 成功，${failed} 失败`)
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error(`[build-plugins] 执行失败: ${err?.message || err}`)
  process.exit(1)
})
