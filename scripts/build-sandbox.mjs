// scripts/build-sandbox.mjs
//
// 构建 Windows 文件沙箱运行器（WorkAvatarSandbox.exe）。
// 与启动器一致，使用系统自带 .NET Framework 的 csc.exe 编译，产物输出到 resources/sandbox/，
// 随 extraResources 打进安装包。非 Windows 平台直接跳过。
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "scripts", "sandbox", "WorkAvatarSandbox.cs")
const outDir = path.join(root, "resources", "sandbox")
const outExe = path.join(outDir, "WorkAvatarSandbox.exe")

if (process.platform !== "win32") {
  console.log("[sandbox] 非 Windows 平台，跳过沙箱运行器构建")
  process.exit(0)
}

if (!fs.existsSync(source)) {
  console.error(`[sandbox] 未找到运行器源码：${source}`)
  process.exit(1)
}

const winDir = process.env.WINDIR || "C:\\Windows"
const cscCandidates = [
  path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
]
const csc = cscCandidates.find((p) => fs.existsSync(p))
if (!csc) {
  console.error("[sandbox] 未找到 csc.exe（需要 .NET Framework 4.x）")
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const args = [
  "/nologo",
  "/target:exe",
  "/optimize+",
  "/platform:anycpu",
  "/codepage:65001",
  `/out:${outExe}`,
  source,
]
execFileSync(csc, args, { stdio: "inherit" })
console.log(`[sandbox] 已生成 ${path.relative(root, outExe)}`)
