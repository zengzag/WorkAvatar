#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_d2.py — D2 图表渲染封装（Windows / UTF-8）

用途：将 .d2 文本图表渲染为 SVG（矢量，推荐用于 Word/PPT 插入），
     可选渲染 PNG / PPTX / PDF（需本机具备 Playwright driver）。

用法示例：
  python render_d2.py input.d2                        # 输出 input.svg
  python render_d2.py input.d2 -o out.svg             # 指定输出
  python render_d2.py input.d2 --format png --scale 3 # PNG 3 倍缩放（需 Playwright，本机通常不可用）
  python render_d2.py input.d2 --layout elk --theme 4
  python render_d2.py input.d2 --png-fallback         # 渲染 SVG 后自动用 Edge/Chrome 生成 PNG（docx 插图 fallback 用）
  python render_d2.py input.d2 --png-fallback 2       # PNG 按 2 倍像素生成
  python render_d2.py input.d2 --font-regular C:\\Windows\\Fonts\\simhei.ttf   # 仅支持 .ttf/.otf，禁用 .ttc

依赖：d2 可执行文件（自动探测 PATH 或 C:\\Program Files\\D2\\d2.exe）
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

# 常见安装位置（Windows）
D2_CANDIDATES = [
    r"C:\Program Files\D2\d2.exe",
    r"C:\Program Files\d2\d2.exe",
    r"C:\d2\d2.exe",
    os.path.expanduser(r"~\d2\bin\d2.exe"),
    os.path.expanduser(r"~\scoop\shims\d2.exe"),
]
# SVG → PNG 兜底用浏览器（--png-fallback，替代 Playwright）
BROWSER_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
PLAYWRIGHT_DRIVER_MARK = "playwright-1.47.2-win32_x64"


def find_browser():
    """定位可用的 headless 浏览器（Edge/Chrome），用于 SVG→PNG 兜底转换。"""
    for cand in BROWSER_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return shutil.which("msedge") or shutil.which("chrome") or None


def svg_to_png(browser, svg_path, png_path, w, h, timeout=90):
    """用浏览器 headless 截图 SVG 生成 PNG（旧 --headless 模式，实测稳定）。

    注意：svg_path / png_path 必须为绝对路径（Edge headless 不解析相对路径，
    相对 file:// URL 会导致截图失败但无报错）。
    """
    svg_path = os.path.abspath(svg_path)
    png_path = os.path.abspath(png_path)
    url = "file:///" + svg_path.replace("\\", "/")
    cmd = [
        browser, "--headless", "--disable-gpu", "--hide-scrollbars",
        f"--window-size={int(w)},{int(h)}",
        f"--screenshot={png_path}", url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception as e:
        sys.stderr.write(f"警告：SVG→PNG 转换失败：{e}\n")
    return os.path.isfile(png_path)


def find_d2():
    """定位 d2 可执行文件。优先级：环境变量 D2_EXE > PATH > 常见安装位置。"""
    env = os.environ.get("D2_EXE")
    if env and os.path.isfile(env):
        return env
    p = shutil.which("d2")
    if p:
        return p
    for cand in D2_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return None


def playwright_available():
    """检测 PNG/PPTX/PDF 所需的 Playwright driver 是否就绪。"""
    bases = [
        os.environ.get("LOCALAPPDATA", ""),
        os.path.expanduser(r"~\AppData\Local"),
    ]
    for base in bases:
        if not base:
            continue
        root = os.path.join(base, "ms-playwright")
        if not os.path.isdir(root):
            continue
        try:
            for name in os.listdir(root):
                if name.startswith("playwright-"):
                    return True
        except OSError:
            pass
    return False


def read_svg_size(svg_path):
    """从 SVG 中解析 width/height（像素），供文档插入时参考。"""
    try:
        with open(svg_path, "r", encoding="utf-8") as f:
            head = f.read(4096)
        m = re.search(r'<svg[^>]*?width="([\d.]+)"[^>]*?height="([\d.]+)"', head)
        if m:
            return float(m.group(1)), float(m.group(2))
    except Exception:
        pass
    return None, None


def main():
    ap = argparse.ArgumentParser(description="D2 图表渲染封装")
    ap.add_argument("input", help="输入 .d2 文件路径")
    ap.add_argument("-o", "--out", help="输出文件路径（默认：输入同名 + 格式扩展名）")
    ap.add_argument("--format", choices=["svg", "png", "pptx", "pdf"],
                    default="svg", help="输出格式（默认 svg，矢量推荐）")
    ap.add_argument("--theme", type=int, default=0, help="主题 ID（默认 0，可用 d2 themes 查看）")
    ap.add_argument("--layout", default=None, help="布局引擎：dagre（默认，流程）/ elk（分层架构）")
    ap.add_argument("--scale", type=float, default=2.0, help="PNG 缩放倍数（默认 2，需 Playwright；本机通常不可用）")
    ap.add_argument("--font-regular", default=None, help="正文字体 .ttf/.otf 路径（仅单文件字体；推荐 C:\\Windows\\Fonts\\simhei.ttf，禁用 .ttc 集合字体）")
    ap.add_argument("--font-bold", default=None, help="粗体字体 .ttf/.otf 路径")
    ap.add_argument("--png-fallback", nargs="?", const=1, type=float, default=None,
                    help="渲染 SVG 后用 Edge/Chrome headless 生成同尺寸 PNG（供 docx/pptx 插图 fallback）；可跟数字指定像素倍数，如 --png-fallback 2")
    ap.add_argument("--pad", type=int, default=100, help="图表内边距像素（默认 100）")
    ap.add_argument("--no-size", action="store_true", help="不打印 SVG 尺寸信息")
    args = ap.parse_args()

    d2 = find_d2()
    if not d2:
        sys.exit("错误：未找到 d2 可执行文件。请安装 D2 或设置环境变量 D2_EXE 指向 d2.exe。")

    if not os.path.isfile(args.input):
        sys.exit(f"错误：输入文件不存在：{args.input}")

    if args.format != "svg" and not playwright_available():
        sys.exit(
            f"错误：{args.format.upper()} 导出需要 Playwright driver，本机未检测到（{PLAYWRIGHT_DRIVER_MARK}）。\n"
            "      当前环境建议使用 SVG 格式（Word/PPT 均支持矢量 SVG 插入）。"
        )

    if not args.out:
        base = os.path.splitext(args.input)[0]
        args.out = f"{base}.{args.format}"

    cmd = [d2]
    cmd += [f"--theme={args.theme}"]
    if args.layout:
        cmd += [f"--layout={args.layout}"]
    if args.format == "png":
        cmd += [f"--scale={args.scale}"]
    if args.font_regular:
        cmd += [f"--font-regular={args.font_regular}"]
    if args.font_bold:
        cmd += [f"--font-bold={args.font_bold}"]
    cmd += [f"--pad={args.pad}", args.input, args.out]

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except Exception as e:
        sys.exit(f"错误：执行 d2 失败：{e}")

    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"错误：D2 编译失败（exit={proc.returncode}），详见上方 stderr。")

    if not args.no_size and args.format == "svg":
        w, h = read_svg_size(args.out)
        size_note = f"（尺寸 {w:.0f}×{h:.0f} px）" if w else ""
        print(f"已生成：{args.out} {size_note}")
    else:
        print(f"已生成：{args.out}")

    # SVG → PNG 兜底（--png-fallback，docx/pptx 插图 fallback 用）
    if args.format == "svg" and args.png_fallback:
        w, h = read_svg_size(args.out)
        if not w:
            sys.stderr.write("警告：无法读取 SVG 尺寸，跳过 PNG 生成。\n")
            return 1
        browser = find_browser()
        if not browser:
            sys.stderr.write("警告：未找到 Edge/Chrome，无法生成 PNG fallback。\n")
            return 1
        scale = args.png_fallback
        png_out = os.path.splitext(args.out)[0] + ".png"
        if svg_to_png(browser, args.out, png_out, w * scale, h * scale):
            print(f"已生成 PNG fallback：{png_out}（{int(w * scale)}×{int(h * scale)} px）")
        else:
            sys.stderr.write("警告：PNG fallback 生成失败（检查浏览器路径或 SVG 是否可被浏览器打开）。\n")
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
