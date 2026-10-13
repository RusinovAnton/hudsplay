"""Track map: shape recorded from the player's own driving + per-segment delta paint.

The live SDK has no track coordinates, only lap % per car. So on the first clean
lap at a track we dead-reckon the shape from Speed + YawNorth at 60 Hz, close
the loop, resample by lap % and cache it in maps/<track>.json.
"""

from __future__ import annotations

import json
import logging
import math
import re

from .config import ROOT

MAPS_DIR = ROOT / "maps"
MAP_POINTS = 1000  # resampled shape, evenly spaced in lap %
PAINT_STEP_M = 10.0  # delta paint resolution along the track
log = logging.getLogger("overlay")


class TrackMap:
    def __init__(self):
        self.key: str | None = None
        self.points: list[list[float]] | None = None
        self.version = 0
        self._lap: int | None = None
        self._rec: dict | None = None

    def set_track(self, key: str | None) -> None:
        if key == self.key:
            return
        self.key, self.points, self._rec, self._lap = key, None, None, None
        self.version += 1
        path = self._path()
        if path and path.exists():
            try:
                self.points = json.loads(path.read_text())["points"]
            except (OSError, ValueError, KeyError):
                log.warning("bad map file %s, re-recording", path)

    def _path(self):
        if not self.key:
            return None
        return MAPS_DIR / (re.sub(r"[^A-Za-z0-9_.-]+", "_", self.key) + ".json")

    @property
    def recording_pct(self) -> float | None:
        """Progress of a clean recording lap, None if not recording."""
        rec = self._rec
        if self.points is not None or not rec or not rec["clean"] or not rec["samples"]:
            return None
        return rec["samples"][-1][0]

    def update(self, now: float, pct: float, laps_done: int, speed, yaw, clean: bool) -> None:
        """Feed one player frame. Records the shape until a clean lap completes."""
        if self.points is not None or self.key is None or pct is None or pct < 0:
            return
        rec = self._rec
        if laps_done != self._lap:  # crossed the line
            if rec and rec["clean"] and rec["lap"] == laps_done - 1 and len(rec["samples"]) > 100:
                self._finish(rec["samples"])
                return
            # a lap only counts if we were at the line when it started
            started_at_line = self._lap is not None and pct < 0.05
            self._rec = rec = {"lap": laps_done, "clean": started_at_line, "samples": [], "x": 0.0, "y": 0.0, "t": now}
            self._lap = laps_done
        if rec is None or not rec["clean"]:
            return
        if not clean or speed is None or yaw is None:
            rec["clean"] = False
            return
        dt = now - rec["t"]
        rec["t"] = now
        if dt > 0.5:  # paused / stutter: shape would be wrong
            rec["clean"] = False
            return
        # YawNorth: heading from north, counter-clockwise positive (TODO(windows): verify, see map_mirror)
        rec["x"] += -math.sin(yaw) * speed * dt
        rec["y"] += math.cos(yaw) * speed * dt
        rec["samples"].append((pct, rec["x"], rec["y"]))

    def _finish(self, samples: list[tuple[float, float, float]]) -> None:
        # close the loop: spread the end-vs-start drift linearly over the lap
        n = len(samples)
        ex = samples[-1][1] - samples[0][1]
        ey = samples[-1][2] - samples[0][2]
        fixed = [(p, x - ex * i / (n - 1), y - ey * i / (n - 1)) for i, (p, x, y) in enumerate(samples)]
        fixed.sort()
        # resample evenly by lap %
        points, j = [], 0
        for k in range(MAP_POINTS):
            target = k / MAP_POINTS
            while j < n - 2 and fixed[j + 1][0] < target:
                j += 1
            p0, x0, y0 = fixed[j]
            p1, x1, y1 = fixed[j + 1]
            f = 0.0 if p1 == p0 else min(max((target - p0) / (p1 - p0), 0.0), 1.0)
            points.append([round(x0 + (x1 - x0) * f, 1), round(y0 + (y1 - y0) * f, 1)])
        self.points = points
        self.version += 1
        path = self._path()
        try:
            MAPS_DIR.mkdir(exist_ok=True)
            path.write_text(json.dumps({"key": self.key, "points": points}))
            log.info("track map recorded: %s", path)
        except OSError:
            log.exception("could not save track map")


class DeltaPaint:
    """Per ~10 m of track: [delta at the end of the piece, change of |delta| across it].

    Same semantics as the delta bar: sign of delta picks green/red, growing vs
    shrinking |delta| picks bright vs faded. Current lap + previous lap.
    """

    def __init__(self, track_len_m: float | None = None):
        self.reset(track_len_m)

    def reset(self, track_len_m: float | None = None):
        self.n = max(20, round((track_len_m or 4000.0) / PAINT_STEP_M))
        self.seg_len_m = (track_len_m or 4000.0) / self.n
        self.cur: list[list[float] | None] = [None] * self.n
        self.prev: list[list[float] | None] = [None] * self.n
        self.seg: int | None = None
        self.seg_start: float | None = None
        self.last_delta: float | None = None
        self.lap: int | None = None

    def update(self, pct: float, laps_done: int, delta: float | None) -> None:
        if pct is None or pct < 0:
            return
        seg = min(int(pct * self.n), self.n - 1)
        if seg != self.seg:
            # close the segment with the last delta before this frame (delta resets at the line)
            if (
                self.seg is not None
                and (seg - self.seg) % self.n == 1
                and self.seg_start is not None
                and self.last_delta is not None
            ):
                end = self.last_delta
                self.cur[self.seg] = [round(end, 3), round(abs(end) - abs(self.seg_start), 4)]
            self.seg, self.seg_start = seg, delta
        if laps_done != self.lap:
            if self.lap is not None:
                self.prev, self.cur = self.cur, [None] * self.n
            self.lap = laps_done
        self.last_delta = delta

    def merged(self) -> list[list[float] | None]:
        """This lap where driven, previous lap for the rest."""
        return [c if c is not None else p for c, p in zip(self.cur, self.prev)]
