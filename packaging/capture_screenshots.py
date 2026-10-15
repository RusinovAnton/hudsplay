"""Screenshots for the website (docs/) from the mock race, via headless Chrome/Edge (CDP).

    uv run python packaging/capture_screenshots.py [--warmup 210]

Starts `hudsplay --mock` on a spare port, lets the fake race run (fuel per lap and the
optimal lap need a few laps), pins the radar + incident alert to a representative
moment, then writes:
    docs/img/hero.webp, docs/screenshot.png   whole overlay, 1920x1080
    docs/img/edit-mode.webp                   edit mode with the panel open
    docs/img/w-<widget>.webp                  each widget, 2x
    docs/img/og.png                           1200x630 social card (packaging/og-card.html)
    docs/demo/                                live demo: the real frontend replaying a
                                              recorded mock race (frames.json + replay.js)
Only redo the social card: --og-only. Only redo the demo: --demo-only.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp
from demo_diff import encode as encode_frames

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "docs" / "img"
PORT, CDP_PORT = 8768, 9335
W, H = 1920, 1080
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]
WIDGETS = [
    "session", "clock", "relative", "fuel", "laps", "incidents", "incident-alert",
    "delta-best", "delta-ahead", "delta-behind", "map", "radar",
]
# a moment worth showing: car alongside on the left, one close behind, a 4x contact alert
PIN = """
window.__pinRadar = {range: 50, carLen: 4.8, spotter: 'left',
  cars: [{id: 901, d: -1.2, side: 'L'}, {id: 902, d: -9.5, side: 'C'}, {id: 903, d: 14, side: 'C'}]};
const _radar = renderRadar; window.renderRadar = () => _radar(window.__pinRadar);
const _inc = renderIncidents;
window.renderIncidents = (i) => _inc({...i, alert: {label: 'contact', x: 4}});
"""


class Page:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    async def cmd(self, method, **params):
        self.n += 1
        await self.ws.send_json({"id": self.n, "method": method, "params": params})
        while True:
            msg = json.loads((await self.ws.receive()).data)
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    async def js(self, expr):
        r = await self.cmd("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r["result"].get("value")

    async def shot(self, path: Path, clip=None, fmt="webp"):
        params = {"format": fmt, "captureBeyondViewport": False}
        if fmt == "webp":
            params["quality"] = 92
        if clip:
            params["clip"] = {**clip, "scale": 1}
        data = (await self.cmd("Page.captureScreenshot", **params))["data"]
        path.write_bytes(base64.b64decode(data))
        print(f"  {path.relative_to(ROOT)}")

    async def viewport(self, dpr):
        await self.cmd("Emulation.setDeviceMetricsOverride", width=W, height=H, deviceScaleFactor=dpr, mobile=False)


async def capture(warmup: int, og_only: bool = False, demo_only: bool = False) -> None:
    async with aiohttp.ClientSession() as s:
        if demo_only:
            print(f"warming up the mock race for {warmup} s ...")
            await asyncio.sleep(warmup)
            await record_demo(s)
            return
        for _ in range(50):  # browser up?
            try:
                targets = await (await s.get(f"http://127.0.0.1:{CDP_PORT}/json")).json()
                break
            except aiohttp.ClientError:
                await asyncio.sleep(0.2)
        target = next(t for t in targets if t["type"] == "page")
        async with s.ws_connect(target["webSocketDebuggerUrl"], max_msg_size=0) as ws:
            p = Page(ws)
            if not og_only:
                await capture_overlay(p, warmup)
            await capture_og(p)
        if not og_only:
            await record_demo(s)
    stamp_sizes()


DEMO = ROOT / "docs" / "demo"
DEMO_SECONDS, DEMO_HZ = 90, 30


async def record_demo(s: aiohttp.ClientSession) -> None:
    """Record the mock race for the website's live demo and copy in the real frontend."""
    print(f"recording {DEMO_SECONDS} s of demo at {DEMO_HZ} Hz ...")
    frames, last_map, next_at = [], None, 0.0
    async with s.ws_connect(f"http://127.0.0.1:{PORT}/ws", max_msg_size=0) as ws:
        t0 = time.monotonic()
        async for msg in ws:
            now = time.monotonic() - t0
            if now >= DEMO_SECONDS:
                break
            if now < next_at:
                continue
            next_at += 1 / DEMO_HZ
            f = json.loads(msg.data)
            m = f.get("map") or {}
            # the track shape is big: keep it only where it changes (first frame)
            if "points" in m:
                if m.get("version") == last_map:
                    del m["points"]
                last_map = m.get("version")
            frames.append(f)
    DEMO.mkdir(parents=True, exist_ok=True)
    # each frame stored as its change from the previous one (~10x smaller), see demo_diff.py
    data = json.dumps({"hz": DEMO_HZ, "frames": encode_frames(frames)}, separators=(",", ":"))
    (DEMO / "frames.json").write_text(data, encoding="utf-8")
    print(f"  docs/demo/frames.json ({len(frames)} frames, {len(data) // 1024} KB)")

    static = DEMO / "static"
    static.mkdir(exist_ok=True)
    for name in ("app.js", "style.css", "theme.css"):
        shutil.copy(ROOT / "frontend" / name, static / name)
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/static/', 'href="static/').replace(
        '<script src="/static/app.js"></script>',
        '<script src="replay.js"></script>\n  <script src="static/app.js"></script>')
    html = html.replace("<title>HUDsplay</title>", '<title>HUDsplay live demo</title>\n  <meta name="robots" content="noindex">')
    (DEMO / "index.html").write_text(html, encoding="utf-8", newline="")
    print("  docs/demo/index.html + static/ (copied from frontend/)")


async def capture_og(p: Page) -> None:
    await p.cmd("Emulation.setDeviceMetricsOverride", width=1200, height=630, deviceScaleFactor=1, mobile=False)
    await p.cmd("Page.navigate", url=(ROOT / "packaging" / "og-card.html").as_uri())
    await asyncio.sleep(3)  # web font + image
    await p.shot(IMG / "og.png", fmt="png")


async def capture_overlay(p: Page, warmup: int) -> None:
    await p.viewport(1)
    await p.cmd("Page.navigate", url=f"http://127.0.0.1:{PORT}/")
    print(f"warming up the mock race for {warmup} s ...")
    await asyncio.sleep(warmup)
    await p.js(PIN)
    await p.js("document.querySelectorAll('.widget').forEach(w => w.style.transition = 'none')")
    await asyncio.sleep(1.5)

    IMG.mkdir(parents=True, exist_ok=True)
    await p.shot(IMG / "hero.webp")
    await p.shot(ROOT / "docs" / "screenshot.png", fmt="png")

    await p.viewport(2)
    await asyncio.sleep(0.5)
    for wid in WIDGETS:
        if wid == "map":  # tall tracks (Monza) are small in the 4:3 box: show it bigger
            await p.js("Object.assign(document.getElementById('w-map').style, "
                       "{fontSize: 'calc(13px * 1.6)', left: '62%'})")
            await asyncio.sleep(0.5)
        r = await p.js(f"(() => {{ const b = document.querySelector('[data-id=\"{wid}\"]').getBoundingClientRect();"
                       " return {x: b.x, y: b.y, width: b.width, height: b.height}; })()")
        pad = 10
        clip = {"x": max(0, r["x"] - pad), "y": max(0, r["y"] - pad),
                "width": r["width"] + 2 * pad, "height": r["height"] + 2 * pad}
        await p.shot(IMG / f"w-{wid}.webp", clip)
        if wid == "map":
            await p.js("applyLayout()")  # back to normal size/position

    await p.viewport(1)
    await p.js("setEditMode(true); selectWidget(document.getElementById('w-radar'));"
               "document.querySelectorAll('#edit-panel details').forEach(d => d.open = d.id === 'sec-selected')")
    await asyncio.sleep(0.8)
    await p.shot(IMG / "edit-mode.webp")


def webp_size(path: Path) -> tuple[int, int]:
    """Pixel size from a WebP header (VP8 / VP8L / VP8X)."""
    b = path.read_bytes()[:30]
    kind = b[12:16]
    if kind == b"VP8X":
        return 1 + int.from_bytes(b[24:27], "little"), 1 + int.from_bytes(b[27:30], "little")
    if kind == b"VP8L":
        bits = int.from_bytes(b[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    w, h = struct.unpack("<HH", b[26:30])  # VP8 (lossy)
    return w & 0x3FFF, h & 0x3FFF


def stamp_sizes() -> None:
    """Write each screenshot's display size into docs/index.html <img> tags: widget crops are
    2x, so they show at half their pixels (all widgets at the same scale, no layout shift)."""
    page = ROOT / "docs" / "index.html"
    html = page.read_text(encoding="utf-8")

    def fix(m: re.Match) -> str:
        tag, src = m.group(0), m.group(1)
        f = ROOT / "docs" / src
        if not f.exists() or f.suffix != ".webp":
            return tag
        w, h = webp_size(f)
        if Path(src).name.startswith("w-"):
            w, h = w // 2, h // 2
        tag = re.sub(r'\s(width|height)="\d+"', "", tag)
        return tag.replace(f'src="{src}"', f'src="{src}" width="{w}" height="{h}"')

    page.write_text(re.sub(r'<img src="(img/[^"]+)"[^>]*>', fix, html), encoding="utf-8", newline="")
    print("  docs/index.html image sizes")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=210, help="seconds of mock race before capturing")
    ap.add_argument("--og-only", action="store_true", help="only redo the 1200x630 social card")
    ap.add_argument("--demo-only", action="store_true", help="only re-record the website live demo")
    args = ap.parse_args()
    browser = next((b for b in BROWSERS if Path(b).exists()), None) or shutil.which("chrome")
    if not browser:
        raise SystemExit("Chrome or Edge not found")
    profile = tempfile.mkdtemp(prefix="hudsplay-capture-")
    backend = subprocess.Popen([sys.executable, "-m", "hudsplay", "--mock", "--port", str(PORT)], cwd=ROOT)
    chrome = subprocess.Popen([browser, "--headless=new", f"--remote-debugging-port={CDP_PORT}",
                               f"--user-data-dir={profile}", f"--window-size={W},{H}", "--hide-scrollbars",
                               "about:blank"])
    try:
        time.sleep(2)
        asyncio.run(capture(args.warmup, args.og_only, args.demo_only))
    finally:
        chrome.terminate()
        backend.terminate()
        chrome.wait(10)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
