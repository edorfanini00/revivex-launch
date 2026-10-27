"""Round 3 photo pipeline: slot-specific crops exported as AVIF, WebP and JPEG.

Usage: python3 scripts/r3-images.py <masters dir> <app screenshot dir>
Masters are the approved generated photos upscaled 2x with Real-ESRGAN x2plus
(<name>@2x.png). Crops are given in original (1x) pixels (x0, y0, x1, y1) and were
chosen so the machine is never cut and never sits under the phone mockup or the copy.
Writes public/assets/r3/.
"""
import os, sys
from PIL import Image

GEN, APP = sys.argv[1], sys.argv[2]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'r3')
os.makedirs(OUT, exist_ok=True)

# name: (source, crop or None, output widths)
SLOTS = {
    'hero-d':  ('hero-16x9.png', None, [1280, 1920, 2560]),
    'hero-m':  ('hero-tall.png', None, [640, 960, 1280]),
    # How it works. Desktop stage (668:900), phone mockup over the right edge:
    # 1 screen (connect data), 2 detail (labs), 3 front (routine), 4 pour (no phone).
    'hiw1-d':  ('screen.png', (440, 0, 1200, 1024), [600, 1000, 1400]),
    'hiw2-d':  ('detail.png', (0, 0, 931, 1254), [600, 1000, 1400]),
    'hiw3-d':  ('front.png', (400, 0, 1160, 1024), [600, 1000, 1400]),
    'hiw4-d':  ('pour.png', (600, 0, 1360, 1024), [600, 1000, 1400]),
    # Phone cards (9:10); the large phone sits over the right 46%, so the subject is left.
    'hiw1-m':  ('screen.png', (500, 0, 1422, 1024), [640, 960]),
    'hiw2-m':  ('detail.png', (600, 180, 1254, 907), [640, 960]),
    'hiw3-m':  ('front.png', (480, 0, 1402, 1024), [640, 960]),
    'hiw4-m':  ('pour.png', (600, 0, 1522, 1024), [640, 960]),
    # Why cards, desktop (square) and phone (0.92): hand, a pour macro (glass and
    # bubbles, a different framing from step 4), and the counter by the window.
    'why1-d':  ('hand.png', (0, 150, 1122, 1272), [600, 1000]),
    'why2-d':  ('pour.png', (720, 470, 1150, 900), [600, 860]),
    'why3-d':  ('context.png', (150, 141, 950, 941), [600, 1000]),
    'why1-m':  ('hand.png', (0, 100, 1122, 1320), [700, 1050]),
    'why2-m':  ('pour.png', (735, 460, 1135, 895), [700]),
    'why3-m':  ('context.png', (160, 61, 960, 931), [700, 1050]),
    # Final band
    'final-d': ('context.png', None, [1280, 1920, 2560]),
    'final-m': ('context.png', (680, 0, 1621, 941), [640, 960, 1280]),
}

def save(im, base):
    im.save(base + '.avif', quality=58, speed=4)
    im.save(base + '.webp', quality=80, method=6)
    im.save(base + '.jpg', quality=82, optimize=True, progressive=True)

for name, (src, crop, widths) in SLOTS.items():
    im = Image.open(os.path.join(GEN, src.replace('.png', '@2x.png'))).convert('RGB')
    if crop: im = im.crop(tuple(2 * v for v in crop))
    for w in widths:
        w = min(w, im.width)
        h = round(im.height * w / im.width)
        save(im.resize((w, h), Image.LANCZOS) if w != im.width else im, os.path.join(OUT, f'{name}-{w}'))
    print(name, im.size, widths)

# Real app screens, content unaltered (resized only).
for name in ['health', 'labs-recorded', 'sleep-recorded']:
    im = Image.open(os.path.join(APP, name + '.png')).convert('RGB')
    w = 600; h = round(im.height * w / im.width)
    r = im.resize((w, h), Image.LANCZOS)
    r.save(os.path.join(OUT, f'app-{name}.webp'), quality=88, method=6)
    r.save(os.path.join(OUT, f'app-{name}.jpg'), quality=88, optimize=True, progressive=True)
    print('app', name, (w, h))
