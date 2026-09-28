# -*- coding: utf-8 -*-
"""
生成 LCD 点阵字模头文件（供 ESP32-S3-EYE 的 ST7789 显示）。

输出：
  ../main/lcd_font.h    —— C 头文件（中文 32x32 + ASCII 8x16）
  font_preview.png      —— 预览图，便于肉眼核对字模是否正常

用法：
  python gen_font.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_H = os.path.normpath(os.path.join(HERE, "..", "main", "lcd_font.h"))
PREVIEW = os.path.join(HERE, "font_preview.png")

# 屏幕上要用到的全部汉字（去重后）
ZH_CHARS = "空闲求助已发送等待回应对方收到取消连接中按键按一下"
ZH_SIZE = 32

ASCII_FIRST, ASCII_LAST = 0x20, 0x7E
ASCII_W, ASCII_H = 8, 16


def pick_font(paths, size):
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    raise RuntimeError("找不到可用字体: %r" % (paths,))


zh_font = pick_font(["C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/msyh.ttc"], ZH_SIZE)
ascii_font = pick_font(
    ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
     "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/simhei.ttf"],
    ASCII_H - 2,
)


def render(ch, font, w, h):
    """把单个字符渲染到 w*h 的 1bit 画布，居中。"""
    img = Image.new("1", (w, h), 0)
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), ch, font=font)
    gw = bbox[2] - bbox[0]
    gh = bbox[3] - bbox[1]
    x = (w - gw) // 2 - bbox[0]
    y = (h - gh) // 2 - bbox[1]
    d.text((x, y), ch, font=font, fill=1)
    return img


def pack(img, w, h):
    """按行、MSB 在左打包为字节序列。"""
    out = bytearray()
    for y in range(h):
        cur = 0
        n = 0
        for x in range(w):
            cur = (cur << 1) | (1 if img.getpixel((x, y)) else 0)
            n += 1
            if n == 8:
                out.append(cur)
                cur = 0
                n = 0
        if n:
            out.append(cur << (8 - n))
    return bytes(out)


zh_glyphs = [(ord(c), pack(render(c, zh_font, ZH_SIZE, ZH_SIZE), ZH_SIZE, ZH_SIZE))
             for c in ZH_CHARS]
ascii_glyphs = [pack(render(chr(cp), ascii_font, ASCII_W, ASCII_H), ASCII_W, ASCII_H)
                for cp in range(ASCII_FIRST, ASCII_LAST + 1)]


def fmt_bytes(b, per=16):
    lines = []
    for i in range(0, len(b), per):
        lines.append("    " + ", ".join("0x%02X" % x for x in b[i:i + per]) + ",")
    return "\n".join(lines)


zh_bytes = ZH_SIZE * ZH_SIZE // 8
ascii_bytes = ASCII_W * ASCII_H // 8

with open(OUT_H, "w", encoding="utf-8") as f:
    f.write("/* 自动生成，请勿手改。重新生成：python tools/gen_font.py\n")
    f.write(" * 中文 %dx%d（%d 字，%d 字节/字）；ASCII %dx%d（0x%02X-0x%02X，%d 字节/字）。\n"
            % (ZH_SIZE, ZH_SIZE, len(zh_glyphs), zh_bytes,
               ASCII_W, ASCII_H, ASCII_FIRST, ASCII_LAST, ascii_bytes))
    f.write(" */\n")
    f.write("#pragma once\n#include <stdint.h>\n\n")
    f.write("#define LCD_ZH_W %d\n#define LCD_ZH_H %d\n" % (ZH_SIZE, ZH_SIZE))
    f.write("#define LCD_ASCII_W %d\n#define LCD_ASCII_H %d\n\n" % (ASCII_W, ASCII_H))

    f.write("static const uint32_t LCD_ZH_CP[] = {\n")
    for cp, _ in zh_glyphs:
        f.write("    0x%04X, /* %s */\n" % (cp, chr(cp)))
    f.write("};\n#define LCD_ZH_COUNT (sizeof(LCD_ZH_CP)/sizeof(LCD_ZH_CP[0]))\n\n")

    f.write("static const uint8_t LCD_ZH_BMP[][%d] = {\n" % zh_bytes)
    for cp, b in zh_glyphs:
        f.write("  { /* %s */\n%s\n  },\n" % (chr(cp), fmt_bytes(b)))
    f.write("};\n\n")

    f.write("static const uint8_t LCD_ASCII_BMP[][%d] = {\n" % ascii_bytes)
    for i, b in enumerate(ascii_glyphs):
        name = "space" if i == 0 else chr(ASCII_FIRST + i)
        f.write("  { /* %s */\n%s\n  },\n" % (name, fmt_bytes(b, 8)))
    f.write("};\n")

# ---- 预览图（中文一行 + ASCII 几行）----
cols = 8
zh_rows = (len(zh_glyphs) + cols - 1) // cols
cell = 36
pv = Image.new("L", (cols * cell, zh_rows * cell + 3 * 20 + 10), 0)
for i, (cp, _) in enumerate(zh_glyphs):
    img = render(chr(cp), zh_font, ZH_SIZE, ZH_SIZE).convert("L")
    pv.paste(img, ((i % cols) * cell + 2, (i // cols) * cell + 2))
y0 = zh_rows * cell + 6
for row, start in enumerate([0x20, 0x40, 0x60]):
    strip = Image.new("L", (96 * 8, 16), 0)
    for j in range(96):
        cp = start + j
        if cp > ASCII_LAST:
            break
        strip.paste(render(chr(cp), ascii_font, ASCII_W, ASCII_H).convert("L"), (j * 8, 0))
    pv.paste(strip, (2, y0 + row * 20))
pv.save(PREVIEW)

print("ZH glyphs : %d (%d bytes each)" % (len(zh_glyphs), zh_bytes))
print("ASCII     : %d (%d bytes each)" % (len(ascii_glyphs), ascii_bytes))
print("header    : %s" % OUT_H)
print("preview   : %s" % PREVIEW)
