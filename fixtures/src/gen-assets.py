# SPDX-License-Identifier: AGPL-3.0-or-later
"""Generate deterministic synthetic image assets for the image fixture (spec §11).

Produces small, fabricated test images exercising each Tier A image path:
JPEG (DCTDecode passthrough), RGB PNG (FlateDecode → PNG re-encode), RGBA PNG
(FlateDecode + /SMask sibling), and a CMYK JPEG (DCTDecode DeviceCMYK). Run once
with the vault venv's Pillow; the outputs are committed fixture inputs.
"""
from pathlib import Path
from PIL import Image

OUT = Path(__file__).parent / "assets"
OUT.mkdir(exist_ok=True)
SIZE = 32


def rgb_pixel(x: int, y: int) -> tuple[int, int, int]:
    return ((x * 8) % 256, (y * 8) % 256, ((x + y) * 4) % 256)


rgb = Image.new("RGB", (SIZE, SIZE))
rgb.putdata([rgb_pixel(i % SIZE, i // SIZE) for i in range(SIZE * SIZE)])
rgb.save(OUT / "test-rgb.png", optimize=False)

rgba = Image.new("RGBA", (SIZE, SIZE))
rgba.putdata(
    [(*rgb_pixel(i % SIZE, i // SIZE), (i * 3) % 256) for i in range(SIZE * SIZE)]
)
rgba.save(OUT / "test-alpha.png", optimize=False)

rgb.save(OUT / "test.jpg", quality=85)

cmyk = rgb.convert("CMYK")
cmyk.save(OUT / "test-cmyk.jpg", quality=85)

print("wrote", *(p.name for p in sorted(OUT.iterdir())))
