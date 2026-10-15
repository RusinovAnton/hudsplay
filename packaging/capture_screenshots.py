"""README screenshot + social card from the mock race, via headless Chrome/Edge (CDP).

    uv run python packaging/capture_screenshots.py [--warmup 210]

Starts `hudsplay --mock` on a spare port, lets the fake race run (fuel per lap and the
optimal lap need a few laps), pins the radar + incident alert to a representative
moment, then writes:
    docs/screenshot.png   whole overlay, 1920x1080 (README)
    docs/img/og.png       1200x630 social card (packaging/og-card.html, uses the above)
and refreshes the website's live widgets (packaging/build_site.py). The website shows
live widgets, not screenshots. Only redo the social card: --og-only.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import aiohttp
from build_site import build as build_site

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "docs" / "img"
PORT, CDP_PORT = 8768, 9335
W, H = 1920, 1080
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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


async def capture(warmup: int, og_only: bool = False) -> None:
    async with aiohttp.ClientSession() as s:
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
    build_site()


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
    await p.shot(ROOT / "docs" / "screenshot.png", fmt="png")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--warmup", type=int, default=210, help="seconds of mock race before capturing")
    ap.add_argument("--og-only", action="store_true", help="only redo the 1200x630 social card")
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
        asyncio.run(capture(args.warmup, args.og_only))
    finally:
        chrome.terminate()
        backend.terminate()
        chrome.wait(10)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    main()
