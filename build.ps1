<#
.SYNOPSIS
WorkAvatar Windows Build Script - 打包脚本。

.DESCRIPTION
构建并打包 WorkAvatar 桌面应用。默认 normal 模式（compression=normal，快速）；
-r 切换为 release（compression=maximum，体积最小）；-p 仅编译插件，跳过打包。

.PARAMETER Mode
打包模式：normal（默认，快速）或 release（体积最小）。也可用 -r 快捷开关代替。

.PARAMETER Release
快捷开关，等价于 -Mode release。

.PARAMETER PluginOnly
仅重新编译插件并产出 .wap 分发包，跳过 tsc/vite/electron-builder 打包。

.EXAMPLE
.\build.ps1
.\build.ps1 -r
.\build.ps1 -p
#>

# 打包模式：normal（默认，快速日常构建，compression=normal）；release（正式发布，compression=maximum 最小体积）
# -PluginOnly：仅重新编译插件并产出 .wap 分发包，跳过 tsc/vite/electron-builder 打包
param(
    [ValidateSet("normal", "release")]
    [string]$Mode = "normal",
    [Alias("r")]
    [switch]$Release,
    [Alias("p")]
    [switch]$PluginOnly,
    [Alias("h")]
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# -r 是 release 模式的快捷开关，等价于 -Mode release
if ($Release) { $Mode = "release" }

# -h/-? 仅显示帮助并立即退出，不触发任何构建步骤
if ($Help) {
    Get-Help $PSCommandPath
    exit 0
}

function Write-Step([string]$step, [string]$message) {
    Write-Host "[$step] $message" -ForegroundColor Cyan
}

function Write-Error-Msg([string]$message) {
    Write-Host "[ERROR] $message" -ForegroundColor Red
}

function Write-Warning-Msg([string]$message) {
    Write-Host "[WARN] $message" -ForegroundColor Yellow
}

function Write-Success([string]$message) {
    Write-Host $message -ForegroundColor Green
}

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "  WorkAvatar Windows Build Script"       -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "  Mode: $Mode" -ForegroundColor Yellow
Write-Host "  Usage: .\build.ps1              # normal（快速）"
Write-Host "         .\build.ps1 -r          # release（compression=maximum，体积最小）。别名：-Mode release"
Write-Host "         .\build.ps1 -p          # 仅重新编译插件（产出 .wap 分发包）。别名：-PluginOnly"
Write-Host "         .\build.ps1 -h          # 显示帮助（-? 亦可）"
Write-Host ""

Set-Location $PSScriptRoot

# 仅重新编译插件：直接构建全部插件并产出 .wap 分发包，跳过 build-info/tsc/vite/electron-builder
if ($PluginOnly) {
    Write-Step "插件" "仅编译插件（--zip 产出 .wap 分发包）..."
    node scripts/build-plugins.mjs --zip
    if ($LASTEXITCODE -ne 0) {
        Write-Error-Msg "Plugin build failed"
        exit 1
    }
    Write-Success "插件编译完成。"
    Read-Host "Press Enter to exit"
    exit 0
}

# 生成 build-info.json（version + commit + buildTime），供 vite define 与主进程日志共用
Write-Step "1/6" "Generating build-info.json..."
node scripts/generate-build-info.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Error-Msg "build-info generation failed"
    exit 1
}
Write-Host ""

$pkg = Get-Content "package.json" -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version

$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

# Step 2: Check Node.js
Write-Step "2/6" "Checking Node.js..."
try {
    $nodeVersion = node -v
    Write-Success "  Node.js: $nodeVersion"
} catch {
    Write-Error-Msg "Node.js not found. Please install Node.js >= 20.x"
    exit 1
}
Write-Host ""

# Step 3: Install dependencies
Write-Step "3/6" "Checking dependencies..."
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Error-Msg "npm install failed"
        exit 1
    }
} else {
    Write-Success "  Dependencies already installed, skipping"
}
Write-Host ""

# Step 4: Rebuild native modules
Write-Step "4/6" "Rebuilding native modules (better-sqlite3)..."
npx electron-builder install-app-deps
if ($LASTEXITCODE -ne 0) {
    Write-Warning-Msg "Native module rebuild failed, packaging may be affected"
}
Write-Host ""

# Step 5: TypeScript check + Vite build
Write-Step "5/6" "TypeScript type checking + Vite build..."
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) {
    Write-Error-Msg "TypeScript type check failed, fix errors and retry"
    exit 1
}
Write-Success "  Type check passed"

npx vite build
if ($LASTEXITCODE -ne 0) {
    Write-Error-Msg "Vite build failed"
    exit 1
}
Write-Success "  Vite build completed"
Write-Host ""

# Step 5.5: 构建插件 + 产出全部插件分发包（release/plugins/<id>-v<ver>.zip）
Write-Step "5/6" "Building plugins and packaging plugin zips..."
node scripts/build-plugins.mjs --zip
if ($LASTEXITCODE -ne 0) {
    Write-Error-Msg "Plugin build failed"
    exit 1
}
Write-Host ""

# Step 6: Electron Builder packaging (NSIS installer)
Write-Step "6/6" "Electron Builder packaging (NSIS installer) [mode: $Mode]..."
if ($Mode -eq "release") {
    Write-Host "  compression=maximum (体积最小，构建慢)"
} else {
    Write-Host "  compression=normal (快速)"
}
Write-Host "  Generating NSIS installer..."

# 清理上次失败残留的 .tmp 目录和旧 win-unpacked，避免 EPERM rename 冲突
$releaseDir = "release\$version"
if (Test-Path $releaseDir) {
    Get-ChildItem $releaseDir -Directory -Filter "*.tmp" -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path "$releaseDir\win-unpacked") {
        Remove-Item -Recurse -Force "$releaseDir\win-unpacked" -ErrorAction SilentlyContinue
    }
}

# --publish never：禁用 CI 环境下的隐式自动发布
# 不带 --dir：按 electron-builder.yml 中 win.target=nsis 生成真正的安装包
# （包含安装目录选择、桌面/开始菜单快捷方式、卸载器）
$buildExitCode = 0
$extraArgs = @()
if ($Mode -eq "release") {
    # release 模式覆盖 yml 默认 compression=normal 为 maximum（最小安装包体积）
    $extraArgs = @("--config.compression=maximum")
}
& npx electron-builder --win --publish never @extraArgs
$buildExitCode = $LASTEXITCODE

if ($buildExitCode -ne 0) {
    Write-Error-Msg "electron-builder packaging failed (exit code: $buildExitCode)"
    exit 1
}

$installerPath = "release\$version\WorkAvatar-Setup-$version.exe"
$unpackedDir = "release\$version\win-unpacked"

if (Test-Path $installerPath) {
    $size = [math]::Round((Get-Item $installerPath).Length / 1MB, 1)

    Write-Host ""
    Write-Success "========================================"
    Write-Success "  Build completed!"
    Write-Success "========================================"
    Write-Host ""
    Write-Host "  Installer: $installerPath (${size}MB)"
    Write-Host "  Unpacked:  $unpackedDir (用于调试)"
    Write-Host ""
    Write-Host "  Distribute the Setup.exe to end users."
    Write-Success "========================================"
} else {
    Write-Error-Msg "Installer not found: $installerPath"
    Write-Error-Msg "Check electron-builder output above for errors."
    exit 1
}

Write-Host ""
Read-Host "Press Enter to exit"
