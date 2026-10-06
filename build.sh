#!/usr/bin/env bash
#
# WorkAvatar macOS Build Script - 打包脚本。
#
# 构建并打包 WorkAvatar 桌面应用（macOS）。默认 normal 模式（compression=normal，快速）；
# -r 切换为 release（compression=maximum，体积最小）；-p 仅编译插件，跳过打包。
#
# 用法：
#   ./build.sh                # normal（快速）
#   ./build.sh -r             # release（compression=maximum，体积最小）
#   ./build.sh -p             # 仅重新编译插件（产出 .wap 分发包）
#   ./build.sh -a arm64       # 指定目标架构（默认当前机器架构：x64 / arm64）
#   ./build.sh -h             # 显示帮助
#
# 说明：macOS 产物为 dmg + zip，输出到 release/<version>/。
#       未配置开发者证书时脚本会自动跳过签名，产出可直接本地运行。

set -euo pipefail

# ── 参数 ──────────────────────────────────────────────────────────────────────
MODE="normal"        # normal（默认，快速）| release（体积最小）
PLUGIN_ONLY=0        # 1 = 仅编译插件，跳过 tsc/vite/electron-builder
ARCH=""              # 目标架构：x64 | arm64 | universal（默认当前机器架构）

usage() {
  cat <<'EOF'
WorkAvatar macOS Build Script

用法：
  ./build.sh                 normal 模式（compression=normal，快速）
  ./build.sh -r              release 模式（compression=maximum，体积最小）
  ./build.sh -p              仅重新编译插件（产出 .wap 分发包）
  ./build.sh -a <arch>       指定目标架构：x64 | arm64 | universal
  ./build.sh -h              显示帮助

选项：
  -r, --release       release 模式，等价于 --mode release
  -p, --plugin-only   仅重新编译插件并产出 .wap 分发包
  -a, --arch <arch>   目标架构，默认当前机器架构
      --mode <mode>   打包模式：normal | release
  -h, --help          显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--release)      MODE="release"; shift ;;
    -p|--plugin-only)  PLUGIN_ONLY=1; shift ;;
    -a|--arch)         ARCH="${2:-}"; shift 2 ;;
    --mode)            MODE="${2:-}"; shift 2 ;;
    -h|--help)         usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ "$MODE" != "normal" && "$MODE" != "release" ]]; then
  echo "无效模式: $MODE（可选 normal / release）" >&2
  exit 1
fi

# 目标架构缺省取当前机器架构
if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    x86_64) ARCH="x64" ;;
    *) ARCH="x64" ;;
  esac
fi

# ── 日志辅助 ──────────────────────────────────────────────────────────────────
C_RESET='\033[0m'; C_CYAN='\033[36m'; C_RED='\033[31m'
C_YELLOW='\033[33m'; C_GREEN='\033[32m'; C_MAGENTA='\033[35m'

step()    { printf "${C_CYAN}[%s] %s${C_RESET}\n" "$1" "$2"; }
err()     { printf "${C_RED}[ERROR] %s${C_RESET}\n" "$1" >&2; }
warn()    { printf "${C_YELLOW}[WARN] %s${C_RESET}\n" "$1"; }
success() { printf "${C_GREEN}%s${C_RESET}\n" "$1"; }

printf "${C_MAGENTA}========================================${C_RESET}\n"
printf "${C_MAGENTA}  WorkAvatar macOS Build Script${C_RESET}\n"
printf "${C_MAGENTA}========================================${C_RESET}\n"
echo ""
printf "${C_YELLOW}  Mode: %s${C_RESET}\n" "$MODE"
printf "${C_YELLOW}  Arch: %s${C_RESET}\n" "$ARCH"
echo "  Usage: ./build.sh              # normal（快速）"
echo "         ./build.sh -r          # release（compression=maximum，体积最小）"
echo "         ./build.sh -p          # 仅重新编译插件（产出 .wap 分发包）"
echo "         ./build.sh -a arm64    # 指定目标架构"
echo "         ./build.sh -h          # 显示帮助"
echo ""

cd "$(dirname "$0")"

# 平台守卫：本脚本仅用于 macOS
if [[ "$(uname -s)" != "Darwin" ]]; then
  err "该脚本用于 macOS，当前系统为 $(uname -s)。Windows 请使用 build.ps1。"
  exit 1
fi

# ── 仅重新编译插件：产出 .wap 分发包，跳过 build-info/tsc/vite/electron-builder ──
if [[ "$PLUGIN_ONLY" -eq 1 ]]; then
  step "插件" "仅编译插件（--zip 产出 .wap 分发包）..."
  node scripts/build-plugins.mjs --zip
  success "插件编译完成。"
  exit 0
fi

# ── 环境变量：跳过代码签名（未配置证书时本地可直接运行） ──
export CSC_IDENTITY_AUTO_DISCOVERY="false"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
# Electron 二进制下载镜像（未安装 Electron 时生效）
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"

# ── Step 1: 生成 build-info.json（version + commit + buildTime） ──
step "1/6" "Generating build-info.json..."
node scripts/generate-build-info.mjs
echo ""

VERSION="$(node -p "require('./package.json').version")"

# ── Step 2: 检查 Node.js ──
step "2/6" "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  err "未找到 Node.js，请安装 Node.js >= 20.x（推荐通过 nvm 或 Homebrew 安装）"
  exit 1
fi
success "  Node.js: $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  err "未找到 npm，请随 Node.js 一并安装"
  exit 1
fi
echo ""

# ── Step 3: 安装依赖 ──
step "3/6" "Checking dependencies..."
if [[ ! -d node_modules ]]; then
  echo "  Installing dependencies..."
  npm install
else
  success "  Dependencies already installed, skipping"
fi
echo ""

# 插件源码为 git 子模块，缺失时提醒拉取
if [[ ! -f plugins/package.json ]]; then
  warn "plugins/ 子模块为空，请先执行：git submodule update --init --recursive"
fi

# ── Step 4: 重建原生模块（针对 Electron ABI） ──
step "4/6" "Rebuilding native modules (better-sqlite3 等)..."
if ! npx electron-builder install-app-deps; then
  warn "Native module rebuild failed, packaging may be affected"
fi
echo ""

# ── Step 5: TypeScript 类型检查 + Vite 构建 ──
step "5/6" "TypeScript type checking + Vite build..."
npx tsc --noEmit
success "  Type check passed"

npx vite build
success "  Vite build completed"
echo ""

# ── Step 5.5: 构建插件 + 产出全部插件分发包（release/plugins/<id>-v<ver>.wap） ──
step "5/6" "Building plugins and packaging plugin zips..."
node scripts/build-plugins.mjs --zip
echo ""

# ── Step 6: Electron Builder 打包（dmg + zip） ──
step "6/6" "Electron Builder packaging (dmg + zip) [mode: $MODE, arch: $ARCH]..."
if [[ "$MODE" == "release" ]]; then
  echo "  compression=maximum (体积最小，构建慢)"
else
  echo "  compression=normal (快速)"
fi
echo "  Generating dmg + zip..."

RELEASE_DIR="release/$VERSION"

# 清理上次失败残留，避免目录冲突
if [[ -d "$RELEASE_DIR" ]]; then
  find "$RELEASE_DIR" -maxdepth 1 -name "*.tmp" -type d -exec rm -rf {} + 2>/dev/null || true
  rm -rf "$RELEASE_DIR"/mac "$RELEASE_DIR"/mac-arm64 "$RELEASE_DIR"/mac-universal 2>/dev/null || true
fi

# 目标架构参数
case "$ARCH" in
  x64)       ARCH_ARGS=(--x64) ;;
  arm64)     ARCH_ARGS=(--arm64) ;;
  universal) ARCH_ARGS=(--universal) ;;
  *) err "无效架构: $ARCH（可选 x64 / arm64 / universal）"; exit 1 ;;
esac

# release 模式覆盖 yml 默认 compression=normal 为 maximum
EXTRA_ARGS=()
if [[ "$MODE" == "release" ]]; then
  EXTRA_ARGS+=("--config.compression=maximum")
fi

# --publish never：禁用 CI 环境下的隐式自动发布
# --config.disableAsarIntegrity=true：跳过 asar 头部哈希计算。
#   原因：项目若位于 exFAT/NTFS 等非 APFS 卷，macOS 会为每个文件生成 ._ 伴生元数据文件，
#   其中 ._app.asar 会被 electron-builder 的 asar 完整性扫描误当作 asar 解析并抛出 RangeError；
#   未做代码签名/公证时该完整性校验无实际作用，跳过不影响应用运行。
# 按 electron-builder.yml 中 mac.target=dmg,zip 生成产物
# 注意：macOS 自带 bash 3.2，set -u 下空数组直接展开会报 unbound variable，故用 ${arr[@]+...} 兜底
npx electron-builder --mac "${ARCH_ARGS[@]}" --publish never --config.disableAsarIntegrity=true ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
echo ""

# ── 结果 ──
shopt -s nullglob
DMGS=("$RELEASE_DIR"/*.dmg)
ZIPS=("$RELEASE_DIR"/*.zip)
shopt -u nullglob

human_size() { awk "BEGIN{printf \"%.1f\", $(stat -f%z "$1")/1048576}"; }

if [[ ${#DMGS[@]} -gt 0 || ${#ZIPS[@]} -gt 0 ]]; then
  echo ""
  success "========================================"
  success "  Build completed!"
  success "========================================"
  echo ""
  for f in ${DMGS[@]+"${DMGS[@]}"}; do
    echo "  DMG: $f ($(human_size "$f")MB)"
  done
  for f in ${ZIPS[@]+"${ZIPS[@]}"}; do
    echo "  ZIP: $f ($(human_size "$f")MB)"
  done
  echo ""
  echo "  Unpacked app: $RELEASE_DIR/mac*/WorkAvatar.app (用于调试)"
  echo ""
  echo "  首次打开未签名应用：右键 → 打开；或执行"
  echo "    xattr -cr \"$RELEASE_DIR\"/mac*/WorkAvatar.app"
  success "========================================"
else
  err "未找到打包产物（dmg/zip），请检查 electron-builder 输出。"
  exit 1
fi
