"""Draws the racehud icon (no image libraries needed) -> electron/assets/icon.ico + icon.png.

Dark rounded square (VS Code Dark+ bg), gold gauge ring open at the bottom right,
needle dot. Rendered per size with 4x4 supersampling so the tray (16 px) stays crisp.

    uv run python packaging/make_icon.py
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "electron" / "assets"
SIZES = (16, 24, 32, 48, 64, 128, 256)
BG = (30, 30, 30)
RING = (255, 215, 0)  # --c-me
DOT = (212, 212, 212)
SS = 4  # supersampling per axis


def _shade(u: float, v: float) -> tuple[tuple[int, int, int], float] | None:
    """Color + alpha at unit coords (0..1, y down), None = transparent."""
    # rounded square
    r = 0.2
    dx = max(abs(u - 0.5) - (0.5 - r), 0)
    dy = max(abs(v - 0.5) - (0.5 - r), 0)
    if dx * dx + dy * dy > r * r:
        return None
    x, y = u - 0.5, 0.5 - v
    d = math.hypot(x, y)
    ang = math.degrees(math.atan2(y, x)) % 360
    # ring, open between -80 and -10 degrees (bottom right)
    if 0.25 <= d <= 0.36 and not 280 <= ang <= 350:
        return RING, 1.0
    # needle dot, up-right
    nx, ny = 0.13 * math.cos(math.radians(35)), 0.13 * math.sin(math.radians(35))
    if math.hypot(x - nx, y - ny) <= 0.075:
        return DOT, 1.0
    return BG, 1.0


def render(size: int) -> bytes:
    rows = []
    for py in range(size):
        row = bytearray([0])  # PNG filter: none
        for px in range(size):
            acc = [0.0, 0.0, 0.0]
            alpha = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    hit = _shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)
                    if hit:
                        (cr, cg, cb), a = hit
                        acc[0] += cr * a
                        acc[1] += cg * a
                        acc[2] += cb * a
                        alpha += a
            n = SS * SS
            if alpha:
                row += bytes([round(acc[0] / alpha), round(acc[1] / alpha), round(acc[2] / alpha), round(255 * alpha / n)])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return _png(size, b"".join(rows))


def _png(size: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def _ico(pngs: dict[int, bytes]) -> bytes:
    head = struct.pack("<HHH", 0, 1, len(pngs))
    entries, blobs = b"", b""
    offset = 6 + 16 * len(pngs)
    for size, data in pngs.items():
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    return head + entries + blobs


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    pngs = {s: render(s) for s in SIZES}
    (OUT / "icon.ico").write_bytes(_ico(pngs))
    (OUT / "icon.png").write_bytes(pngs[256])
    print(f"wrote {OUT / 'icon.ico'} ({', '.join(map(str, SIZES))} px) + icon.png")


if __name__ == "__main__":
    main()
