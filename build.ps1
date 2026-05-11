$ErrorActionPreference = "Stop"

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

Set-Location $PSScriptRoot

$pkg = Get-Content "package.json" -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version

# Step 1: Check Node.js
Write-Step "1/5" "Checking Node.js..."
try {
    $nodeVersion = node -v
    Write-Success "  Node.js: $nodeVersion"
} catch {
    Write-Error-Msg "Node.js not found. Please install Node.js >= 20.x"
    exit 1
}
Write-Host ""

# Step 2: Install dependencies
Write-Step "2/5" "Checking dependencies..."
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

# Step 3: Rebuild native modules
Write-Step "3/5" "Rebuilding native modules (better-sqlite3)..."
npx electron-builder install-app-deps
if ($LASTEXITCODE -ne 0) {
    Write-Warning-Msg "Native module rebuild failed, packaging may be affected"
}
Write-Host ""

# Step 4: TypeScript check + Vite build
Write-Step "4/5" "TypeScript type checking + Vite build..."
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

# Step 5: Electron Builder packaging (portable only)
Write-Step "5/5" "Electron Builder packaging (portable)..."
Write-Host "  Generating portable build..."

npx electron-builder --win --dir

$srcDir = "release\$version\win-unpacked"

if (Test-Path "$srcDir\WorkAvatar.exe") {
    Write-Host ""
    Write-Host "  Creating portable ZIP..."

    $zipPath = "release\$version\WorkAvatar-portable-$version.zip"
    Compress-Archive -Path "$srcDir\*" -DestinationPath $zipPath -Force
    $size = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)

    Write-Host ""
    Write-Success "========================================"
    Write-Success "  Build completed!"
    Write-Success "========================================"
    Write-Host ""
    Write-Host "  Portable: $srcDir\WorkAvatar.exe"
    Write-Host "  ZIP:      $zipPath (${size}MB)"
    Write-Host ""
    Write-Host "  Run win-unpacked\WorkAvatar.exe directly,"
    Write-Host "  or extract the ZIP to any folder and run."
    Write-Success "========================================"
} else {
    Write-Error-Msg "Build output not found: $srcDir\WorkAvatar.exe"
    exit 1
}

Write-Host ""
Read-Host "Press Enter to exit"
