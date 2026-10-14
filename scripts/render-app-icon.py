#!/usr/bin/env python3
# Render the crewbus app icon as a NON-ROUNDED, full-bleed square.
#
# Why non-rounded: Android (adaptive icons), iOS, Windows and macOS all apply
# their OWN shape mask at the OS level. A corner radius baked into the source
# art gets rounded a SECOND time by that mask -> "double rounding" (clipped
# corners, icon reads too small). This square source lets the OS own rounding.
#
# Geometry mirrors assets/brand/logo.svg (viewBox 30x18, translate(182,314)
# scale(22)) and the canvas generator in assets/brand/"crewbus logo and app
# icon.html". Gradient is the same diagonal #182028 -> #0b0f14.
#
# Android adaptive-icon safe zone: inner 72/108 = 66.67% (x/y 170.7..853.3 on
# a 1024 canvas). The glyph (with stroke) spans x 182..842, y 314..701, so it
# sits inside the safe zone and no launcher mask can clip it.
#
# Requires Pillow + numpy.  Usage:  python scripts/render-app-icon.py
import os
import numpy as np
from PIL import Image, ImageDraw

S = 1024
# Diagonal gradient, userSpaceOnUse (0,0)->(1024,1024): t = (x+y) / (2*S).
c0 = np.array([0x18, 0x20, 0x28], dtype=np.float64)  # #182028
c1 = np.array([0x0b, 0x0f, 0x14], dtype=np.float64)  # #0b0f14
yy, xx = np.mgrid[0:S, 0:S]
t = ((xx + yy) / (2.0 * S))[:, :, None]
arr = (c0 + (c1 - c0) * t).round().astype(np.uint8)
im = Image.fromarray(arr, "RGB").convert("RGBA")
d = ImageDraw.Draw(im)

INK = (0xE3, 0xE9, 0xEE, 255)  # bus outline + wheels  (#e3e9ee)
ACC = (0x4C, 0xC3, 0x8A, 255)  # mid line              (#4cc38a)
W = 44                          # stroke width (2 * scale 22)

# Bus body: rounded rect boundary [204,336,820,600], corner radius 66.
d.rounded_rectangle([204, 336, 820, 600], radius=66, outline=INK, width=W)
# Green mid line, wall to wall: (204,468) -> (820,468).
d.line([204, 468, 820, 468], fill=ACC, width=W)
# Wheels below the body: centers (358,666) and (666,666), r=35.2.
for cx in (358, 666):
    d.ellipse([cx - 35.2, 666 - 35.2, cx + 35.2, 666 + 35.2], fill=INK)

out = os.path.join(os.path.dirname(__file__), "..", "assets", "brand", "crewbus-app-icon-1024.png")
im.save(out, "PNG")
print("wrote", os.path.abspath(out), im.size)
