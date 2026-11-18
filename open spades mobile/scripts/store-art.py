# Renders Play Store graphics: 512x512 icon and 1024x500 feature graphic. Usage: python store_art.py <mobile project dir>
import sys, math
from PIL import Image, ImageDraw, ImageFilter
root = sys.argv[1]
BG, BG2 = (22, 36, 26), (11, 18, 13)

def spade(size, scale):
    """The launcher icon's voxel spade (same geometry as ic_launcher_foreground.xml, 108-unit grid)."""
    img = Image.new('RGBA', (108 * scale, 108 * scale), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    s = lambda pts: [(x * scale, y * scale) for x, y in pts]
    rect = lambda x, y, w, h, c: d.polygon(s([(x, y), (x + w, y), (x + w, y + h), (x, y + h)]), fill=c)
    rect(44, 24, 20, 6, (107, 74, 43)); rect(51, 28, 6, 30, (138, 98, 57)); rect(55, 28, 2, 30, (107, 74, 43))
    rect(48, 56, 12, 6, (154, 165, 154))
    d.polygon(s([(42, 60), (66, 60), (66, 76), (62, 82), (54, 88), (46, 82), (42, 76)]), fill=(197, 223, 145))
    d.polygon(s([(54, 60), (66, 60), (66, 76), (62, 82), (54, 88)]), fill=(143, 184, 115))
    img = img.rotate(40, resample=Image.BICUBIC, center=(54 * scale, 54 * scale))
    return img.resize((size, size), Image.LANCZOS)

def gradient(w, h):
    img = Image.new('RGB', (w, h)); px = img.load()
    for y in range(h):
        for x in range(w):
            t = min(1, math.hypot(x / w - .3, y / h - .4) * 1.3)
            px[x, y] = tuple(int(BG[i] * (1 - t) + BG2[i] * t) for i in range(3))
    return img

icon = gradient(512, 512)
icon.paste(spade(700, 8), (-94, -94), spade(700, 8))
icon.save(f'{root}/store/icon-512.png')

fg = gradient(1024, 500)
logo = Image.open(f'{root}/web/assets/Gfx/Title/Logo.png').convert('RGBA')
logo = logo.resize((logo.width * 11 // 10, logo.height * 11 // 10), Image.LANCZOS)
glow = Image.new('RGBA', fg.size, (0, 0, 0, 0)); glow.paste(spade(560, 8), (520, -40)); glow = glow.filter(ImageFilter.GaussianBlur(28))
fg.paste(glow, (0, 0), glow)
fg.paste(spade(520, 8), (540, -20), spade(520, 8))
fg.paste(logo, (48, 140), logo)
d = ImageDraw.Draw(fg)
try:
    from PIL import ImageFont
    f = ImageFont.truetype(f'{root}/web/assets/Gfx/Fonts/AlteDIN1451.ttf', 40)
except Exception:
    f = None
d.text((60, 310), 'BUILD.  DIG.  FIGHT.', fill=(197, 223, 145), font=f)
fg.save(f'{root}/store/feature-graphic-1024x500.png')
print('ok')
