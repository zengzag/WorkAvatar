// scripts/build-launcher.mjs
//
// 构建 Windows 稳定启动器（WorkAvatarLauncher.exe）。
// 使用系统自带 .NET Framework 的 csc.exe 编译，产物输出到 resources/launcher/，
// 由 NSIS 打包时通过 File 嵌入安装包（不进应用本体）。
// 非 Windows 平台直接跳过（仅 Windows 安装包需要）。
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "scripts", "launcher", "WorkAvatarLauncher.cs")
const icon = path.join(root, "resources", "icons", "icon.ico")
const outDir = path.join(root, "resources", "launcher")
const outExe = path.join(outDir, "WorkAvatarLauncher.exe")

if (process.platform !== "win32") {
  console.log("[launcher] 非 Windows 平台，跳过启动器构建")
  process.exit(0)
}

if (!fs.existsSync(source)) {
  console.error(`[launcher] 未找到启动器源码：${source}`)
  process.exit(1)
}

const winDir = process.env.WINDIR || "C:\\Windows"
const cscCandidates = [
  path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
]
const csc = cscCandidates.find((p) => fs.existsSync(p))
if (!csc) {
  console.error("[launcher] 未找到 csc.exe（需要 .NET Framework 4.x）")
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })
const args = ["/nologo", "/target:winexe", "/optimize+", "/platform:anycpu", `/out:${outExe}`]
if (fs.existsSync(icon)) args.push(`/win32icon:${icon}`)
args.push(source)

execFileSync(csc, args, { stdio: "inherit" })
console.log(`[launcher] 已生成 ${path.relative(root, outExe)}`)
