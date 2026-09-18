# -*- coding: utf-8 -*-
import os
from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.abspath(__file__))


def draw_icon(size, small=False, tiny=None):
    # tiny 显式传入（针对 ico 内 ≤24px 的目标帧）
    if tiny is None:
        tiny = small and size <= 24
    k = size / 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def X(v):
        return v * k

    # 背景：小尺寸用纯色更清晰，大尺寸保留渐变
    r = X(100 * (1.15 if small else 1))
    bd = ImageDraw.Draw(img)
    if small:
        bd.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(r), fill=(27, 111, 222, 255))
    else:
        bg = Image.new("RGBA", (size, size))
        top, bottom = (27, 113, 220), (14, 86, 180)
        for y in range(size):
            t = y / max(size - 1, 1)
            c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
            ImageDraw.Draw(bg).line([(0, y), (size, y)], fill=c)
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(r), fill=255)
        img.paste(bg, (0, 0), mask)

    # 小尺寸变体：图形整体放大，减少留白
    gs = (1.42 if tiny else 1.28) if small else 1.0

    def P(x, y):
        x, y = X(x), X(y)
        if small:
            x = size / 2 + (x - size / 2) * gs
            y = size / 2 + (y - size / 2) * gs
        return x, y

    pts = [(130, 186), (192, 362), (256, 252), (320, 362), (382, 186)]
    # 极简版（≤24px）：去掉头部圆点，笔画加粗，避免糊成一团
    w = X(58) * gs * (1.2 if tiny else 1)
    d.line([P(x, y) for x, y in pts], fill=(255, 255, 255, 255), width=int(w), joint="curve")
    rad = w / 2
    for p in (P(130, 186), P(382, 186)):
        d.ellipse([p[0] - rad, p[1] - rad, p[0] + rad, p[1] + rad], fill=(255, 255, 255, 255))
    for p in [P(x, y) for x, y in pts[1:-1]]:
        d.ellipse([p[0] - rad * 0.55, p[1] - rad * 0.55, p[0] + rad * 0.55, p[1] + rad * 0.55], fill=(255, 255, 255, 255))

    if not tiny:
        nh, nr = P(256, 170)
        rr = X(40) * gs
        d.ellipse([nh - rr, nr - rr, nh + rr, nr + rr], fill=(255, 255, 255, 255))
    return img


def main():
    draw_icon(1024).resize((512, 512), Image.LANCZOS).save(os.path.join(BASE, "icon.png"))

    # ico：16-48 用小变体保证任务栏/托盘清晰
    ico_sizes = [(16, 16), (20, 20), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    frames = []
    for sz, _ in ico_sizes:
        if sz <= 48:
            frames.append(draw_icon(sz * 8, small=True, tiny=sz <= 24).resize((sz, sz), Image.LANCZOS))
        else:
            frames.append(draw_icon(sz * 4).resize((sz, sz), Image.LANCZOS))
    frames[-1].save(os.path.join(BASE, "icon.ico"), sizes=ico_sizes, append_images=frames[:-1])

    draw_icon(1024).save(os.path.join(BASE, "icon.icns"))


if __name__ == "__main__":
    main()
