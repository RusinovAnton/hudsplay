"""Turns raw iRacing telemetry + session info into the state the frontend renders.

Sources (real iRacing or mock) hand us a telemetry dict keyed by iRacing SDK
variable names plus the parsed session-info YAML. Everything derived lives here,
so the mock exercises the same code that runs during a real race.
"""

from __future__ import annotations

import math
from collections import deque

from .config import Config
from .countries import to_iso
from .trackmap import DeltaPaint, TrackMap

N_BUCKETS = 1000  # gap timing resolution: crossing times recorded per 1/1000 lap
TREND_BUCKETS = 200  # resolution for "gap at this point one lap ago"
UNLIMITED_LAPS = 32767
UNLIMITED_TIME = 604800.0  # iRacing reports a week for "no time limit"
CAR_LENGTH_M = 4.8
SIDE_BY_SIDE_M = CAR_LENGTH_M * 1.5

# irsdk_CarLeftRight, as the SDK names it: 2 = car left, 3 = car right. Verified against
# the spotter's callouts in a race 2026-10-16 (an earlier swap had the radar mirrored).
SPOTTER = {0: "off", 1: "clear", 2: "left", 3: "right", 4: "both", 5: "left2", 6: "right2"}
# delta reference -> iRacing var (each has a matching *_OK flag). "SessionLastl" is iRacing's typo.
DELTA_VARS = {
    "session_best": ("LapDeltaToSessionBestLap", "session best"),
    "best": ("LapDeltaToBestLap", "best"),
    "optimal": ("LapDeltaToOptimalLap", "optimal"),
    "session_optimal": ("LapDeltaToSessionOptimalLap", "session optimal"),
    "session_last": ("LapDeltaToSessionLastlLap", "last lap"),
}
# road course incident points -> what happened (light contact is 0x, never counted)
INCIDENT_TYPES = {1: "off-track", 2: "loss of control", 4: "contact"}
INCIDENT_MERGE_S = 2.5  # iRacing escalates in steps (1x -> 2x): merge into one incident
INCIDENT_ALERT_S = 4.0  # the "contact 4x" alert shows this long after the last step
GAIN_TAU_S = 1.0  # smoothing of the "gaining right now" rate on the ▲/▼ widgets
CLOSING_WINDOW_LAPS = 0.15  # ▲/▼ "catching in N laps" uses the gap change over this much lap
# a rival in trouble ahead (spun / crawling), see _hazard
HAZARD_AHEAD_M = 500.0  # warn about trouble up to this far ahead of me
SLOW_FRAC = 0.2  # slower than this x the lap-average speed = crawling
SLOW_HOLD_S = 1.0  # ...for at least this long (a slow hairpin isn't trouble)
BACKWARDS_MS = -2.0  # rolling backwards faster than this (m/s) = spun
SPEED_TAU_S = 0.3  # smoothing of each car's speed
BURN_NOW_TAU_S = 0.5  # live fuel burn: current rate smoothed this much...
BURN_AVG_TAU_S = 60.0  # ...compared with the average over about this long
SIDE_HOLD_M = 4.0  # a car alongside keeps its side (ahead / behind) until this far past me
PIT_LIMITER_BIT = 0x10  # irsdk_EngineWarnings: irsdk_pitSpeedLimiter
SPOTTER_SIDES = {2: ["L"], 3: ["R"], 4: ["L", "R"], 5: ["L", "L2"], 6: ["R", "R2"]}


class CarTrack:
    """Continuous lap progress for one car + the session time it reached each bucket."""

    __slots__ = ("progress", "last_pct", "last_bucket", "last_time", "times", "last_laps")

    def __init__(self, laps_completed: int, pct: float, now: float):
        self.last_laps = laps_completed
        self.progress = laps_completed + pct
        self.last_pct = pct
        self.last_bucket = int(self.progress * N_BUCKETS)
        self.last_time = now
        self.times: dict[int, float] = {self.last_bucket: now}

    def advance(self, pct: float, now: float) -> None:
        # unwrap from pct deltas so the S/F line never glitches progress by a lap
        dp = pct - self.last_pct
        if dp < -0.5:
            dp += 1
        elif dp > 0.5:
            dp -= 1
        self.last_pct = pct
        prev = self.progress
        self.progress += dp
        bucket = int(self.progress * N_BUCKETS)
        if dp > 0 and bucket > self.last_bucket:
            # interpolate crossing times for every bucket passed this frame
            for b in range(self.last_bucket + 1, bucket + 1):
                frac = min(max((b / N_BUCKETS - prev) / dp, 0.0), 1.0)
                self.times[b] = self.last_time + (now - self.last_time) * frac
            self.last_bucket = bucket
            if len(self.times) > 3 * N_BUCKETS:
                cutoff = bucket - 2 * N_BUCKETS
                self.times = {k: v for k, v in self.times.items() if k >= cutoff}
        self.last_time = now

    def resync(self, laps_completed: int, pct: float, force: bool = False) -> int:
        """Line progress up with iRacing's lap counter (whole laps only): whenever the
        counter changes, or forced (pit exit). Progress is unwrapped from lap %, so a
        start-line crossing iRacing doesn't count (grid start vs a pit start) would
        otherwise leave every car +1L forever. Returns the laps shifted."""
        if laps_completed < 0:
            return 0
        if force:
            if pct < 0.02 or pct > 0.98:  # on the line: the counter may be mid-tick
                return 0
        # counter ticks may come a frame before lap % wraps: wait until past the line
        elif laps_completed == self.last_laps or pct >= 0.5:
            return 0
        self.last_laps = laps_completed
        k = round(laps_completed + pct - self.progress)
        if k:
            self.progress += k
            self.last_bucket += k * N_BUCKETS
            self.times = {b + k * N_BUCKETS: t for b, t in self.times.items()}
        return k

    def time_at(self, progress: float) -> float | None:
        x = progress * N_BUCKETS
        b = int(x)
        t0 = self.times.get(b)
        t1 = self.times.get(b + 1)
        if t0 is None or t1 is None:
            return t0
        return t0 + (t1 - t0) * (x - b)


class IncidentLog:
    """My incident count + the latest incident's type (the SDK only gives the count)."""

    def __init__(self):
        self.count: int | None = None
        self.last_at: float | None = None  # time of the latest step
        self.last_x = 0  # points of the latest incident, escalation steps merged

    def update(self, count: int | None, now: float) -> None:
        if count is None or count < 0:
            return
        if self.count is None or count < self.count:  # first frame / counter reset
            self.count, self.last_at, self.last_x = count, None, 0
            return
        if count > self.count:
            step, self.count = count - self.count, count
            merge = self.last_at is not None and now - self.last_at <= INCIDENT_MERGE_S
            self.last_x = self.last_x + step if merge else step
            self.last_at = now

    def summary(self, limit: int | None, warn: tuple[int | None, int | None], now: float) -> dict:
        alert = None
        if self.last_at is not None and now - self.last_at <= INCIDENT_ALERT_S:
            alert = {"label": INCIDENT_TYPES.get(self.last_x, "incident"), "x": self.last_x}
        return {"count": self.count, "limit": limit, "warn": _warning_limit(warn[0], limit), "alert": alert}


def _warning_limit(initial: int | None, dq: int | None) -> int | None:
    """The session's penalty warning limit, shown fixed like iRacing's "17x / 17x / 25x"
    (owner: a threshold moving with the count, then vanishing, was confusing). None when
    warnings are off or it isn't below the DQ limit."""
    if not initial:
        return None
    return initial if dq is None or initial < dq else None


class OptimalLap:
    """My optimal lap: best time per track sector over my clean laps, summed (like
    iRacing's; the SDK has no optimal lap time var). Sector times come from my car's
    crossing times (CarTrack), sector starts from SplitTimeInfo."""

    def __init__(self, starts: list[float] | None = None):
        self.starts = starts or [i / 10 for i in range(10)]  # no split info: 10 equal sectors
        self.best: list[float | None] = [None] * len(self.starts)
        self.lap: int | None = None
        self.clean = False

    def update(self, tr, clean: bool) -> None:
        lap = math.floor(tr.progress)
        if self.lap is None:  # joined mid-lap: this lap doesn't count
            self.lap, self.clean = lap, False
            return
        if lap != self.lap:
            if self.clean and lap == self.lap + 1:
                self._record(tr, self.lap)
            self.lap, self.clean = lap, clean  # a lap counts only if clean from the line
        elif not clean:
            self.clean = False

    def _record(self, tr, lap: int) -> None:
        ts = [tr.time_at(lap + s) for s in self.starts] + [tr.time_at(lap + 1)]
        if None in ts:
            return
        for i, (a, b) in enumerate(zip(ts, ts[1:])):
            if b > a and (self.best[i] is None or b - a < self.best[i]):
                self.best[i] = b - a

    @property
    def time(self) -> float | None:
        return None if None in self.best else sum(self.best)


class FuelCalc:
    def __init__(self):
        self.lap: int | None = None
        self.start = 0.0
        self.dirty = True  # current lap unusable (joined mid-lap, pitted, refuelled)
        self.usage: deque[float] = deque(maxlen=5)

    def update(self, laps_completed: int | None, fuel: float | None, on_pit: bool) -> None:
        if fuel is None or laps_completed is None or laps_completed < 0:
            return
        if self.lap is None:
            self.lap, self.start = laps_completed, fuel
            return
        if laps_completed > self.lap:
            used = self.start - fuel
            if not self.dirty and laps_completed == self.lap + 1 and used > 0:
                self.usage.append(used)
            self.lap, self.start, self.dirty = laps_completed, fuel, bool(on_pit)
        else:
            if on_pit:
                self.dirty = True
            if fuel > self.start + 0.2:
                self.start, self.dirty = fuel, True

    @property
    def per_lap(self) -> float | None:
        return sum(self.usage) / len(self.usage) if self.usage else None


def _fmt_name(name: str, fmt: str) -> str:
    parts = name.split()
    if fmt == "short" and len(parts) > 1:
        return f"{parts[0][0]}. {' '.join(parts[1:])}"
    return name


def _class_color(value) -> str | None:
    """iRacing CarClassColor (YAML hex like 0xffda59, parsed as int or str) -> '#ffda59'."""
    if value is None or value == "":
        return None
    try:
        n = value if isinstance(value, int) else int(str(value), 0)
    except ValueError:
        return None
    return f"#{n & 0xFFFFFF:06x}"


def _track_length_m(text: str | None) -> float | None:
    if not text:
        return None
    value, _, unit = text.partition(" ")
    try:
        v = float(value)
    except ValueError:
        return None
    return v * 1609.344 if unit.startswith("mi") else v * 1000


def _license(text, color=None) -> dict:
    """DriverInfo LicString "A 3.41" + LicColor -> {"lic": "A", "sr": 3.41, "licColor": "#0153db"}.
    LicColor is the sim's own color for that license (what the game UI shows), but it can
    be missing ("0xundefined" seen in a real dump): then licColor is None and the frontend
    falls back to its --c-lic-* color for the letter. Unknown -> nothing."""
    try:
        letter, sr = str(text).split()
        return {"lic": letter[:2].upper(), "sr": float(sr), "licColor": _class_color(color)}
    except (TypeError, ValueError):
        return {"lic": None, "sr": None, "licColor": None}


def _limit(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):  # "unlimited"
        return None


def _laps_from_info(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return UNLIMITED_LAPS


def _r(v, nd=3):
    return None if v is None else round(v, nd)


class Engine:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._info = None
        self.drivers: dict[int, dict] = {}
        self.player_idx = 0
        self.track_len: float | None = None
        self.track_name = ""
        self.track_config = ""
        self.fuel_capacity: float | None = None
        self.est_lap = 100.0
        self.grid_slot: dict[int, int] = {}
        self.tire_types: dict[int, str] = {}  # compound index -> 'hard' / 'wet' / ...
        self.incident_limit: int | None = None
        self.incident_warn: tuple[int | None, int | None] = (None, None)
        self.sessions: dict[int, dict] = {}
        self.multiclass = False
        self.session_num = None
        self.map = TrackMap()
        self._frame = 0
        self._sent_map_version = -1
        self._map_inc = None  # my incident count last frame (map recording)
        self._reset()

    def _reset(self):
        self.tracks: dict[int, CarTrack] = {}
        self._on_pit: dict[int, bool] = {}  # last frame's CarIdxOnPitRoad (pit exit = re-align)
        self.fuel = FuelCalc()
        self.burn: list = [None, None, None, 0.0]  # FuelUsePerHour: [time, now-smoothed, average, seconds averaged]
        self.incidents = IncidentLog()
        self.optimal = OptimalLap(getattr(self, "sector_starts", None))
        self.trends: dict[tuple[int, bool], dict[int, float]] = {}
        self.gains: dict[tuple[int, bool], list[float]] = {}  # [time, g, smoothed rate]
        self.radar_sides: dict[int, str] = {}
        self.motion: dict[int, list] = {}  # per car: [progress, time, speed m/s, slow since]
        self.trouble: dict[int, str] = {}  # per car in trouble: 'spun' / 'slow'
        self.held_ahead: dict[int, bool] = {}  # side per car, held while alongside (_held_ahead)
        self.positions: dict[int, int] = {}  # this frame's position per car (relative / ▲▼)
        self.start_pos: int | None = None
        self.best_seen: dict[int, float] = {}  # best lap per car this session, kept after they leave
        self.paint = DeltaPaint(getattr(self, "track_len", None))
        self.last_now: float | None = None

    def _load_info(self, info: dict) -> None:
        self._info = info
        di = info.get("DriverInfo") or {}
        self.player_idx = di.get("DriverCarIdx", self.player_idx)
        self.est_lap = float(di.get("DriverCarEstLapTime") or self.est_lap)
        max_ltr = di.get("DriverCarFuelMaxLtr")
        # series may restrict the tank (e.g. 0.6 = 60 %)
        self.fuel_capacity = float(max_ltr) * float(di.get("DriverCarMaxFuelPct") or 1) if max_ltr else None
        self.drivers = {}
        for d in di.get("Drivers") or []:
            if d.get("CarIsPaceCar") or d.get("IsSpectator"):
                continue
            self.drivers[d["CarIdx"]] = {
                "name": _fmt_name(d.get("UserName", ""), self.cfg.name_format),
                "num": str(d.get("CarNumber", "")),
                "cls": d.get("CarClassID"),
                "clsName": d.get("CarClassShortName") or "",
                "clsColor": _class_color(d.get("CarClassColor")),
                # TODO(windows): verify flair field name with `uv run hudsplay --dump`
                "cc": to_iso(d.get("FlairName")),
                # offline / AI sessions report 0 or 1: no rating to show
                "ir": d.get("IRating") if (d.get("IRating") or 0) > 1 else None,
                **_license(d.get("LicString"), d.get("LicColor")),
            }
        self.multiclass = len({d["cls"] for d in self.drivers.values()}) > 1
        wi = info.get("WeekendInfo") or {}
        name = wi.get("TrackDisplayShortName") or wi.get("TrackDisplayName") or ""
        config = wi.get("TrackConfigName") or ""
        self.track_name, self.track_config = name, config
        wo = wi.get("WeekendOptions") or {}
        self.incident_limit = _limit(wo.get("IncidentLimit"))  # DQ
        # penalty warnings: first at the initial limit, then every subsequent limit more
        self.incident_warn = (_limit(wo.get("IncidentWarningInitialLimit")), _limit(wo.get("IncidentWarningSubsequentLimit")))
        track_len = _track_length_m(wi.get("TrackLength"))
        if track_len != self.track_len:
            self.track_len = track_len
            self.paint.reset(track_len)
        track_id = wi.get("TrackID")
        self.map.set_track(
            f"{track_id}-{wi.get('TrackConfigName') or 'default'}" if track_id is not None else None,
            " ".join(x for x in (wi.get("TrackDisplayName") or name, config) if x),
        )
        sectors = sorted(
            float(s["SectorStartPct"])
            for s in (info.get("SplitTimeInfo") or {}).get("Sectors") or []
            if s.get("SectorStartPct") is not None
        )
        starts = sectors if sectors and sectors[0] == 0.0 else None
        if starts != getattr(self, "sector_starts", None):
            self.sector_starts = starts
            self.optimal = OptimalLap(starts)
        # starting grid from qualifying (QualifyResultsInfo Position is 0-based)
        # tire compounds this car has (DriverTires: TireIndex -> TireCompoundType)
        self.tire_types = {
            int(x["TireIndex"]): str(x.get("TireCompoundType") or "").strip().lower()
            for x in di.get("DriverTires") or []
            if x.get("TireIndex") is not None
        }
        self.grid_slot = {
            r["CarIdx"]: int(r.get("Position", 999))
            for r in (info.get("QualifyResultsInfo") or {}).get("Results") or []
            if r.get("CarIdx") is not None
        }
        self.sessions = {
            s.get("SessionNum"): {
                "type": s.get("SessionType", ""),
                "laps": _laps_from_info(s.get("SessionLaps")),
                # official results keep every car's fastest lap, also in the pits / disconnected
                "fastest": {
                    r["CarIdx"]: r["FastestTime"]
                    for r in s.get("ResultsPositions") or []
                    if r.get("CarIdx") is not None and (r.get("FastestTime") or 0) > 0
                },
            }
            for s in (info.get("SessionInfo") or {}).get("Sessions") or []
        }

    # ------------------------------------------------------------------ main

    def update(self, t: dict, info: dict) -> dict:
        now = t.get("SessionTime") or 0.0
        snum = t.get("SessionNum")
        if snum != self.session_num or (self.last_now is not None and now < self.last_now - 1):
            self._reset()
            self.session_num = snum
        self.last_now = now
        if info is not self._info:
            self._load_info(info)

        me = t.get("PlayerCarIdx", self.player_idx)
        self._advance_tracks(t, now)

        self.hazard = self._hazard(t, me, now)
        session, laps_to_go = self._session(t, me)
        standings, pos, cars = self._standings(t, me, now, session["race"], session["standings"])
        ahead, behind = (None, None) if session["qualify"] else self._neighbours(t, me)
        session["pos"], session["cars"] = pos, cars
        session["multiclass"] = self.multiclass
        # grid position: first position seen once parade laps / racing start
        # (irsdk_SessionState 3 = parade laps, 4 = racing)
        if session["race"] and self.start_pos is None and pos > 0 and t.get("SessionState") in (3, 4):
            self.start_pos = pos
        session["startPos"] = self.start_pos
        delta = self._delta(t, self.cfg.delta_reference)

        return {
            "connected": True,
            "replay": bool(t.get("IsReplayPlaying")),  # widgets fade out (not in edit mode)
            "session": session,
            "relative": standings,
            "fuel": self._fuel(t, me, laps_to_go),
            "incidents": self._incidents(t, now),
            "pit": self._pit(t),
            "hazard": self.hazard,
            "laps": self._laps(t, me),
            "delta": {
                "best": _r(delta),
                "ref": DELTA_VARS.get(self.cfg.delta_reference, DELTA_VARS["session_best"])[1],
                "ahead": self._rival(t, ahead, me, now, True, laps_to_go),
                "behind": self._rival(t, behind, me, now, False, laps_to_go),
            },
            "radar": self._radar(t, me),
            "map": self._map(t, me, now, self._delta(t, self.cfg.map_paint_reference), session["race"]),
        }

    def resend_map(self) -> None:
        """Include the (large) track shape in the next frame, e.g. for a new client."""
        self._sent_map_version = -1

    def _delta(self, t: dict, ref: str) -> float | None:
        var = DELTA_VARS.get(ref, DELTA_VARS["session_best"])[0]
        return t.get(var) if t.get(var + "_OK") else None

    def _map(self, t: dict, me: int, now: float, delta, race: bool) -> dict:
        pcts = t.get("CarIdxLapDistPct") or []
        done = t.get("CarIdxLapCompleted") or []
        pct = pcts[me] if me < len(pcts) else -1
        laps_done = done[me] if me < len(done) else 0
        clean = bool(t.get("IsOnTrack", True)) and not t.get("OnPitRoad")
        # any incident point this lap spoils the map recording (also off-tracks with no spin)
        inc = t.get("PlayerCarMyIncidentCount")
        map_clean = clean and (inc is None or inc == self._map_inc)
        self._map_inc = inc
        self.map.update(now, pct, laps_done, t.get("Speed"), t.get("YawNorth"), map_clean)
        self.paint.update(pct, laps_done, delta if clean else None)

        on_pit = t.get("CarIdxOnPitRoad") or []
        # [pct, kind, class color, lapRel, trouble]: kind 0 car, 1 me, 2 in pit;
        # lapRel +1 = a lap up on me, -1 = a lap down (race only)
        my = self.tracks.get(me)
        cars = []
        for idx, tr in self.tracks.items():
            kind = 1 if idx == me else 2 if idx < len(on_pit) and on_pit[idx] else 0
            lap_rel = 0
            if race and my is not None and idx != me:
                lap_rel = round(tr.progress - my.progress - self._track_dp(t, idx, me))
            d = self.drivers.get(idx)
            cars.append([round(pcts[idx], 4), kind, d["clsColor"] if d else None, lap_rel, self.trouble.get(idx)])

        out = {
            "version": self.map.version,
            "mirror": self.cfg.map_mirror,
            "recording": self.map.recording_pct,
            "status": self.map.status,
            "segLen": round(self.paint.seg_len_m, 2),
            "paint": self.paint.merged(),
            "paintNow": self.paint.seg,
            "cars": cars,
        }
        # shape is big: send it when it changes and once a second for new clients
        self._frame += 1
        if self.map.version != self._sent_map_version or self._frame % self.cfg.hz == 0:
            out["points"] = self.map.points
            self._sent_map_version = self.map.version
        return out

    def _advance_tracks(self, t: dict, now: float) -> None:
        pcts = t.get("CarIdxLapDistPct") or []
        laps = t.get("CarIdxLapCompleted") or []
        pit = t.get("CarIdxOnPitRoad") or []
        me = t.get("PlayerCarIdx", self.player_idx)
        # pit exit: re-align that car right away; my own pit exit (e.g. a pit-lane start)
        # re-aligns everyone, so lap tags are right from the start, not after a lap
        exited = {i for i in self.drivers if i < len(pit) and not pit[i] and self._on_pit.get(i)}
        self._on_pit = {i: bool(pit[i]) for i in self.drivers if i < len(pit)}
        everyone = me in exited
        for idx in self.drivers:
            pct = pcts[idx] if idx < len(pcts) else -1
            if pct is None or pct < 0:  # not in world (garage, disconnected)
                self.tracks.pop(idx, None)
                continue
            tr = self.tracks.get(idx)
            lc = laps[idx] if idx < len(laps) else -1
            if tr is None:
                self.tracks[idx] = tr = CarTrack(max(lc, 0), pct, now)
                self.motion.pop(idx, None)
            else:
                tr.advance(pct, now)
                if tr.resync(lc, pct, force=everyone or idx in exited):
                    self.motion.pop(idx, None)  # progress jumped a lap: not real speed
                    if idx == me:
                        self.trends.clear()  # keyed by my progress: history no longer lines up
            self._track_speed(idx, tr, now)

    def _track_speed(self, idx: int, tr: "CarTrack", now: float) -> None:
        """Each car's speed along the track (m/s, smoothed), from its lap progress;
        negative when it rolls backwards."""
        m = self.motion.get(idx)
        if m is None or not self.track_len:
            self.motion[idx] = [tr.progress, now, None, None]
            return
        dt = now - m[1]
        if dt <= 0:
            return
        v = (tr.progress - m[0]) / dt * self.track_len
        m[2] = v if m[2] is None else m[2] + (v - m[2]) * min(1.0, dt / SPEED_TAU_S)
        m[0], m[1] = tr.progress, now

    def _pace(self, t: dict, idx: int) -> float:
        for key in ("CarIdxLastLapTime", "CarIdxBestLapTime"):
            arr = t.get(key) or []
            if idx < len(arr) and arr[idx] and arr[idx] > 0:
                return arr[idx]
        return self.est_lap

    # -------------------------------------------------------------- widgets

    def _session(self, t: dict, me: int) -> tuple[dict, float | None]:
        info = self.sessions.get(t.get("SessionNum"), {})
        stype = info.get("type", "")
        race = "race" in stype.lower()

        remain = t.get("SessionTimeRemain")
        if remain is None or remain >= UNLIMITED_TIME - 1:
            remain = None
        elif remain < 0:
            remain = 0.0

        total_laps = t.get("SessionLapsTotal") or info.get("laps", UNLIMITED_LAPS)
        done = (t.get("CarIdxLapCompleted") or [])[me] if me < len(t.get("CarIdxLapCompleted") or []) else 0
        lap = max(done, 0) + 1
        my = self.tracks.get(me)

        # before the start (gridding, pace laps) the clock counts down to the green and
        # progress is from the grid: nothing to estimate yet (irsdk_StateRacing = 4)
        started = not race or (t.get("SessionState") or 0) >= 4
        total, estimated, to_go = None, False, None
        if 0 < total_laps < UNLIMITED_LAPS:
            total = total_laps
            to_go = (total - my.progress if started else total) if my else None
        elif remain is not None and my and started:
            # time-based: race ends when the leader crosses the line after the clock hits 0
            ref = self._leader(t) if race else me
            ref_tr = self.tracks.get(ref) if ref is not None else None
            if ref_tr is None:
                ref, ref_tr = me, my
            pace = self._pace(t, ref)
            to_line = (1 - ref_tr.progress % 1) * pace
            rem_laps = 1 if remain <= to_line else 1 + math.ceil((remain - to_line) / pace)
            ref_final = math.floor(ref_tr.progress) + rem_laps
            total = math.ceil(my.progress + (ref_final - ref_tr.progress) - 1e-6)
            estimated = True
            to_go = total - my.progress

        return {
            "type": stype,
            "race": race,
            "track": self.track_name,
            "trackConfig": self.track_config,
            "qualify": "qualify" in stype.lower(),
            # relative -> best-lap standings
            "standings": any(k in stype.lower() for k in ("qualify", "practice")),
            "grid": race and not started,  # relative shows the grid until the green
            "lap": min(lap, total) if total else lap,
            "lapsTotal": total,
            "lapsEstimated": estimated,
            "timeRemain": _r(remain, 1),
        }, to_go

    def _leader(self, t: dict) -> int | None:
        for idx, p in enumerate(t.get("CarIdxPosition") or []):
            if p == 1:
                return idx
        return None

    def _standings(self, t: dict, me: int, now: float, race: bool, by_best: bool = False):
        """Race order around me: rivals for the delta widgets, my position, relative rows."""
        class_only = self.cfg.standings_class_only
        positions = self._positions(t, race, class_only)
        self.positions = positions  # the ▲/▼ widgets show the same position as the relative
        my_cls = self.drivers.get(me, {}).get("cls")

        entries = []
        for idx, d in self.drivers.items():
            if class_only and d["cls"] != my_cls:
                continue
            p = positions.get(idx, 0)
            if p <= 0 and idx not in self.tracks and idx != me:
                continue
            entries.append((p if p > 0 else 999, idx, p))
        entries.sort()
        order = [idx for _, idx, _ in entries]
        if me not in order:
            return [], 0, len(order)

        my_pos = next(p for _, idx, p in entries if idx == me)
        if by_best:
            rows = self._quali(t, me)
        elif race and (t.get("SessionState") or 0) < 4:  # before the green: grid, not relative
            rows = self._grid(t, me)
        else:
            rows = self._relative(t, me, now, race, positions)
        return rows, my_pos, len(order)

    def _grid(self, t: dict, me: int) -> list[dict]:
        """Before the start: every car in the world (gridded or rolling to the grid) plus
        me, in grid order: qualifying result, else order on the grid (front = furthest
        along). Works while I'm still in the garage too."""
        row = self._row_maker(t, me)
        cars = set(self.tracks) | ({me} if me in self.drivers else set())
        cars &= set(self.drivers)
        far = {idx: self.tracks[idx].progress if idx in self.tracks else -1e9 for idx in cars}
        order = sorted(cars, key=lambda i: (self.grid_slot.get(i, 999), -far[i]))
        n = self.cfg.standings_each_side
        i = order.index(me) if me in order else 0
        start = max(0, min(i - n, len(order) - (2 * n + 1)))
        window = order[start : start + 2 * n + 1]
        pinned = bool(order) and order[0] not in window
        if pinned:  # pole is always on top
            window.insert(0, order[0])
        rows = [row(idx, order.index(idx) + 1) for idx in window]
        if pinned:
            rows[0]["leader"] = True
        return rows

    def _positions(self, t: dict, race: bool, class_only: bool) -> dict[int, int]:
        """Position per car (in its class if class_only). iRacing's CarIdxPosition only
        updates at timing lines, so while racing it's ranked live by track progress."""
        if race and t.get("SessionState") == 4:  # irsdk_StateRacing
            groups: dict = {}
            for idx, tr in self.tracks.items():
                if idx in self.drivers:
                    key = self.drivers[idx]["cls"] if class_only else None
                    groups.setdefault(key, []).append((-tr.progress, idx))
            return {idx: i + 1 for g in groups.values() for i, (_, idx) in enumerate(sorted(g))}
        arr = t.get("CarIdxClassPosition" if class_only else "CarIdxPosition") or []
        return {idx: p for idx, p in enumerate(arr) if p and p > 0}

    def _track_dp(self, t: dict, idx: int, me: int) -> float:
        """Track distance from me to idx in laps, (-0.5, 0.5], + = ahead on track."""
        pcts = t.get("CarIdxLapDistPct") or []
        dp = pcts[idx] - pcts[me]
        return dp - round(dp)

    def _track_gap(self, idx: int, me: int, dp: float, now: float) -> float:
        """Seconds between us on track, + = they're ahead (iRacing relative timing)."""
        tr, my = self.tracks[idx], self.tracks[me]
        if dp > 0:  # they passed my current spot dp laps ago
            t_then = tr.time_at(tr.progress - dp)
            return now - t_then if t_then is not None else dp * self.est_lap
        t_then = my.time_at(my.progress + dp)  # I was where they are now
        return -(now - t_then) if t_then is not None else dp * self.est_lap

    def _held_ahead(self, idx: int, dp: float) -> bool:
        """Is idx ahead of me? Side by side, track distance wobbles around 0 every frame,
        so a car keeps its last side until it's SIDE_HOLD_M clearly past: the ▲/▼ widgets
        and the relative don't flicker between ahead and behind."""
        hold = SIDE_HOLD_M / self.track_len if self.track_len else 0.001  # in laps
        prev = self.held_ahead.get(idx)
        if prev is not None and abs(dp) < hold:
            return prev
        self.held_ahead[idx] = dp > 0
        return dp > 0

    def _neighbours(self, t: dict, me: int) -> tuple[int | None, int | None]:
        """Nearest car ahead / behind on track: any class, any lap. Cars on pit road
        only count while I'm on pit road too (a parked car isn't part of the fight)."""
        if me not in self.tracks:
            return None, None
        on_pit = t.get("CarIdxOnPitRoad") or []
        pit = lambda i: bool(on_pit[i]) if i < len(on_pit) else False  # noqa: E731
        ahead = behind = None
        for idx in self.tracks:
            if idx == me or idx not in self.drivers or (pit(idx) and not pit(me)):
                continue
            dp = self._track_dp(t, idx, me)
            if self._held_ahead(idx, dp):
                if ahead is None or abs(dp) < ahead[0]:
                    ahead = (abs(dp), idx)
            elif behind is None or abs(dp) < behind[0]:
                behind = (abs(dp), idx)
        return ahead and ahead[1], behind and behind[1]

    def _best(self, t: dict, idx: int) -> float | None:
        """Best lap this session. Live CarIdxBestLapTime is -1 once a car is in the garage
        or gone, so also use the session results and the best we've seen."""
        bests = t.get("CarIdxBestLapTime") or []
        live = bests[idx] if idx < len(bests) else -1
        results = self.sessions.get(t.get("SessionNum"), {}).get("fastest", {}).get(idx)
        known = [v for v in (live, results, self.best_seen.get(idx)) if v and v > 0]
        if not known:
            return None
        self.best_seen[idx] = best = min(known)
        return best

    def _row_maker(self, t: dict, me: int):
        """Row builder shared by the relative and the qualifying standings."""
        on_pit = t.get("CarIdxOnPitRoad") or []
        talking = t.get("RadioTransmitCarIdx", -1)  # -1 = nobody on the radio
        compounds = t.get("CarIdxTireCompound") or []
        # only worth showing when the series has a choice (dry / wet, soft / hard)
        tires = self.tire_types if len(self.tire_types) > 1 else {}
        class_best: dict = {}
        for idx, d in self.drivers.items():
            b = self._best(t, idx)
            if b and (d["cls"] not in class_best or b < class_best[d["cls"]]):
                class_best[d["cls"]] = b

        def row(idx: int, pos: int, gap: float | None = None, lap_rel: int = 0) -> dict:
            d = self.drivers[idx]
            b = self._best(t, idx)
            return {
                "id": idx,
                "pos": pos,
                "num": d["num"],
                "name": d["name"],
                "cc": d["cc"],
                "ir": d["ir"],
                "lic": d["lic"],
                "sr": d["sr"],
                "licColor": d["licColor"],
                "best": _r(b),
                "bestIsClassBest": b is not None and b == class_best.get(d["cls"]),
                "cls": d["clsName"],
                "clsColor": d["clsColor"],
                "gap": _r(gap),
                "lapRel": lap_rel,
                "isMe": idx == me,
                "inPit": bool(on_pit[idx]) if idx < len(on_pit) else False,
                "radio": idx == talking,
                "tire": tires.get(compounds[idx]) if idx < len(compounds) else None,
                "trouble": self.trouble.get(idx),
            }

        return row

    def _quali(self, t: dict, me: int) -> list[dict]:
        """Practice / qualifying standings: every car with a lap time (also in the pits or
        disconnected) ordered by best lap, a window around me (top of the list until I set
        a time). Gap = their best - mine, "-" = faster."""
        if me not in self.drivers:
            return []
        my_cls = self.drivers[me]["cls"]
        class_only = self.cfg.standings_class_only
        timed = sorted(
            (b, idx)
            for idx, d in self.drivers.items()
            if (b := self._best(t, idx)) and (not class_only or d["cls"] == my_cls)
        )
        order = [idx for _, idx in timed]
        rank = {idx: i + 1 for i, idx in enumerate(order)}
        if me not in rank:
            order.append(me)
        n = self.cfg.standings_each_side
        i = order.index(me)
        start = max(0, min(i - n, len(order) - (2 * n + 1)))
        my_best = self._best(t, me)
        row = self._row_maker(t, me)
        window = order[start : start + 2 * n + 1]
        pinned = bool(order) and order[0] not in window
        if pinned:  # P1 is always on top
            window.insert(0, order[0])
        rows = []
        for idx in window:
            b = self._best(t, idx)
            gap = b - my_best if b and my_best and idx != me else None
            rows.append(row(idx, rank.get(idx, 0), gap))
        if pinned:
            rows[0]["leader"] = True
        return rows

    def _relative(self, t: dict, me: int, now: float, race: bool, positions: dict) -> list[dict]:
        """Cars nearest to me on track (any class, lapped or not), nearest-first each side."""
        my = self.tracks.get(me)
        if my is None:
            return []
        pcts = t.get("CarIdxLapDistPct") or []
        make_row = self._row_maker(t, me)

        ahead, behind = [], []
        for idx, tr in self.tracks.items():
            if idx == me:
                continue
            dp = pcts[idx] - pcts[me]
            dp -= round(dp)  # track distance in laps, (-0.5, 0.5], + = ahead on track
            (ahead if self._held_ahead(idx, dp) else behind).append((abs(dp), dp, idx, tr))
        n = self.cfg.standings_each_side
        ahead = sorted(ahead)[:n]
        behind = sorted(behind)[:n]

        def row(idx, dp, tr):
            gap, lap_rel = None, 0
            if idx != me:
                gap = abs(self._track_gap(idx, me, dp, now))
                if self._held_ahead(idx, dp):  # iRacing relative: ahead is "-" (held side)
                    gap = -gap
                if race:
                    # whole laps between us in race distance: +1 = they're a lap up on me
                    lap_rel = round(tr.progress - my.progress - dp)
            return make_row(idx, positions.get(idx, 0), gap, lap_rel)

        rows = [row(idx, dp, tr) for _, dp, idx, tr in reversed(ahead)]
        rows.append(row(me, 0.0, my))
        rows += [row(idx, dp, tr) for _, dp, idx, tr in behind]
        # the leader is always on top, even when not near me on track
        lead = self._class_leader(me, positions)
        if lead is not None and lead in self.tracks and all(r["id"] != lead for r in rows):
            leader_row = row(lead, self._track_dp(t, lead, me), self.tracks[lead])
            leader_row["leader"] = True
            rows.insert(0, leader_row)
        return rows

    def _class_leader(self, me: int, positions: dict) -> int | None:
        """P1 (in my class when positions are per class)."""
        firsts = [idx for idx, p in positions.items() if p == 1 and idx in self.drivers]
        my_cls = self.drivers.get(me, {}).get("cls")
        same = [idx for idx in firsts if self.drivers[idx]["cls"] == my_cls]
        return (same or firsts or [None])[0]

    def _rival(self, t: dict, idx: int | None, me: int, now: float, is_ahead: bool, laps_to_go: float | None = None):
        """Gap to the nearest car ahead/behind on track, how it changed vs one lap ago,
        and how many laps until the gap closes at that rate.

        trend < 0 is always good for the player (like the lap delta bar).
        """
        my = self.tracks.get(me)
        if idx is None or my is None or idx not in self.tracks:
            return None
        dp = self._track_dp(t, idx, me)
        g = abs(self._track_gap(idx, me, dp, now))
        g = g if is_ahead else -g  # sign of the widget's side (held while alongside)
        tr = self.tracks[idx]
        lap_rel = round(tr.progress - my.progress - dp)  # +1 = they're a lap up on me
        # history per car and side (signed gap, + = they're ahead), keyed by my absolute
        # track bucket; a pass starts a fresh history so the trend never spans it
        hist = self.trends.setdefault((idx, is_ahead), {})
        ab = int(my.progress * TREND_BUCKETS)
        hist.setdefault(ab, g)
        # gap at this spot one lap ago; until a lap of history exists, the oldest gap we have
        prev = hist.get(ab - TREND_BUCKETS)
        span = 1.0  # laps of history behind `prev`
        if prev is None:
            first_key, prev = next(iter(hist.items()))
            span = (ab - first_key) / TREND_BUCKETS
        if len(hist) > 3 * TREND_BUCKETS:
            self.trends[(idx, is_ahead)] = {k: v for k, v in hist.items() if k >= ab - 2 * TREND_BUCKETS}
        # gaining right now, s/s, + = I'm gaining (either side: g falling = I move forward
        # relative to them), smoothed; drives the widget color like the delta bar's intensity
        st = self.gains.get((idx, is_ahead))
        gain = None
        if st is not None and 0 < now - st[0] <= 0.5:
            dt = now - st[0]
            rate = -(g - st[1]) / dt
            st[2] += (rate - st[2]) * min(1.0, dt / GAIN_TAU_S)
            st[0], st[1] = now, g
            gain = st[2]
        else:
            self.gains[(idx, is_ahead)] = [now, g, 0.0]
        # ahead: gap shrinking -> g falls -> negative. behind: they close -> g rises -> positive.
        trend = g - prev if prev is not None else None
        gap = g if is_ahead else -g
        # closing speed in s/lap (> 0 = gap shrinking) over the last CLOSING_WINDOW_LAPS,
        # so the status line follows what's happening now, not the whole last lap
        w = int(CLOSING_WINDOW_LAPS * TREND_BUCKETS)
        recent = hist.get(ab - w)
        recent_span = CLOSING_WINDOW_LAPS
        if recent is None:
            recent, recent_span = prev, span
        closing = None
        if recent is not None and recent_span >= 0.05:
            change = g - recent
            closing = (-change if is_ahead else change) / recent_span
        catch = gap / closing if closing and closing > 0.005 and gap > 0 else None
        d = self.drivers[idx]
        return {
            "num": d["num"],
            "name": d["name"],
            "gap": _r(gap),
            "lapRel": lap_rel,
            "pos": self.positions.get(idx, 0),
            "cls": d["clsName"],
            "clsColor": d["clsColor"],
            "trend": _r(trend),
            "gain": _r(gain, 4),
            "closing": _r(closing),
            "catchLaps": _r(catch, 1),
            "catchAfterFlag": bool(catch is not None and laps_to_go is not None and catch > laps_to_go),
        }

    def _hazard(self, t: dict, me: int, now: float) -> dict | None:
        """Rivals in trouble, like a spotter's "car spun ahead": a car rolling backwards, or
        off track and crawling, has spun; one crawling on track for SLOW_HOLD_S is slow.
        Cars on pit road / in their stall are ignored, so is everything before the green
        (cars stand still on the grid). Returns the nearest one up to HAZARD_AHEAD_M ahead."""
        self.trouble = {}
        if (t.get("SessionState") or 0) < 4 or not self.track_len or me not in self.tracks:
            return None
        surface = t.get("CarIdxTrackSurface") or []
        on_pit = t.get("CarIdxOnPitRoad") or []
        crawl = SLOW_FRAC * self.track_len / self.est_lap  # m/s
        nearest = None
        for idx, m in self.motion.items():
            if idx == me or idx not in self.drivers or m[2] is None:
                continue
            surf = surface[idx] if idx < len(surface) else 3  # irsdk_TrkLoc, 3 = on track
            if surf in (1, 2) or (idx < len(on_pit) and on_pit[idx]):  # pit stall / pit lane
                m[3] = None
                continue
            slow = m[2] < crawl
            m[3] = (m[3] or now) if slow else None
            kind = None
            if m[2] < BACKWARDS_MS or (surf == 0 and slow):  # 0 = off track
                kind = "spun"
            elif slow and now - m[3] >= SLOW_HOLD_S:
                kind = "slow"
            if kind is None:
                continue
            self.trouble[idx] = kind
            dist = self._track_dp(t, idx, me) * self.track_len
            if 0 < dist <= HAZARD_AHEAD_M and (nearest is None or dist < nearest[0]):
                nearest = (dist, idx, kind)
        if nearest is None:
            return None
        dist, idx, kind = nearest
        d = self.drivers[idx]
        return {"kind": kind, "dist": round(dist), "num": d["num"], "name": d["name"]}

    def _pit(self, t: dict) -> dict:
        """Pit limiter on/off (EngineWarnings bit), and whether I'm on pit road moving
        (limiter off there = speeding penalty)."""
        ew = t.get("EngineWarnings") or 0
        return {
            "limiter": bool(ew & PIT_LIMITER_BIT),
            "onPitRoad": bool(t.get("OnPitRoad")),
            "moving": (t.get("Speed") or 0) > 1.0,
        }

    def _incidents(self, t: dict, now: float) -> dict:
        self.incidents.update(t.get("PlayerCarMyIncidentCount"), now)
        return self.incidents.summary(self.incident_limit, self.incident_warn, now)

    def _laps(self, t: dict, me: int) -> dict:
        my = self.tracks.get(me)
        if my is not None:
            self.optimal.update(my, bool(t.get("IsOnTrack", True)) and not t.get("OnPitRoad"))
        pos = lambda v: v if v and v > 0 else None  # noqa: E731  (-1 / 0 = no lap yet)
        last, best = pos(t.get("LapLastLapTime")), pos(t.get("LapBestLapTime"))
        return {"last": _r(last), "best": _r(best), "optimal": _r(self.optimal.time)}

    def _burn(self, t: dict) -> float | None:
        """Live fuel burn vs my usual: FuelUsePerHour smoothed over ~0.5 s divided by its
        average over ~a minute. 1 = usual, > 1 flat out, < 1 lifting / saving. Only while
        driving on track (not on pit road)."""
        rate = t.get("FuelUsePerHour")
        now = t.get("SessionTime") or 0.0
        b = self.burn
        if rate is None or not t.get("IsOnTrack", True) or t.get("OnPitRoad"):
            b[0] = None
            return None
        if b[0] is None or b[1] is None:
            b[0], b[1] = now, rate
            b[2] = b[2] if b[2] is not None else rate
            return None
        dt = max(0.0, min(now - b[0], 1.0))
        b[0] = now
        b[1] += (rate - b[1]) * (1 - math.exp(-dt / BURN_NOW_TAU_S))
        # the average is a plain running mean until it has BURN_AVG_TAU_S of driving, so
        # it's right from the first lap instead of starting at whatever the first reading was
        b[3] += dt
        tau = min(BURN_AVG_TAU_S, max(b[3], dt, 1e-3))
        b[2] += (rate - b[2]) * (dt / tau if b[3] < BURN_AVG_TAU_S else 1 - math.exp(-dt / tau))
        return _r(b[1] / b[2], 2) if b[2] and b[2] > 0 else None

    def _fuel(self, t: dict, me: int, laps_to_go: float | None) -> dict:
        level = t.get("FuelLevel")
        done = t.get("CarIdxLapCompleted") or []
        self.fuel.update(done[me] if me < len(done) else None, level, bool(t.get("OnPitRoad")))
        per_lap = self.fuel.per_lap
        laps_left = level / per_lap if level is not None and per_lap else None
        to_finish = laps_to_go * per_lap - level if per_lap and laps_to_go is not None and level is not None else None
        return {
            "burn": self._burn(t),
            "level": _r(level, 2),
            "capacity": _r(self.fuel_capacity, 2),
            "perLap": _r(per_lap),
            "lapsLeft": _r(laps_left, 2),
            "toFinish": _r(to_finish, 2),
        }

    def _radar(self, t: dict, me: int) -> dict:
        rng = self.cfg.radar_range_m
        lr = t.get("CarLeftRight") or 0
        out = {"range": rng, "carLen": CAR_LENGTH_M, "cars": [], "spotter": SPOTTER.get(lr, "off")}
        pcts = t.get("CarIdxLapDistPct") or []
        if not t.get("IsOnTrack", True) or self.track_len is None or me >= len(pcts) or pcts[me] < 0:
            return out
        on_pit = t.get("CarIdxOnPitRoad") or []
        near = []
        for idx in self.tracks:
            if idx == me or (idx < len(on_pit) and on_pit[idx]):
                continue
            d = pcts[idx] - pcts[me]
            d = (d - round(d)) * self.track_len  # wrap across S/F, metres, + = ahead
            if abs(d) <= rng:
                near.append((abs(d), d, idx))
        near.sort()
        # SDK gives exact longitudinal distance but only a left/right flag for lateral.
        # Cars usually pull alongside one at a time, so a car keeps the side it was
        # first seen on while it stays alongside; new overlaps take the free sides.
        free = list(SPOTTER_SIDES.get(lr, []))
        overlapping = [(ad, d, idx) for ad, d, idx in near if ad <= SIDE_BY_SIDE_M]
        # nearest car first, so a car pulling away can't take the slot of the one
        # actually next to me; each keeps its previous side if that's still free
        sides: dict[int, str] = {}
        for _, _, idx in overlapping:  # sorted by |d|
            if not free:
                break
            prev = self.radar_sides.get(idx)
            side = prev if prev in free else free[0]
            sides[idx] = side
            free.remove(side)
        # spotter codes stop at three wide; a 4th overlapping car still must not be
        # drawn through me: put it on an outer lane (its last side, else a free one)
        outer_free = [o for o in ("L2", "R2") if o not in sides.values()]
        for _, d, idx in overlapping:
            if idx in sides or abs(d) > CAR_LENGTH_M or not outer_free:
                continue
            prev = self.radar_sides.get(idx, "")
            want = "L2" if prev.startswith("L") else "R2" if prev.startswith("R") else outer_free[0]
            side = want if want in outer_free else outer_free[0]
            sides[idx] = side
            outer_free.remove(side)
        self.radar_sides = sides
        for ad, d, idx in near:
            out["cars"].append({"id": idx, "d": round(d, 2), "side": sides.get(idx, "C")})
        return out
