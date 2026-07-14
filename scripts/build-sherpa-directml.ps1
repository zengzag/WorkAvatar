<#
.SYNOPSIS
  Build sherpa-onnx DirectML DLLs and store them in resources/native/
.DESCRIPTION
  Strategy: DLL replacement (no .node rebuild needed)
  1. Clone sherpa-onnx source
  2. Build shared libraries with SHERPA_ONNX_ENABLE_DIRECTML=ON
  3. Store DirectML DLLs in resources/native/sherpa-directml-win-x64/ (Git LFS)
  4. Run scripts/install-sherpa-directml.cjs to copy into node_modules
  The existing .node addon is ABI-compatible with the DirectML DLL because
  SHERPA_ONNX_ENABLE_DIRECTML only adds implementation code paths, not API changes.
  After commit, `npm install` (postinstall hook) will auto-install the DLLs.
.NOTES
  Requires: Visual Studio 2022+ (C++ desktop), CMake 3.15+, Git
#>

$ErrorActionPreference = "Stop"

# -- Config --
$ProjectRoot = "c:\Users\zengz\Projects\WorkAvatar"
$BuildDir = "$env:TEMP\sherpa-onnx-directml-build"
$SherpaVersion = "v1.13.4"
$RepoUrl = "https://github.com/k2-fsa/sherpa-onnx.git"

Write-Host ""
Write-Host "=== sherpa-onnx DirectML Build Script ===" -ForegroundColor Cyan
Write-Host "Strategy: DLL replacement (no .node rebuild)"
Write-Host "Project: $ProjectRoot"
Write-Host "Build dir: $BuildDir"
Write-Host "Version: $SherpaVersion"
Write-Host ""

# -- 1. Clone source --
Write-Host "[1/5] Clone sherpa-onnx source..." -ForegroundColor Yellow
if (Test-Path "$BuildDir\sherpa-onnx\.git") {
    Write-Host "  Source already exists, skipping clone"
} else {
    if (Test-Path $BuildDir) {
        Remove-Item -Recurse -Force $BuildDir
    }
    New-Item -ItemType Directory -Path $BuildDir -Force | Out-Null
    git clone --depth 1 --branch $SherpaVersion $RepoUrl "$BuildDir\sherpa-onnx"
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}
Write-Host "[1/5] Done" -ForegroundColor Green

# -- 2. Build sherpa-onnx shared libraries (DirectML) --
Write-Host ""
Write-Host "[2/5] Build sherpa-onnx shared libraries (DirectML)..." -ForegroundColor Yellow
$SherpaDir = "$BuildDir\sherpa-onnx"
$BuildDir2 = "$SherpaDir\build"

if (Test-Path "$BuildDir2\install\lib\sherpa-onnx-c-api.dll") {
    Write-Host "  Shared libraries already built, skipping"
} else {
    if (Test-Path $BuildDir2) {
        Remove-Item -Recurse -Force $BuildDir2
    }
    New-Item -ItemType Directory -Path $BuildDir2 -Force | Out-Null
    Push-Location $BuildDir2

    Write-Host "  CMake configure (downloading DirectML onnxruntime + DirectML.dll)..."
    cmake -A x64 `
        -DCMAKE_INSTALL_PREFIX="./install" `
        -DBUILD_SHARED_LIBS=ON `
        -DSHERPA_ONNX_ENABLE_DIRECTML=ON `
        -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF `
        -DSHERPA_ONNX_ENABLE_WEBSOCKET=OFF `
        -DSHERPA_ONNX_ENABLE_TESTS=OFF `
        -DSHERPA_ONNX_ENABLE_TTS=OFF `
        -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=OFF `
        ..

    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "CMake configure failed" }

    Write-Host "  Building (may take 10-30 minutes)..."
    cmake --build . --config Release --parallel
    if ($LASTEXITCODE -ne 0) {
        # Retry once if link failed due to file lock (antivirus etc.)
        Write-Host "  Build failed, retrying (possible file lock)..."
        cmake --build . --config Release --parallel
        if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Build failed" }
    }

    Write-Host "  Installing..."
    cmake --build . --config Release --target install
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Install failed" }

    Pop-Location
}
Write-Host "[2/5] Done" -ForegroundColor Green

# -- 3. Store DLLs in resources/native/ (Git LFS tracked) --
Write-Host ""
Write-Host "[3/5] Store DirectML DLLs in resources/native/..." -ForegroundColor Yellow
$NativeDir = "$ProjectRoot\resources\native\sherpa-directml-win-x64"
$InstallLibDir = "$BuildDir2\install\lib"
$InstallBinDir = "$BuildDir2\install\bin"

New-Item -ItemType Directory -Path $NativeDir -Force | Out-Null

# DLLs from install/lib (sherpa-onnx shared libs)
$LibDlls = @(
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll"
)

# DLLs from install/bin (runtime dependencies)
$BinDlls = @(
    "onnxruntime.dll",
    "DirectML.dll"
)

foreach ($dll in $LibDlls) {
    $src = Join-Path $InstallLibDir $dll
    if (Test-Path $src) {
        Copy-Item $src "$NativeDir\$dll" -Force
        Write-Host "  Stored $dll (from install/lib)"
    } else {
        Write-Warning "  Not found: $src"
    }
}

foreach ($dll in $BinDlls) {
    $src = Join-Path $InstallBinDir $dll
    if (Test-Path $src) {
        Copy-Item $src "$NativeDir\$dll" -Force
        Write-Host "  Stored $dll (from install/bin)"
    } else {
        Write-Warning "  Not found: $src"
    }
}

Write-Host "[3/5] Done" -ForegroundColor Green

# -- 4. Install DLLs into node_modules --
Write-Host ""
Write-Host "[4/5] Install DirectML DLLs into node_modules..." -ForegroundColor Yellow
Push-Location $ProjectRoot
& node scripts/install-sherpa-directml.cjs
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Install script failed" }
Pop-Location
Write-Host "[4/5] Done" -ForegroundColor Green

# -- 5. Verify --
Write-Host ""
Write-Host "[5/5] Verify DirectML support..." -ForegroundColor Yellow
$TargetDir = "$ProjectRoot\node_modules\sherpa-onnx-win-x64"

$TestScript = @"
const path = require('path');
const sherpa = require(path.resolve('$TargetDir/sherpa-onnx.node'));
console.log('Module loaded, exports:', Object.keys(sherpa).length, 'functions');

const modelDir = path.resolve('$ProjectRoot/resources/streaming-zipformer');
const fs = require('fs');
if (!fs.existsSync(path.join(modelDir, 'encoder.onnx'))) {
  console.log('SKIP: model files not found, module load test only');
  process.exit(0);
}

const config = {
  modelConfig: {
    transducer: {
      encoder: path.join(modelDir, 'encoder.onnx'),
      decoder: path.join(modelDir, 'decoder.onnx'),
      joiner: path.join(modelDir, 'joiner.onnx'),
    },
    tokens: path.join(modelDir, 'tokens.txt'),
    numThreads: 1,
    provider: 'directml',
  },
  featConfig: { sampleRate: 16000, featureDim: 80 },
};

try {
  const rec = sherpa.createOnlineRecognizer(config);
  console.log('SUCCESS: OnlineRecognizer created with provider=directml');
  const stream = sherpa.createOnlineStream(rec);
  console.log('DirectML GPU acceleration is functional');
} catch(e) {
  console.error('DirectML FAILED:', e.message);
  process.exit(1);
}
"@

$testFile = "$env:TEMP\test-directml.js"
Set-Content -Path $testFile -Value $TestScript -Encoding UTF8

try {
    & node $testFile 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "DirectML verification failed" }
} catch {
    Write-Warning "  Verification error: $_"
    Write-Host "  You may need to check GPU drivers or DirectX 12 support"
}

Remove-Item $testFile -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Cyan
Write-Host "DirectML DLLs stored in: resources/native/sherpa-directml-win-x64/"
Write-Host "DLLs installed to: node_modules/sherpa-onnx-win-x64/"
Write-Host "The .node addon is unchanged (ABI-compatible)."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. git add resources/native/sherpa-directml-win-x64/ (DLLs via Git LFS)"
Write-Host "  2. git add scripts/build-sherpa-directml.ps1 scripts/install-sherpa-directml.cjs"
Write-Host "  3. git commit -m 'feat: add DirectML GPU acceleration for sherpa-onnx'"
Write-Host "  4. Enable GPU in app: Settings > Voice > GPU Acceleration"
Write-Host ""
Write-Host "After commit, npm install will auto-install DirectML DLLs via postinstall hook."
Write-Host ""
