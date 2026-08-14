#!/usr/bin/env python3
"""Generates brand assets for AI Agent Bridge.

Run from the repo root with the project venv:
    .venv/Scripts/python.exe scripts/generate-brand-assets.py

Outputs:
    assets/logo.png          512x512 extension icon (bridge motif)
    assets/social-preview.png  1280x640 banner for the repo About panel
    pics/architecture.png    1280x720 request-flow diagram for the README
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent

BG_TOP = (23, 20, 31)
BG_BOTTOM = (36, 31, 51)
PANEL = (38, 34, 56)
PANEL_BORDER = (58, 53, 84)
TEAL = (79, 209, 197)
ORANGE = (255, 158, 100)
BLUE = (138, 140, 255)
TEXT = (232, 230, 242)
MUTED = (157, 160, 201)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vertical_gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        c = lerp(top, bottom, y / max(1, h - 1))
        for x in range(w):
            px[x, y] = c
    return img


def rounded_mask(size, radius):
    mask = Image.new("L", size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return mask


def cable_points(x0, y0, x1, y1, sag, steps=48):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        pts.append((x0 + (x1 - x0) * t, y0 + sag * (2 * t - 1) ** 2))
    return pts


def gradient_polyline(img, pts, start, end, width, glow=False):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    n = len(pts) - 1
    for i in range(n):
        c = lerp(start, end, i / n) + (255,)
        d.line([pts[i], pts[i + 1]], fill=c, width=width)
    if glow:
        layer = layer.filter(ImageFilter.GaussianBlur(width * 1.6))
    img.alpha_composite(layer)
    return layer


def draw_logo():
    size = 1024
    img = vertical_gradient((size, size), BG_TOP, BG_BOTTOM).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, (0, 0), rounded_mask((size, size), 230))
    img = canvas
    d = ImageDraw.Draw(img)

    # soft glow behind the bridge
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([180, 140, 844, 700], fill=ORANGE + (36,))
    gd.ellipse([240, 220, 784, 660], fill=TEAL + (30,))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(90)))

    # towers
    for x0 in (300, 676):
        d.rounded_rectangle([x0, 210, x0 + 48, 650], radius=22, fill=(85, 84, 122))
        d.ellipse([x0 - 6, 188, x0 + 54, 248], fill=BLUE + (200,))

    cable = cable_points(324, 232, 700, 232, 128)
    # glow pass then crisp pass
    gradient_polyline(img, cable, TEAL, ORANGE, 30, glow=True)
    gradient_polyline(img, cable, TEAL, ORANGE, 18)

    # deck
    deck = [
        (212, 566 + 14 * math.sin(math.pi * i / 48))
        for i in range(49)
    ]
    gradient_polyline(img, deck, (214, 211, 234), (255, 190, 140), 34, glow=True)
    d.line(deck, fill=(214, 211, 234), width=26)

    # suspenders
    for t in range(1, 8):
        x = 324 + (700 - 324) * t / 8
        y = 232 + 128 * (2 * t / 8 - 1) ** 2
        deck_x = 212 + (812 - 212) * t / 8
        deck_y = 566 + 14 * math.sin(math.pi * t / 8)
        d.line([(x, y + 14), (deck_x, deck_y - 10)], fill=BLUE + (150,), width=6)

    # left node: terminal
    d.rounded_rectangle([216, 650, 396, 786], radius=34, fill=PANEL, outline=TEAL, width=8)
    f = ImageFont.truetype(FONT_BOLD, 96)
    d.text((256, 668), ">_", font=f, fill=TEAL)

    # right node: chat bubble
    d.rounded_rectangle([628, 650, 808, 786], radius=34, fill=PANEL, outline=ORANGE, width=8)
    for i, dx in enumerate((0, 54, 108)):
        d.ellipse([662 + dx, 710, 686 + dx, 734], fill=ORANGE)

    # ground line
    d.line([330, 816, 694, 816], fill=(120, 116, 160), width=8)

    return img.resize((512, 512), Image.LANCZOS)


def rounded_panel(img, box, radius, fill, outline=None, width=1):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_chip(img, box, text, color, font_size=30):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle(box, radius=box[3] - box[1] // 1 and (box[3] - box[1]) // 2, fill=PANEL, outline=color, width=3)
    f = ImageFont.truetype(FONT_REG, font_size)
    bbox = d.textbbox((0, 0), text, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((box[0] + (box[2] - box[0] - tw) / 2, box[1] + (box[3] - box[1] - th) / 2 - bbox[1]), text, font=f, fill=color)


def fit_font(d, text, font_path, max_width, start_size, min_size=22):
    """Returns the largest font (decrementing by 4) whose text fits max_width."""
    size = start_size
    while size > min_size:
        f = ImageFont.truetype(font_path, size)
        bbox = d.textbbox((0, 0), text, font=f)
        if bbox[2] - bbox[0] <= max_width:
            return f
        size -= 4
    return ImageFont.truetype(font_path, min_size)


def text_size(d, text, font):
    bbox = d.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def draw_social_preview():
    w, h = 1280, 640
    img = vertical_gradient((w, h), BG_TOP, BG_BOTTOM).convert("RGBA")
    d = ImageDraw.Draw(img)

    # Real repo logo (assets/logo.png), centered vertically on the left.
    logo = Image.open(ROOT / "assets" / "logo.png").convert("RGBA")
    logo_size = 420
    logo = logo.resize((logo_size, logo_size), Image.LANCZOS)
    logo_pos = (64, (h - logo_size) // 2)
    img.paste(logo, logo_pos, logo)

    # Text column right of the logo; everything auto-fits the available width.
    text_x = 560
    text_w = w - text_x - 56

    f_title = fit_font(d, "AI Agent Bridge", FONT_BOLD, text_w, 96)
    f_sub = fit_font(d, "Local models, DeepSeek, Codex and Claude", FONT_REG, text_w, 44)

    title_y = 150
    d.text((text_x, title_y), "AI Agent Bridge", font=f_title, fill=TEXT)
    title_h = text_size(d, "AI Agent Bridge", f_title)[1]
    sub_y = title_y + title_h + 28
    d.text((text_x, sub_y), "Local models, DeepSeek, Codex and Claude", font=f_sub, fill=MUTED)
    sub_h = text_size(d, "Local models, DeepSeek, Codex and Claude", f_sub)[1]
    d.text((text_x, sub_y + sub_h + 10), "inside one native VS Code agent workflow.", font=f_sub, fill=MUTED)

    # Chips laid out from measured widths, wrapped to a second row if needed.
    chip_defs = [
        ("Local LLM", TEAL),
        ("DeepSeek", BLUE),
        ("Codex", ORANGE),
        ("Claude", (250, 180, 220)),
        ("Native tools", TEXT),
    ]
    chip_font_size = 30
    f_chip = ImageFont.truetype(FONT_REG, chip_font_size)
    pad_x, pad_y = 26, 16
    chip_h = chip_font_size + 2 * pad_y + 8
    gap = 16
    chip_y = max(sub_y + 2 * sub_h + 60, 452)
    x = text_x
    row_gap = 0
    for text, color in chip_defs:
        tw, _ = text_size(d, text, f_chip)
        box_w = tw + 2 * pad_x
        if x + box_w > text_x + text_w:
            x = text_x
            row_gap += chip_h + 12
        draw_chip(img, [x, chip_y + row_gap, x + box_w, chip_y + row_gap + chip_h], text, color, chip_font_size)
        x += box_w + gap

    return img


def draw_architecture():
    w, h = 1280, 720
    img = vertical_gradient((w, h), BG_TOP, BG_BOTTOM).convert("RGBA")
    d = ImageDraw.Draw(img)

    d.text((48, 32), "AI Agent Bridge — request flow", font=ImageFont.truetype(FONT_BOLD, 40), fill=TEXT)

    def arrow_right(color, x, cy):
        d.line([(x, cy), (x - 14, cy - 10)], fill=color, width=4)
        d.line([(x, cy), (x - 14, cy + 10)], fill=color, width=4)

    # --- Left: source boxes, one shared width that fits every text ---
    sources = [
        ("Local llama.cpp", "OpenAI-compatible HTTP", TEAL),
        ("Custom API profiles", "any /models gateway", BLUE),
        ("DeepSeek API", "paid API account", BLUE),
        ("Codex", "ChatGPT app-server", ORANGE),
        ("Claude", "Agent SDK + account", (250, 180, 220)),
    ]
    name_font = ImageFont.truetype(FONT_BOLD, 30)
    sub_font = ImageFont.truetype(FONT_REG, 24)
    pad_x = 24
    max_name_w = max(text_size(d, t, name_font)[0] for t, _, _ in sources)
    max_sub_w = max(text_size(d, t, sub_font)[0] for t, _, _ in sources)
    box_w = max(260, max_name_w + 2 * pad_x, max_sub_w + 2 * pad_x)
    box_h, gap = 92, 24
    x0, y0 = 56, 116
    box_positions = []
    for i, (name, sub, color) in enumerate(sources):
        y = y0 + i * (box_h + gap)
        box_positions.append((y, color))
        rounded_panel(img, [x0, y, x0 + box_w, y + box_h], 18, PANEL, color, 3)
        d.text((x0 + pad_x, y + 16), name, font=name_font, fill=TEXT)
        d.text((x0 + pad_x, y + 56), sub, font=sub_font, fill=MUTED)

    first_cy = box_positions[0][0] + box_h / 2
    last_cy = box_positions[-1][0] + box_h / 2
    mid_y = (first_cy + last_cy) / 2
    bus_x = x0 + box_w + 28

    # vertical bus joins every source exit; stubs point right into the bus
    d.line([(bus_x, first_cy), (bus_x, last_cy)], fill=(138, 134, 182), width=4)
    for y, color in box_positions:
        cy = y + box_h / 2
        d.line([(x0 + box_w, cy), (bus_x, cy)], fill=color, width=4)
        arrow_right(color, bus_x, cy)

    # --- Center: bridge block, vertically centered on the sources ---
    center_w, center_h = 340, 76
    cx0 = bus_x + 44
    cy0 = mid_y - center_h / 2
    rounded_panel(img, [cx0, cy0, cx0 + center_w, cy0 + center_h], 24, PANEL, TEAL, 4)
    f_box = ImageFont.truetype(FONT_BOLD, 30)
    f_small = ImageFont.truetype(FONT_REG, 22)
    d.text((cx0 + 24, cy0 + 12), "AI Agent Bridge", font=f_box, fill=TEXT)
    center_sub = "routing · guardrails · cache"
    center_sub_font = fit_font(d, center_sub, FONT_REG, center_w - 48, 22, 18)
    d.text((cx0 + 24, cy0 + 46), center_sub, font=center_sub_font, fill=MUTED)

    # connector bus -> center, arrowhead points right into the block
    d.line([(bus_x, mid_y), (cx0, mid_y)], fill=TEAL, width=4)
    arrow_right(TEAL, cx0, mid_y)

    # --- Right: VS Code block; horizontal connector through the row gap ---
    vy0, vy1 = 116, 604
    vx1 = 1224
    vx0 = cx0 + center_w + 44
    rows = [
        ("Model picker", "all sources in one list"),
        ("Native tool cards", "visible + approvals"),
        ("Shared memory", "workspace / global"),
        ("Quick Access", "balance, limits, peak hours"),
        ("Session Quality", "cache · tokens · latency"),
    ]
    row_y = vy0 + 64
    row_h = 78
    gap_y = vy0 + 64 + 3 * row_h - 10  # sits between the 3rd and 4th rows
    d.line([(cx0 + center_w, mid_y), (cx0 + center_w + 24, mid_y)], fill=ORANGE, width=4)
    d.line([(cx0 + center_w + 24, mid_y), (cx0 + center_w + 24, gap_y)], fill=ORANGE, width=4)
    d.line([(cx0 + center_w + 24, gap_y), (vx0, gap_y)], fill=ORANGE, width=4)
    arrow_right(ORANGE, vx0, gap_y)

    rounded_panel(img, [vx0, vy0, vx1, vy1], 24, PANEL, ORANGE, 4)
    d.text((vx0 + 24, vy0 + 20), "VS Code Copilot Chat", font=f_box, fill=TEXT)
    row_name_font = ImageFont.truetype(FONT_BOLD, 24)
    for name, sub in rows:
        d.ellipse([vx0 + 24, row_y + 6, vx0 + 40, row_y + 22], fill=ORANGE)
        d.text((vx0 + 56, row_y), name, font=row_name_font, fill=TEXT)
        sub_fit = fit_font(d, sub, FONT_REG, vx1 - vx0 - 80, 24, 18)
        d.text((vx0 + 56, row_y + 30), sub, font=sub_fit, fill=MUTED)
        row_y += row_h

    return img
def main():
    # NEVER overwrite assets/logo.png: it is the official logo maintained by
    # the user. The placeholder below is only a fallback for the preview
    # artwork when no logo exists yet.
    logo_path = ROOT / "assets" / "logo.png"
    if not logo_path.exists():
        draw_logo().save(logo_path)
    draw_social_preview().save(ROOT / "assets" / "social-preview.png")
    draw_architecture().save(ROOT / "assets" / "architecture.png")
    print("assets generated")


if __name__ == "__main__":
    main()
