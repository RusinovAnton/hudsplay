"""Overlay settings. Override any field in config.toml (repo root) under [overlay]."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, fields
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Config:
    host: str = "127.0.0.1"
    port: int = 8765
    hz: int = 60

    # standings: rows shown on each side of the player
    standings_each_side: int = 2
    # only show cars from the player's class (multiclass races)
    standings_class_only: bool = True
    # "short" -> "M. Lastname", "full" -> as in iRacing
    name_format: str = "short"

    # radar gets cars within this many metres ahead/behind; view range and
    # show-within distance are set per widget in edit mode (up to this value)
    radar_range_m: float = 50.0

    # reference for the delta bar and the map paint:
    # session_best | best | optimal | session_optimal | session_last
    delta_reference: str = "session_best"
    # flip the recorded track map horizontally (if it comes out mirrored)
    map_mirror: bool = False


def load_config(path: Path = ROOT / "config.toml") -> Config:
    cfg = Config()
    if path.exists():
        data = tomllib.loads(path.read_text()).get("overlay", {})
        known = {f.name for f in fields(Config)}
        for key, value in data.items():
            if key in known:
                setattr(cfg, key, value)
    return cfg
