"""Draws the racehud icon (no image libraries needed) -> electron/assets/icon.ico + icon.png.

"//R" on a dark rounded square (VS Code Dark+): "//" in the comment green of the
`// title` headers, "R" in the gold --c-me. Letters are stroked line segments + an arc,
rendered per size with 4x4 supersampling so the tray (16 px) stays crisp.

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
SLASH = (106, 153, 85)  # --c-comment
LETTER = (255, 215, 0)  # --c-me
SS = 4  # supersampling per axis
STROKE = 0.085  # line width, in icon widths

# glyph strokes in unit coords (x right, y down)
TOP, BOT = 0.27, 0.73
SLASHES = [((0.12, BOT), (0.25, TOP)), ((0.27, BOT), (0.40, TOP))]
R_X, R_MID = 0.53, 0.52  # stem x, where the bowl meets the stem
BOWL_R = (R_MID - TOP) / 2
BOWL_C = (0.68, TOP + BOWL_R)  # bowl: half circle to the right of this centre
R_LINES = [
    ((R_X, TOP), (R_X, BOT)),  # stem
    ((R_X, TOP), (BOWL_C[0], TOP)),  # bowl top
    ((R_X, R_MID), (BOWL_C[0], R_MID)),  # bowl bottom
    ((0.66, R_MID), (0.85, BOT)),  # leg
]


def _seg(px: float, py: float, a: tuple, b: tuple) -> float:
    """Distance from a point to segment ab."""
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _shade(u: float, v: float) -> tuple[tuple[int, int, int], float] | None:
    """Color + alpha at unit coords (0..1, y down), None = transparent."""
    # rounded square
    r = 0.2
    dx = max(abs(u - 0.5) - (0.5 - r), 0)
    dy = max(abs(v - 0.5) - (0.5 - r), 0)
    if dx * dx + dy * dy > r * r:
        return None
    half = STROKE / 2
    if any(_seg(u, v, a, b) <= half for a, b in SLASHES):
        return SLASH, 1.0
    if any(_seg(u, v, a, b) <= half for a, b in R_LINES):
        return LETTER, 1.0
    # bowl arc: right half of a circle
    if u >= BOWL_C[0] and abs(math.hypot(u - BOWL_C[0], v - BOWL_C[1]) - BOWL_R) <= half:
        return LETTER, 1.0
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
