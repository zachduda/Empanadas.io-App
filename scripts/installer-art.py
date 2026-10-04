#!/usr/bin/env python3
"""Draws the installer artwork in build/.

    python3 scripts/installer-art.py            (needs Pillow: pip install pillow)

The images are committed, so a build never runs this; it is here so the art
can be changed by editing a colour or a coordinate rather than by hand. Run it
again after changing Content/Images/logo.png or the palette below, and commit
what it writes:

  build/installerSidebar.bmp   Windows wizard, Welcome and Finish pages (164x314)
  build/installerHeader.bmp    Windows wizard, the strip above the other pages (150x57)
  build/background.png         macOS .dmg window (540x380)
  build/background@2x.png      the same for Retina screens; electron-builder
                               merges the pair into one .tiff when it builds

The .dmg icon positions in package.json (build.dmg.contents) are the centres
of the two slots drawn here - change one, change the other.

Everything is drawn at several times the final size and scaled down, which is
the anti-aliasing. The Windows bitmaps are 24-bit BMP with no alpha channel:
NSIS shows nothing else.
"""

import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
BUILD = os.path.join(ROOT, 'build')
LOGO = os.path.join(ROOT, 'Content', 'Images', 'logo.png')
FONT = os.path.join(ROOT, 'Poppins.ttf')  # Poppins Bold, as on the splash

# The splash's palette (Content/CSS/splash.css), so the installer, the splash
# and the site read as one thing.
BG = (0x1e, 0x1e, 0x91)
BG_LIT = (0x2c, 0x2c, 0xb4)
BG_DEEP = (0x14, 0x14, 0x6a)
INK = (0xff, 0xff, 0xff)
MUTED = (0xab, 0xbe, 0xfc)
GOLD = (0xff, 0xc8, 0x3d)

# Behind the .dmg icons. Finder draws icon labels black in Light Mode and
# white in Dark Mode, and nothing in a .dmg can change that. On the splash
# blue a black label is unreadable (1.6:1), so the icons sit on this: the
# website banner's blue, lightened until black and white text both clear
# 4.5:1 on it.
CARD = (0x4f, 0x69, 0xec)

SCALE = 4


def font(px):
	return ImageFont.truetype(FONT, round(px * SCALE))


def mix(a, b, t):
	return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vertical_gradient(size, stops):
	"""stops: [(position 0..1, colour), ...]"""
	w, h = size
	strip = Image.new('RGB', (1, h))
	for y in range(h):
		p = y / max(1, h - 1)
		for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
			if p0 <= p <= p1:
				strip.putpixel((0, y), mix(c0, c1, (p - p0) / ((p1 - p0) or 1)))
				break
	return strip.resize((w, h))


def radial(size, centre, radius, inner, outer):
	"""The splash's radial-gradient(circle at ..., inner 0, outer 62%)."""
	w, h = size
	small = (max(1, w // 8), max(1, h // 8))
	img = Image.new('RGB', small)
	cx, cy, r = centre[0] / 8, centre[1] / 8, radius / 8
	for y in range(small[1]):
		for x in range(small[0]):
			d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / r
			img.putpixel((x, y), mix(inner, outer, min(1.0, d)))
	return img.resize(size, Image.BICUBIC)


def glow(canvas, centre, radius, alpha):
	"""A soft white light, like the splash's .glow behind the logo."""
	layer = Image.new('L', canvas.size, 0)
	ImageDraw.Draw(layer).ellipse(
		[centre[0] - radius, centre[1] - radius, centre[0] + radius, centre[1] + radius],
		fill=alpha)
	layer = layer.filter(ImageFilter.GaussianBlur(radius / 2.2))
	canvas.paste(Image.new('RGB', canvas.size, INK), (0, 0), layer)


def paste_logo(canvas, width, centre):
	logo = Image.open(LOGO).convert('RGBA')
	height = round(logo.height * width / logo.width)
	logo = logo.resize((width, height), Image.LANCZOS)
	# A soft shadow, so the pastry sits on the blue rather than floating.
	shadow = Image.new('RGBA', logo.size, (0, 0, 0, 0))
	shadow.putalpha(logo.getchannel('A').point(lambda a: a * 0.35))
	shadow = shadow.filter(ImageFilter.GaussianBlur(width / 30))
	x, y = round(centre[0] - width / 2), round(centre[1] - height / 2)
	canvas.paste(shadow, (x, y + round(width / 28)), shadow)
	canvas.paste(logo, (x, y), logo)


def text(draw, xy, s, px, fill, anchor='mm'):
	draw.text(xy, s, font=font(px), fill=fill, anchor=anchor)


def finish(img, size, path):
	img = img.resize(size, Image.LANCZOS).convert('RGB')
	if path.endswith('.bmp'):
		img.save(path, 'BMP')
	else:
		img.save(path, 'PNG', optimize=True)
	print('wrote', os.path.relpath(path, ROOT), '%dx%d' % size)


# --- Windows: wizard sidebar (Welcome and Finish pages) -----------------------

def sidebar(path):
	size = (164, 314)
	S = SCALE
	w, h = size[0] * S, size[1] * S
	img = vertical_gradient((w, h), [(0, BG_LIT), (0.55, BG), (1, BG_DEEP)])
	glow(img, (w // 2, 104 * S), 64 * S, 70)
	paste_logo(img, 122 * S, (w // 2, 104 * S))
	d = ImageDraw.Draw(img)
	text(d, (w // 2, 190 * S), 'Empanadas.io', 19, INK)
	d.rounded_rectangle([w // 2 - 14 * S, 207 * S, w // 2 + 14 * S, 210 * S], radius=2 * S, fill=GOLD)
	text(d, (w // 2, 228 * S), 'The treat that', 11, MUTED)
	text(d, (w // 2, 244 * S), "can't be beat.", 11, MUTED)
	finish(img, size, path)


# --- Windows: header strip (every other page) ---------------------------------
# Sits at the right of a white header, beside the page title.

def header(path):
	size = (150, 57)
	S = SCALE
	w, h = size[0] * S, size[1] * S
	img = Image.new('RGB', (w, h), INK)
	paste_logo(img, 42 * S, (124 * S, h // 2))
	d = ImageDraw.Draw(img)
	text(d, (99 * S, h // 2 + 1 * S), 'Empanadas.io', 13, BG, anchor='rm')
	finish(img, size, path)


# --- macOS: .dmg window -------------------------------------------------------

# Icon centres in points; package.json's build.dmg.contents must match.
DMG_APP = (140, 200)
DMG_APPLICATIONS = (400, 200)


def dmg(path, retina):
	size = (540, 380)
	S = SCALE * (2 if retina else 1)
	unit = 2 if retina else 1  # pixels per point in the output
	w, h = size[0] * S, size[1] * S
	img = radial((w, h), (w // 2, round(h * 0.4)), round(w * 0.62), BG_LIT, BG)
	d = ImageDraw.Draw(img)

	# Title: the logo and the name, as on the splash.
	paste_logo(img, 52 * S, (178 * S, 52 * S))
	text(d, (212 * S, 54 * S), 'Empanadas.io', 26, INK, anchor='lm')

	# The slot the two icons and their labels sit in.
	d.rounded_rectangle([40 * S, 106 * S, 500 * S, 300 * S], radius=26 * S,
		fill=CARD, outline=mix(CARD, INK, 0.22), width=max(1, S // 2))

	# Drag this way.
	y = DMG_APP[1] * S
	x0, x1 = (DMG_APP[0] + 74) * S, (DMG_APPLICATIONS[0] - 74) * S
	dash, gap, thick = 11 * S, 8 * S, 5 * S
	x = x0
	while x < x1 - 22 * S:
		end = min(x + dash, x1 - 22 * S)
		d.rounded_rectangle([x, y - thick // 2, end, y + thick // 2], radius=thick // 2, fill=GOLD)
		x = end + gap
	d.polygon([(x1, y), (x1 - 22 * S, y - 15 * S), (x1 - 22 * S, y + 15 * S)], fill=GOLD)

	text(d, (w // 2, 338 * S), 'Drag Empanadas.io into Applications to install', 15, MUTED)
	finish(img, (size[0] * unit, size[1] * unit), path)


if __name__ == '__main__':
	os.makedirs(BUILD, exist_ok=True)
	sidebar(os.path.join(BUILD, 'installerSidebar.bmp'))
	header(os.path.join(BUILD, 'installerHeader.bmp'))
	dmg(os.path.join(BUILD, 'background.png'), retina=False)
	dmg(os.path.join(BUILD, 'background@2x.png'), retina=True)
