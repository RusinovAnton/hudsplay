"""Serves the frontend and streams engine state over a WebSocket at cfg.hz."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from aiohttp import web

from .config import ROOT, Config
from .engine import Engine

FRONTEND = ROOT / "frontend"
log = logging.getLogger("racehud")


@web.middleware
async def no_cache(request, handler):
    # frontend is edited live; never let the overlay window run stale JS/CSS
    resp = await handler(request)
    if not resp.prepared:  # websocket responses already sent their headers
        resp.headers["Cache-Control"] = "no-store"
    return resp


def build_app(source, cfg: Config) -> web.Application:
    app = web.Application(middlewares=[no_cache])
    clients: set[web.WebSocketResponse] = set()

    async def index(_req):
        return web.FileResponse(FRONTEND / "index.html")

    async def ws_handler(req):
        ws = web.WebSocketResponse(heartbeat=10)
        await ws.prepare(req)
        clients.add(ws)
        try:
            async for _ in ws:
                pass
        finally:
            clients.discard(ws)
        return ws

    async def pump():
        engine = Engine(cfg)
        period = 1 / cfg.hz
        last_error = 0.0
        while True:
            started = time.perf_counter()
            try:
                frame = source.read()
                state = engine.update(*frame) if frame else {"connected": False}
            except Exception:
                # never die mid-race; log at most once a second
                if time.monotonic() - last_error > 1:
                    log.exception("engine update failed")
                    last_error = time.monotonic()
                state = None
            if state is not None and clients:
                msg = json.dumps(state, separators=(",", ":"))
                await asyncio.gather(*(ws.send_str(msg) for ws in list(clients)), return_exceptions=True)
            await asyncio.sleep(max(0.0, period - (time.perf_counter() - started)))

    async def on_startup(app):
        app["pump"] = asyncio.create_task(pump())

    async def on_cleanup(app):
        app["pump"].cancel()

    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/static", FRONTEND)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app
