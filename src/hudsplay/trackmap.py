"""Track map: shape recorded from the player's own driving + per-segment delta paint.

The live SDK has no track coordinates, only lap % per car. So on a clean lap we
dead-reckon the shape from Speed + YawNorth at 60 Hz, close the loop and resample
by lap %.

Where maps live:
  user maps     DATA/maps/<key>.json   recorded on this PC, always win
  bundled maps  ROOT/maps/<key>.json   shipped with the app (contributed via PR)
Next to a user map: <key>.prev.json (the map it replaced), <key>.candidate.json
(a background lap that disagreed, waiting for a second one) and <key>.rerecord
(the user said the map is wrong).

Lifecycle per track, once per app run:
  no map     record the first clean lap
  map ok     re-record the first clean laps under the hood and compare: when two
             laps agree with each other but not with the map (iRacing changed the
             track, or the map was bad), they replace it
  rerecord   (user asked, or the map has a small loop = a spin got recorded) the
             next clean lap replaces it; if it comes out the same, status
             "unchanged" lets the tray offer a GitHub issue
"""

from __future__ import annotations

import json
import logging
import math
import re
import shutil
import time

from .config import DATA, ROOT

MAPS_DIR = DATA / "maps"
BUNDLED_MAPS_DIR = ROOT / "maps"
SHARE_DIR = DATA / "maps-to-share"
MAP_POINTS = 1000  # resampled shape, evenly spaced in lap %
PAINT_STEP_M = 10.0  # delta paint resolution along the track
SPIN_YAW_RATE = 2.5  # rad/s: turning faster than this is a spin, not a corner
LOOP_SPAN = 0.05  # the line crossing itself within this much lap = a recorded spin
SAME_SHAPE = 0.03  # shapes differ when a point is off by more than this x track size
VERIFY_LAPS = 3  # background re-recordings per app run
log = logging.getLogger("hudsplay")


def _cross(a, b, c, d) -> bool:
    def o(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0


def has_loop(points: list) -> bool:
    """A small loop: the line crosses itself within LOOP_SPAN of lap. Real crossovers
    (Suzuka) are about half a lap apart."""
    n = len(points)
    span = max(2, int(n * LOOP_SPAN))
    for i in range(n):
        a, b = points[i], points[(i + 1) % n]
        for k in range(2, span + 1):
            j = (i + k) % n
            if _cross(a, b, points[j], points[(j + 1) % n]):
                return True
    return False


def same_shape(a: list | None, b: list | None) -> bool:
    """Same track within dead-reckoning noise (racing line, drift): both centred,
    no point further apart than SAME_SHAPE x the track's size."""
    if not a or not b or len(a) != len(b):
        return False

    def centred(pts):
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        return [(x - cx, y - cy) for x, y in pts]

    ca, cb = centred(a), centred(b)
    xs, ys = [p[0] for p in ca], [p[1] for p in ca]
    size = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) or 1.0
    worst = max(math.hypot(p[0] - q[0], p[1] - q[1]) for p, q in zip(ca, cb))
    return worst <= SAME_SHAPE * size


def _file_name(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key)


def _read_points(path) -> list | None:
    try:
        return json.loads(path.read_text())["points"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _is_map_file(path) -> bool:
    return not path.name.endswith((".prev.json", ".candidate.json"))


def shareable_maps() -> dict:
    """Copy user maps the app doesn't ship (or ships different) into SHARE_DIR, ready
    to drop on GitHub's upload page (which turns them into a pull request)."""
    SHARE_DIR.mkdir(parents=True, exist_ok=True)
    for old in SHARE_DIR.glob("*.json"):
        old.unlink()
    files = []
    if MAPS_DIR.resolve() != BUNDLED_MAPS_DIR.resolve():  # dev: maps/ is the repo's folder
        for path in sorted(MAPS_DIR.glob("*.json")):
            points = _read_points(path)
            if not _is_map_file(path) or not points or has_loop(points):
                continue
            if not same_shape(points, _read_points(BUNDLED_MAPS_DIR / path.name)):
                shutil.copy2(path, SHARE_DIR / path.name)
                files.append(path.name)
    return {"dir": str(SHARE_DIR), "files": files}


class TrackMap:
    def __init__(self):
        self.key: str | None = None
        self.track = ""
        self.points: list[list[float]] | None = None
        self.source: str | None = None  # "user" | "bundled"
        self.mode = "idle"  # record | rerecord | verify | idle
        # none | recording | rerecording | checking | ok | updated | unchanged
        self.status = "none"
        self.version = 0
        self._verify_left = 0
        self._lap: int | None = None
        self._rec: dict | None = None

    def set_track(self, key: str | None, track: str = "") -> None:
        if key == self.key:
            return
        self.key, self.track, self.points, self.source = key, track, None, None
        self._rec, self._lap = None, None
        self.version += 1
        if key is None:
            self.mode, self.status = "idle", "none"
            return
        for source, path in (("user", self._path()), ("bundled", BUNDLED_MAPS_DIR / self._path().name)):
            if not path.exists():
                continue
            points = _read_points(path)
            if points:
                self.points, self.source = points, source
                break
            log.warning("bad map file %s, re-recording", path)
        if self.points is None:
            self.mode, self.status = "record", "recording"
        elif self._marker().exists() or has_loop(self.points):
            if not self._marker().exists():
                log.warning("track map %s has a loop (spin recorded?), re-recording", key)
            self.mode, self.status = "rerecord", "rerecording"
        else:
            self.mode, self.status = "verify", "checking"
            self._verify_left = VERIFY_LAPS

    def request_rerecord(self) -> bool:
        """User says the current map is wrong: record the next clean lap, keep showing
        the old map until then. Remembered across restarts."""
        if self.key is None or self.points is None:
            return False
        try:
            MAPS_DIR.mkdir(parents=True, exist_ok=True)
            self._marker().write_text("")
        except OSError:
            log.exception("could not save re-record request")
        self.mode, self.status = "rerecord", "rerecording"
        self._rec, self._lap = None, None
        return True

    def info(self) -> dict:
        path = self._path()
        return {
            "key": self.key,
            "track": self.track,
            "hasMap": self.points is not None,
            "source": self.source,
            "status": self.status,
            "file": str(path) if path and path.exists() else None,
            "mapsDir": str(MAPS_DIR),
        }

    def _path(self):
        return MAPS_DIR / (_file_name(self.key) + ".json") if self.key else None

    def _side(self, suffix: str):
        return MAPS_DIR / (_file_name(self.key) + suffix)

    def _marker(self):
        return self._side(".rerecord")

    @property
    def recording_pct(self) -> float | None:
        """Progress of a clean lap the user is waiting for, None otherwise
        (background checks stay silent)."""
        rec = self._rec
        if self.mode not in ("record", "rerecord") or not rec or not rec["clean"] or not rec["samples"]:
            return None
        return rec["samples"][-1][0]

    def update(self, now: float, pct: float, laps_done: int, speed, yaw, clean: bool) -> None:
        """Feed one player frame. Records the shape while a recording or check runs."""
        if self.mode == "idle" or self.key is None or pct is None or pct < 0:
            return
        rec = self._rec
        if laps_done != self._lap:  # crossed the line
            if rec and rec["clean"] and rec["lap"] == laps_done - 1 and len(rec["samples"]) > 100:
                self._lap_done(self._finish(rec["samples"]))
                if self.mode == "idle":
                    return
            # a lap only counts if we were at the line when it started
            started_at_line = self._lap is not None and pct < 0.05
            self._rec = rec = {
                "lap": laps_done, "clean": started_at_line, "samples": [],
                "x": 0.0, "y": 0.0, "t": now, "yaw": None,
            }
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
        if rec["yaw"] is not None and dt > 0:
            turn = (yaw - rec["yaw"] + math.pi) % (2 * math.pi) - math.pi
            if abs(turn) / dt > SPIN_YAW_RATE:  # a spin, even one without an incident
                rec["clean"] = False
                return
        rec["yaw"] = yaw
        # YawNorth: compass heading, clockwise positive (verified on Navarra: ccw drew it mirrored)
        rec["x"] += math.sin(yaw) * speed * dt
        rec["y"] += math.cos(yaw) * speed * dt
        rec["samples"].append((pct, rec["x"], rec["y"]))

    def _finish(self, samples: list[tuple[float, float, float]]) -> list[list[float]]:
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
        return points

    def _lap_done(self, points: list[list[float]]) -> None:
        """A clean lap was recorded: decide what it means for the map."""
        if has_loop(points):
            log.info("recorded lap for %s has a loop, ignored", self.key)
            return
        old = self.points
        if self.mode == "record":
            self._save(points, "updated")
        elif self.mode == "rerecord":
            self._marker().unlink(missing_ok=True)
            if old is not None and not has_loop(old) and same_shape(points, old):
                log.info("re-recorded %s matches the old map", self.key)
                self.mode, self.status = "idle", "unchanged"
            else:
                self._save(points, "updated")
        elif self.mode == "verify":
            pending = self._side(".candidate.json")
            if same_shape(points, old):
                pending.unlink(missing_ok=True)
                self.mode, self.status = "idle", "ok"
                return
            earlier = _read_points(pending) if pending.exists() else None
            if earlier and same_shape(points, earlier):
                log.info("two laps agree %s changed, updating the map", self.key)
                pending.unlink(missing_ok=True)
                self._save(points, "updated")
                return
            # one lap disagrees: remember it, a second matching lap (now or next run) confirms
            try:
                MAPS_DIR.mkdir(parents=True, exist_ok=True)
                pending.write_text(json.dumps({"key": self.key, "points": points}))
            except OSError:
                log.exception("could not save map candidate")
            self._verify_left -= 1
            if self._verify_left <= 0:
                self.mode, self.status = "idle", "ok"

    def _save(self, points: list[list[float]], status: str) -> None:
        path = self._path()
        try:
            MAPS_DIR.mkdir(parents=True, exist_ok=True)
            if path.exists():
                shutil.copy2(path, self._side(".prev.json"))  # keep the map we replace
            path.write_text(json.dumps({
                "key": self.key,
                "track": self.track,
                "recorded": time.strftime("%Y-%m-%d"),
                "points": points,
            }))
            log.info("track map saved: %s", path)
        except OSError:
            log.exception("could not save track map")
        self.points, self.source = points, "user"
        self.mode, self.status = "idle", status
        self.version += 1


class DeltaPaint:
    """Per ~10 m of track: [delta at the end of the piece, change of delta across it].

    Same semantics as the delta bar: the change picks green (time gained, < 0) or red
    (time lost), its size per metre the intensity. Current lap + previous lap.
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
                self.cur[self.seg] = [round(end, 3), round(end - self.seg_start, 4)]
            self.seg, self.seg_start = seg, delta
        if laps_done != self.lap:
            if self.lap is not None:
                self.prev, self.cur = self.cur, [None] * self.n
            self.lap = laps_done
        self.last_delta = delta

    def merged(self) -> list[list[float] | None]:
        """This lap where driven, previous lap for the rest."""
        return [c if c is not None else p for c, p in zip(self.cur, self.prev)]
