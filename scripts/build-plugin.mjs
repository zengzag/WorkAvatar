#!/usr/bin/env node
// scripts/build-plugin.mjs — WorkAvatar 插件构建脚本（单一权威源）
//
// 本脚本是插件构建的单一事实源，两种场景复用：
//   1. 仓库内：scripts/build-plugins.mjs 遍历 plugins/ 目录后逐个调用本脚本
//   2. 内置 plugin-dev skill：scripts/sync-plugin-dev-skill.mjs 同步时把本脚本复制到
//      references/hello-world.build-plugin.mjs，供智能体脚手架插件工程时使用
//
// 用法（在插件工程根目录，或指定插件目录）：
//   node build-plugin.mjs [pluginDir]       # 构建主进程 CJS + 渲染端 ESM 到 dist/
//   node build-plugin.mjs [pluginDir] --zip # 构建并产出独立分发包 <id>-v<version>.wap
//   node build-plugin.mjs [pluginDir] --zip --no-source # 产出不含源码的精简分发包
//
// 约定：
//   - 读取 <pluginDir>/manifest.json 的 main / renderer 入口
//   - 主进程入口（dist/main/index.cjs）→ CJS（platform=node, target=node20）
//   - 渲染端入口（dist/renderer/index.js）→ ESM（platform=browser, target=es2020, jsx=automatic）
//   - 渲染端共享库（react/antd 等）经 __WA_HOST__ 单例 shim 内联，产物不残留裸模块标识符
//   - CSS 自动内联为 <style> 注入
//   - zip 默认含源码（src/** + package.json + tsconfig.json），便于在已安装插件基础上二次开发重建；
//     --no-source 排除源码，仅保留运行时必需文件 manifest.json + dist/** + locale/** + resources/**
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

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
 * 用 esbuild 虚拟模块（onResolve + onLoad）把共享库导入内联为读取 globalThis.__WA_HOST__.X 的 shim。
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
 * 相对路径（插件内 css）与裸路径（node_modules，如 vditor/dist/index.css）均可解析。
 */
function inlineCssPlugin(pluginDir) {
  return {
    name: 'inline-css',
    setup(build) {
      build.onResolve({ filter: /\.css$/ }, (args) => ({
        path: args.path,
        namespace: 'wa-css',
        pluginData: { resolveDir: args.resolveDir },
      }))
      build.onLoad({ filter: /\.css$/, namespace: 'wa-css' }, (args) => {
        const resolveDir = args.pluginData?.resolveDir || pluginDir
        let fullPath = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(resolveDir, args.path)
        if (!fs.existsSync(fullPath)) {
          // 裸路径（如 vditor/dist/index.css）：回退到插件目录解析
          const resolved = require.resolve(args.path, { paths: [pluginDir] })
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

async function buildMain(pluginDir, entry, nativeDeps = []) {
  const outfile = path.join(pluginDir, entry)
  await esbuild.build({
    entryPoints: [resolveSource(pluginDir, entry, 'main')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // electron / node 内置 / 插件声明的宿主原生依赖（package.json.nativeDependencies）不打包
    external: ['electron', ...NODE_BUILTINS, ...nativeDeps],
  })
  return outfile
}

/**
 * 读取插件 package.json 声明的宿主原生依赖（nativeDependencies），
 * 并与宿主原生白名单（plugin-sdk/host-native-dependencies.json，向上逐级查找）比对：
 * 未清单内的模块构建期提示（运行时借用会被宿主拒绝）。
 * 返回白名单校验后的模块名数组（作为主进程 external）。
 */
function readNativeDeps(pluginDir) {
  let declared = {}
  try {
    declared = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8')).nativeDependencies ?? {}
  } catch {
    return []
  }
  const names = Object.keys(declared)
  if (names.length === 0) return []
  // 宿主白名单（单源真相）：从插件目录向上逐级查找 plugin-sdk/host-native-dependencies.json
  // 覆盖三种路径：plugins/<id>、plugins/examples/<id>、devkit 内 plugin-template
  let whitelist = {}
  try {
    let dir = path.resolve(pluginDir)
    while (true) {
      const candidate = path.join(dir, 'plugin-sdk', 'host-native-dependencies.json')
      if (fs.existsSync(candidate)) {
        whitelist = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
        break
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* 找不到白名单则跳过校验 */ }
  const unknown = names.filter((n) => !(n in whitelist))
  if (unknown.length) {
    console.warn(`[build-plugin] ⚠ 以下 nativeDependencies 不在宿主白名单内，运行时会被拒绝: ${unknown.join(', ')}`)
  }
  return names
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
    plugins: [createHostExternalsPlugin(), inlineCssPlugin(pluginDir)],
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
 * 生成插件分发包（自定义扩展名 .wap，内部仍为 zip 归档）：默认含源码（src/package.json/tsconfig.json），
 * 便于在已安装插件基础上二次开发重建；--no-source 时仅含运行时必需文件（manifest/dist/locale/resources/skills）。
 * zip 根即为插件内容（解压后顶层是 manifest.json），供应用内直接导入。
 */
function packPluginZip(pluginDir, manifest, outDir, AdmZip, includeSource) {
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
  addPath('skills')
  if (includeSource) {
    addPath('src')
    addPath('package.json')
    addPath('tsconfig.json')
  }
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, `${manifest.id}-v${manifest.version}.wap`)
  zip.writeZip(outPath)
  return outPath
}

async function main() {
  const args = process.argv.slice(2)
  const zipMode = args.includes('--zip')
  const includeSource = !args.includes('--no-source')
  const dirArg = args.find((a) => !a.startsWith('--'))
  const pluginDir = path.resolve(dirArg || process.cwd())
  // 可选 --out <dir>：指定 zip 输出目录（仓库内由 build-plugins.mjs 传入项目根 release/plugins；
  // 独立/模板场景缺省输出到 <pluginDir>/release/plugins）
  const outArgIndex = args.indexOf('--out')
  const outDirArg = outArgIndex >= 0 ? args[outArgIndex + 1] : undefined

  const manifestPath = path.join(pluginDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    console.error(`[build-plugin] 未找到 manifest.json：${manifestPath}`)
    console.error('用法：node build-plugin.mjs [pluginDir] [--zip]')
    process.exit(1)
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch (err) {
    console.error(`[build-plugin] manifest.json 解析失败: ${err.message}`)
    process.exit(1)
  }
  if (!manifest.main) {
    console.error(`[build-plugin] manifest 缺少 main 入口`)
    process.exit(1)
  }

  // 先删除目标 dist 目录再重建
  fs.rmSync(path.join(pluginDir, 'dist'), { recursive: true, force: true })

  console.log(`[build-plugin] 构建 ${manifest.id} v${manifest.version || '?'}...`)
  const outputs = []
  const errors = []

  // 读取插件 package.json 声明的宿主原生依赖（无则跳过）
  const nativeDeps = readNativeDeps(pluginDir)
  if (nativeDeps.length) {
    console.log(`[build-plugin] 宿主原生依赖（不打包）: ${nativeDeps.join(', ')}`)
  }

  try {
    outputs.push({ file: await buildMain(pluginDir, manifest.main, nativeDeps), label: 'main' })
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

  if (errors.length > 0) {
    for (const e of errors) console.error(`[build-plugin]   ✗ ${e}`)
    process.exit(1)
  }

  for (const { file, label } of outputs) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0
    console.log(`[build-plugin]   ✓ ${label} → ${path.relative(pluginDir, file)} (${formatSize(size)})`)
  }

  if (zipMode) {
    const outDir = outDirArg ? path.resolve(outDirArg) : path.join(pluginDir, 'release', 'plugins')
    const AdmZip = require('adm-zip')
    const outPath = packPluginZip(pluginDir, manifest, outDir, AdmZip, includeSource)
    const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0
    const packDetail = includeSource ? '（含源码 src/package.json/tsconfig.json）' : '（精简包：不含源码）'
    console.log(`[build-plugin]   📦 ${path.relative(pluginDir, outPath)} (${formatSize(size)})${packDetail}`)
  }

  console.log(`[build-plugin] 完成`)
}

main().catch((err) => {
  console.error(`[build-plugin] 执行失败: ${err?.message || err}`)
  process.exit(1)
})
