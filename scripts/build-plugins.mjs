#!/usr/bin/env node
// scripts/build-plugins.mjs
//
// 统一构建 plugins/ 下的所有插件：
// - 扫描 plugins/ 下各子目录（跳过 plugin-sdk），读取 manifest.json
// - 主进程入口（manifest.main）→ CJS → dist/main/index.cjs（platform=node, target=node20）
// - 渲染端入口（manifest.renderer）→ ESM → dist/renderer/index.js（platform=browser, target=es2020, jsx=automatic）
// - 渲染端共享库经 __WA_HOST__ 单例注入：react/antd 等以 esbuild 虚拟模块 shim 内联，读取 globalThis.__WA_HOST__.*
//
// 用法：
//   node scripts/build-plugins.mjs [pluginId]      # 构建全部或指定插件到 dist/
//   node scripts/build-plugins.mjs [pluginId] --zip # 构建并存放独立分发包 release/plugins/<id>-v<ver>.zip
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const pluginsRoot = path.join(projectRoot, 'plugins')

/** 构建脚本内 require 已安装共享库，用于枚举导出名生成 shim */
const require = createRequire(import.meta.url)

/** node 内置模块：主进程入口全部 external（electron 一并 external） */
const NODE_BUILTINS = [
  'assert', 'path', 'fs', 'os', 'crypto', 'util', 'stream', 'events', 'buffer',
  'child_process', 'cluster', 'dns', 'http', 'https', 'net', 'tls', 'zlib', 'url',
  'querystring', 'punycode', 'string_decoder', 'readline', 'tty', 'perf_hooks',
  'async_hooks', 'v8', 'module', 'process', 'worker_threads',
]

/** 渲染端共享库 → __WA_HOST__ 全局命名空间映射（宿主在 globalThis.__WA_HOST__ 注入单例） */
const HOST_EXTERNALS = {
  react: '__WA_HOST__.React',
  'react-dom': '__WA_HOST__.ReactDOM',
  'react-dom/client': '__WA_HOST__.ReactDOM',
  'react/jsx-runtime': '__WA_HOST__.jsxRuntime',
  'react/jsx-dev-runtime': '__WA_HOST__.jsxRuntime',
  antd: '__WA_HOST__.antd',
  '@ant-design/icons': '__WA_HOST__.icons',
  i18next: '__WA_HOST__.i18n',
  'react-i18next': '__WA_HOST__.reactI18n',
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 合法 JS 标识符（排除 default 等非标识符导出） */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * 生成共享库 shim 模块源码：读取 __WA_HOST__ 全局单例，
 * 导出 default + 全部具名导出（从已安装包枚举，esbuild 会按需 tree-shake）。
 */
function buildShimCode(pkg, globalPath) {
  const ns = require(pkg)
  const keys = Object.keys(ns).filter((k) => k !== 'default' && IDENTIFIER_RE.test(k))
  const lines = [`const _m = globalThis.${globalPath};`, 'export default _m;']
  for (const k of keys) lines.push(`export const ${k} = _m.${k};`)
  return lines.join('\n')
}

/**
 * 渲染端共享库 → 宿主 __WA_HOST__ 单例：
 * 用 esbuild 虚拟模块（onResolve + onLoad）把共享库导入内联为读取 globalThis.__WA_HOST__.X 的 shim，
 * 产物不残留任何裸模块标识符（原生 ESM import() 无法解析 bare specifier）。
 */
function createHostExternalsPlugin() {
  return {
    name: 'wa-host-externals',
    setup(build) {
      for (const pkg of Object.keys(HOST_EXTERNALS)) {
        build.onResolve({ filter: new RegExp(`^${escapeRegExp(pkg)}$`) }, (args) => ({
          path: args.path,
          namespace: 'wa-host',
        }))
      }
      build.onLoad({ filter: /.*/, namespace: 'wa-host' }, (args) => ({
        contents: buildShimCode(args.path, HOST_EXTERNALS[args.path]),
        loader: 'js',
      }))
    },
  }
}

/**
 * CSS 内联插件：把插件内的 CSS 导入读取为源码，运行时注入 <style> 标签。
 * 宿主不提供插件专属 CSS（如 vditor、notes 样式），插件需自包含；
 * 相对路径（插件内 css）与裸路径（node_modules，如 vditor/dist/index.css）均可解析。
 */
function inlineCssPlugin() {
  return {
    name: 'inline-css',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (args) => ({
        path: args.path,
        namespace: 'wa-css',
        pluginData: { resolveDir: args.resolveDir },
      }))
      build.onLoad({ filter: /\.css$/, namespace: 'wa-css' }, (args) => {
        const resolveDir = args.pluginData?.resolveDir || projectRoot
        let fullPath = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(resolveDir, args.path)
        if (!fs.existsSync(fullPath)) {
          // 裸路径（如 vditor/dist/index.css）：回退到项目根解析
          const resolved = require.resolve(args.path, { paths: [projectRoot] })
          fullPath = resolved
        }
        const css = fs.readFileSync(fullPath, 'utf8')
        const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
        return {
          contents: `const style = document.createElement('style');\nstyle.textContent = \`${escaped}\`;\ndocument.head.appendChild(style);`,
          loader: 'js',
        }
      })
    },
  }
}

/**
 * 由 manifest 入口推导源码路径：dist/xxx → src/xxx，扩展名按入口类型回退探测。
 * 例：dist/main/index.cjs → src/main/index.ts；dist/renderer/index.js → src/renderer/index.tsx
 */
function resolveSource(pluginDir, entry, kind) {
  const rel = entry.replace(/^dist[\\/]/i, 'src/').replace(/\.[^.]+$/, '')
  const exts = kind === 'main'
    ? ['.ts', '.tsx', '.cjs', '.js', '.mjs']
    : ['.tsx', '.ts', '.js', '.jsx']
  for (const ext of exts) {
    const candidate = path.join(pluginDir, rel + ext)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.join(pluginDir, rel + (kind === 'main' ? '.ts' : '.tsx'))
}

async function buildMain(pluginDir, entry) {
  const outfile = path.join(pluginDir, entry)
  await esbuild.build({
    entryPoints: [resolveSource(pluginDir, entry, 'main')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron', ...NODE_BUILTINS],
  })
  return outfile
}

async function buildRenderer(pluginDir, entry) {
  const outfile = path.join(pluginDir, entry)
  await esbuild.build({
    entryPoints: [resolveSource(pluginDir, entry, 'renderer')],
    outfile,
    bundle: true,
    platform: 'browser',
    target: 'es2020',
    format: 'esm',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [createHostExternalsPlugin(), inlineCssPlugin()],
  })
  return outfile
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map((e) => e.text).join('; ')
  }
  return err?.message || String(err)
}

/**
 * 生成插件分发包 zip：仅含运行时必需文件（manifest/dist/locale/resources）。
 * zip 根即为插件内容（解压后顶层是 manifest.json），供应用内直接导入。
 */
function packPluginZip(pluginDir, manifest, outDir, AdmZip) {
  const zip = new AdmZip()
  const addPath = (rel) => {
    const full = path.join(pluginDir, rel)
    if (fs.existsSync(full)) {
      if (fs.statSync(full).isDirectory()) zip.addLocalFolder(full, rel)
      else zip.addLocalFile(full)
    }
  }
  addPath('manifest.json')
  addPath('dist')
  addPath('locale')
  addPath('resources')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${manifest.id}-v${manifest.version}.zip`)
  zip.writeZip(outPath)
  return outPath
}

async function main() {
  const args = process.argv.slice(2)
  const zipMode = args.includes('--zip')
  const onlyId = args.find(a => !a.startsWith('--'))
  const dirs = fs.readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'plugin-sdk')
    .map((e) => e.name)

  let targets
  if (onlyId) {
    targets = dirs.filter((id) => id === onlyId)
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
  /** 构建成功的插件（zip 模式使用） */
  const builtPlugins = []

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

    // 先删除目标 dist 目录再重建
    fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true })

    console.log(`[build-plugins] 构建 ${id} v${manifest.version || '?'}...`)
    const outputs = []
    const errors = []

    try {
      outputs.push({ file: await buildMain(pluginDir, manifest.main), label: 'main' })
    } catch (err) {
      errors.push(`主进程构建失败: ${formatError(err)}`)
    }

    if (errors.length === 0 && manifest.renderer) {
      try {
        outputs.push({ file: await buildRenderer(pluginDir, manifest.renderer), label: 'renderer' })
      } catch (err) {
        errors.push(`渲染端构建失败: ${formatError(err)}`)
      }
    }

    if (errors.length === 0) {
      built++
      builtPlugins.push({ pluginDir, manifest })
      const parts = outputs.map(({ file, label }) => {
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0
        return `${label} → ${path.relative(pluginDir, file)} (${formatSize(size)})`
      })
      console.log(`[build-plugins]   ✓ ${parts.join(' | ')}`)
    } else {
      failed++
      for (const e of errors) console.error(`[build-plugins]   ✗ ${e}`)
    }
  }

  console.log(`[build-plugins] 完成：${built} 成功，${failed} 失败`)

  // zip 模式：为成功构建的插件产出独立分发包 release/plugins/<id>-v<version>.zip
  if (zipMode && builtPlugins.length > 0) {
    const outDir = path.join(projectRoot, 'release', 'plugins')
    const AdmZip = require('adm-zip')
    let zipped = 0
    for (const { pluginDir, manifest } of builtPlugins) {
      try {
        const outPath = packPluginZip(pluginDir, manifest, outDir, AdmZip)
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
        console.log(`[build-plugins]   📦 ${path.relative(projectRoot, outPath)} (${formatSize(size)})`)
        zipped++
      } catch (err) {
        console.error(`[build-plugins]   ✗ 打包 zip 失败 ${manifest.id}: ${formatError(err)}`)
      }
    }
    console.log(`[build-plugins] zip 打包完成：${zipped}/${builtPlugins.length}，产物目录：${outDir}`)
  }

  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error(`[build-plugins] 执行失败: ${err?.message || err}`)
  process.exit(1)
})
