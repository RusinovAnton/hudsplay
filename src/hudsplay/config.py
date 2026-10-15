"""hudsplay settings. Override any field in config.toml under [hudsplay]
(repo root in dev, %APPDATA%/HUDsplay/data when installed)."""

from __future__ import annotations

import os
import sys
import tomllib
from dataclasses import dataclass, fields
from pathlib import Path

# installed build = PyInstaller exe: app files are unpacked read-only next to it,
# user files (config, recorded maps, log) live in %APPDATA%\HUDsplay\data
# (%APPDATA%\HUDsplay itself is the overlay window's Electron profile: layout, colors)
FROZEN = getattr(sys, "frozen", False)
ROOT = Path(sys._MEIPASS) if FROZEN else Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("APPDATA", Path.home())) / "HUDsplay" / "data" if FROZEN else ROOT


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8765
    hz: int = 60

    # standings: rows shown on each side of the player
    standings_each_side: int = 3
    # only show cars from the player's class (multiclass races)
    standings_class_only: bool = True
    # "short" -> "M. Lastname", "full" -> as in iRacing
    name_format: str = "short"

    # radar gets cars within this many metres ahead/behind; view range and
    # show-within distance are set per widget in edit mode (up to this value)
    radar_range_m: float = 50.0

    # reference for the delta bar / the map paint:
    # session_best | best | optimal | session_optimal | session_last
    delta_reference: str = "session_best"
    map_paint_reference: str = "session_last"
    # flip the recorded track map horizontally (if it comes out mirrored)
    map_mirror: bool = False


def load_config(path: Path = DATA / "config.toml") -> Config:
    cfg = Config()
    if path.exists():
        data = tomllib.loads(path.read_text()).get("hudsplay", {})
        known = {f.name for f in fields(Config)}
        for key, value in data.items():
            if key in known:
                setattr(cfg, key, value)
    return cfg
