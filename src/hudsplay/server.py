"""Serves the frontend and streams engine state over a WebSocket at cfg.hz."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from aiohttp import web

from .config import ROOT, Config
from .engine import Engine
from .focus import sim_focused
from .trackmap import shareable_maps

FRONTEND = ROOT / "frontend"
FOCUS_POLL_S = 0.25
log = logging.getLogger("hudsplay")


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
        app["engine"].resend_map()  # new window: send the track shape on the next frame
        try:
            async for _ in ws:
                pass
        finally:
            clients.discard(ws)
        return ws

    app["engine"] = Engine(cfg)

    async def pump():
        engine = app["engine"]
        period = 1 / cfg.hz
        last_error = 0.0
        # foreground window check (OS call): a few times a second is plenty
        check_focus = getattr(source, "focus_check", True)
        focused, focus_at = None, 0.0
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
            if state is not None and check_focus:
                if started - focus_at >= FOCUS_POLL_S:
                    focused, focus_at = sim_focused(), started
                state["simFocused"] = focused
            if state is not None and clients:
                msg = json.dumps(state, separators=(",", ":"))
                await asyncio.gather(*(ws.send_str(msg) for ws in list(clients)), return_exceptions=True)
            await asyncio.sleep(max(0.0, period - (time.perf_counter() - started)))

    async def on_startup(app):
        app["pump"] = asyncio.create_task(pump())

    async def on_cleanup(app):
        app["pump"].cancel()

    # track map management, used by the tray menu (electron/main.js)
    async def map_info(_req):
        return web.json_response(app["engine"].map.info())

    async def map_rerecord(_req):
        ok = app["engine"].map.request_rerecord()
        return web.json_response({"ok": ok, **app["engine"].map.info()})

    async def maps_share(_req):
        return web.json_response(shareable_maps())

    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/map", map_info)
    app.router.add_post("/api/map/rerecord", map_rerecord)
    app.router.add_post("/api/maps/share", maps_share)
    app.router.add_static("/static", FRONTEND)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app
