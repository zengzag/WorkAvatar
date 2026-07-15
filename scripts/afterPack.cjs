// scripts/afterPack.cjs
//
// electron-builder afterPack 钩子：在打包后清理不必要的文件，减小产物体积。
//
// 清理项：
// 1. onnxruntime-node：移除非当前平台的原生二进制文件
// 2. @napi-rs：移除非当前平台的预编译二进制
// 3. better-sqlite3：移除非当前平台预编译
// 4. sherpa-onnx：移除非当前平台原生包
// 5. 全局：移除测试文件、文档等开发时文件
//
"use strict"

const fs = require("node:fs")
const path = require("node:path")

/**
 * 根据构建目标推断当前平台
 */
function detectPlatform(packager) {
  const p = packager?.platform?.name
  if (p === "mac") return "darwin"
  if (p === "linux") return "linux"
  return "win32"
}

/** 删除指定目录，返回释放的字节数 */
function removeDir(dir) {
  if (!fs.existsSync(dir)) return 0
  let size = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name)
      if (e.isFile()) size += fs.statSync(f).size
      else if (e.isDirectory()) walk(f)
    }
  }
  walk(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return size
}

/** 递归删除目录下所有匹配的文件，返回 { bytes, files } */
function removeMatching(dir, predicate) {
  const removed = { bytes: 0, files: 0 }
  if (!fs.existsSync(dir)) return removed
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(removed, ((r) => ({ bytes: removed.bytes + r.bytes, files: removed.files + r.files }))(removeMatching(full, predicate)))
      try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full) } catch {}
    } else if (entry.isFile() && predicate(full)) {
      try {
        const stat = fs.statSync(full)
        fs.unlinkSync(full)
        removed.bytes += stat.size
        removed.files++
      } catch {}
    }
  }
  return removed
}

const mb = (b) => (b / 1024 / 1024).toFixed(1)

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  // electron-builder afterPack context.appDir 指向待打包的应用目录
  const appDir = context.appDir
  if (!appDir || !fs.existsSync(appDir)) {
    console.log("[afterPack] appDir 不存在，跳过清理")
    return
  }

  console.log(`[afterPack] appDir=${appDir}`)
  const platform = detectPlatform(context.packager)
  let totalSaved = 0

  // ── 1. onnxruntime-node：移除非当前平台二进制 ──
  const ortBinDir = path.join(appDir, "node_modules", "onnxruntime-node", "bin", "napi-v6")
  if (fs.existsSync(ortBinDir)) {
    const removePlatforms = platform === "win32"
      ? ["darwin", "linux"]
      : platform === "darwin"
        ? ["linux", "win32"]
        : ["darwin", "win32"]

    for (const p of removePlatforms) {
      const pDir = path.join(ortBinDir, p)
      const saved = removeDir(pDir)
      if (saved > 0) {
        totalSaved += saved
        console.log(`[afterPack] 移除 onnxruntime-node/${p}/ (${mb(saved)} MB)`)
      }
    }

    // Windows x64 构建移除 win32/arm64
    if (platform === "win32") {
      const arm64Dir = path.join(ortBinDir, "win32", "arm64")
      const saved = removeDir(arm64Dir)
      if (saved > 0) {
        totalSaved += saved
        console.log(`[afterPack] 移除 onnxruntime-node/win32/arm64/ (${mb(saved)} MB)`)
      }
    }
  }

  // ── 2. @napi-rs：移除非当前平台二进制 ──
  const napiDir = path.join(appDir, "node_modules", "@napi-rs")
  if (fs.existsSync(napiDir)) {
    const keepSuffix = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux"
    for (const entry of fs.readdirSync(napiDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.includes(keepSuffix) && entry.name.includes("-")) {
        const saved = removeDir(path.join(napiDir, entry.name))
        if (saved > 0) {
          totalSaved += saved
          console.log(`[afterPack] 移除 @napi-rs/${entry.name}/ (${mb(saved)} MB)`)
        }
      }
    }
  }

  // ── 3. better-sqlite3：移除非当前平台预编译 ──
  const bsqliteDir = path.join(appDir, "node_modules", "better-sqlite3", "prebuilds")
  if (fs.existsSync(bsqliteDir)) {
    const keepSuffix = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux"
    for (const entry of fs.readdirSync(bsqliteDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.includes(keepSuffix)) {
        const saved = removeDir(path.join(bsqliteDir, entry.name))
        if (saved > 0) {
          totalSaved += saved
          console.log(`[afterPack] 移除 better-sqlite3/prebuilds/${entry.name}/ (${mb(saved)} MB)`)
        }
      }
    }
  }

  // ── 4. sherpa-onnx：移除非当前平台原生包 ──
  const sherpaKeepPrefix = platform === "win32"
    ? "sherpa-onnx-win-x64"
    : platform === "darwin"
      ? "sherpa-onnx-darwin"
      : "sherpa-onnx-linux"
  const nmRoot = path.join(appDir, "node_modules")
  if (fs.existsSync(nmRoot)) {
    for (const entry of fs.readdirSync(nmRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith("sherpa-onnx-")) continue
      // 保留当前平台包，移除其他平台包
      if (entry.name === sherpaKeepPrefix) continue
      // 不移除主包 sherpa-onnx-node
      if (entry.name === "sherpa-onnx-node") continue
      const saved = removeDir(path.join(nmRoot, entry.name))
      if (saved > 0) {
        totalSaved += saved
        console.log(`[afterPack] 移除 ${entry.name}/ (${mb(saved)} MB)`)
      }
    }
  }

  // ── 5. 全局清理：移除开发时文件 ──
  const nmDir = path.join(appDir, "node_modules")
  const devFileResult = removeMatching(nmDir, (fp) => {
    const lower = fp.toLowerCase()
    if (lower.endsWith(".d.ts")) return true
    if (/[\\/](__tests__|test|tests|spec|fixtures|mocks)[\\/]/.test(fp)) return true
    const base = path.basename(fp).toLowerCase()
    if (/^(readme|changelog|history|changes|authors|contributors|code_of_conduct)/.test(base)) return true
    if (/^license/i.test(base) && !lower.includes("spdx")) return true
    if (lower.endsWith(".map")) return true
    if (/\.(eslintrc|prettierrc|editorconfig|stylelintrc|babelrc|nycrc|mocharc)/.test(base)) return true
    return false
  })
  if (devFileResult.files > 0) {
    totalSaved += devFileResult.bytes
    console.log(`[afterPack] 移除 ${devFileResult.files} 个开发文件 (${mb(devFileResult.bytes)} MB)`)
  }

  console.log(`[afterPack] 总计释放 ${mb(totalSaved)} MB`)
}
