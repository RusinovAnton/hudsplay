from __future__ import annotations

import argparse
import logging
import sys

from aiohttp import web

from .config import DATA, FROZEN, load_config
from .server import build_app


def main() -> None:
    parser = argparse.ArgumentParser(prog="hudsplay")
    parser.add_argument("--mock", action="store_true", help="fake race data, no iRacing needed")
    parser.add_argument("--dump", action="store_true", help="dump iRacing session info + telemetry to ./dump")
    parser.add_argument("--port", type=int, help="override config port")
    args = parser.parse_args()
    fmt = "%(asctime)s %(levelname)s %(message)s"
    if FROZEN:  # no console in the installed build: log to %APPDATA%\HUDsplay\data\hudsplay.log
        DATA.mkdir(parents=True, exist_ok=True)
        logging.basicConfig(level=logging.INFO, format=fmt, filename=DATA / "hudsplay.log", filemode="w")
    else:
        logging.basicConfig(level=logging.INFO, format=fmt)

    if args.dump:
        from .sources.iracing import dump

        dump()
        return

    cfg = load_config()
    if args.port:
        cfg.port = args.port

    if sys.platform == "win32":
        # default Windows timer tick is ~15.6 ms, which caps asyncio.sleep at ~30 Hz
        import ctypes

        ctypes.windll.winmm.timeBeginPeriod(1)

    if args.mock:
        from .sources.mock import MockSource

        source = MockSource()
    else:
        from .sources.iracing import IRacingSource

        source = IRacingSource()

    print(f"hudsplay: http://{cfg.host}:{cfg.port}/  ({'mock' if args.mock else 'iRacing'})")
    web.run_app(build_app(source, cfg), host=cfg.host, port=cfg.port, print=None)


if __name__ == "__main__":
    main()
