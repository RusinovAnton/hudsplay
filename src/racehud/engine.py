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

# irsdk_CarLeftRight
SPOTTER = {0: "off", 1: "clear", 2: "left", 3: "right", 4: "both", 5: "left2", 6: "right2"}
# delta reference -> iRacing var (each has a matching *_OK flag). "SessionLastl" is iRacing's typo.
DELTA_VARS = {
    "session_best": ("LapDeltaToSessionBestLap", "session best"),
    "best": ("LapDeltaToBestLap", "best"),
    "optimal": ("LapDeltaToOptimalLap", "optimal"),
    "session_optimal": ("LapDeltaToSessionOptimalLap", "session optimal"),
    "session_last": ("LapDeltaToSessionLastlLap", "last lap"),
}
SPOTTER_SIDES = {2: ["L"], 3: ["R"], 4: ["L", "R"], 5: ["L", "L2"], 6: ["R", "R2"]}


class CarTrack:
    """Continuous lap progress for one car + the session time it reached each bucket."""

    __slots__ = ("progress", "last_pct", "last_bucket", "last_time", "times")

    def __init__(self, laps_completed: int, pct: float, now: float):
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

    def time_at(self, progress: float) -> float | None:
        x = progress * N_BUCKETS
        b = int(x)
        t0 = self.times.get(b)
        t1 = self.times.get(b + 1)
        if t0 is None or t1 is None:
            return t0
        return t0 + (t1 - t0) * (x - b)


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
        self.fuel_capacity: float | None = None
        self.est_lap = 100.0
        self.sessions: dict[int, dict] = {}
        self.multiclass = False
        self.session_num = None
        self.map = TrackMap()
        self._frame = 0
        self._sent_map_version = -1
        self._reset()

    def _reset(self):
        self.tracks: dict[int, CarTrack] = {}
        self.fuel = FuelCalc()
        self.trends: dict[int, dict[int, float]] = {}
        self.radar_sides: dict[int, str] = {}
        self.start_pos: int | None = None
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
                # TODO(windows): verify flair field name with `uv run racehud --dump`
                "cc": to_iso(d.get("FlairName")),
            }
        self.multiclass = len({d["cls"] for d in self.drivers.values()}) > 1
        wi = info.get("WeekendInfo") or {}
        track_len = _track_length_m(wi.get("TrackLength"))
        if track_len != self.track_len:
            self.track_len = track_len
            self.paint.reset(track_len)
        track_id = wi.get("TrackID")
        self.map.set_track(f"{track_id}-{wi.get('TrackConfigName') or 'default'}" if track_id is not None else None)
        self.sessions = {
            s.get("SessionNum"): {
                "type": s.get("SessionType", ""),
                "laps": _laps_from_info(s.get("SessionLaps")),
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

        session, laps_to_go = self._session(t, me)
        standings, ahead, behind, pos, cars = self._standings(t, me, now, session["race"])
        session["pos"], session["cars"] = pos, cars
        session["multiclass"] = self.multiclass
        # grid position: first position seen once parade laps / racing start
        # (irsdk_SessionState 3 = parade laps, 4 = racing)
        if session["race"] and self.start_pos is None and pos > 0 and t.get("SessionState") in (3, 4):
            self.start_pos = pos
        session["startPos"] = self.start_pos
        delta = self._delta(t)

        return {
            "connected": True,
            "session": session,
            "relative": standings,
            "fuel": self._fuel(t, me, laps_to_go),
            "delta": {
                "best": _r(delta),
                "ref": DELTA_VARS.get(self.cfg.delta_reference, DELTA_VARS["session_best"])[1],
                "ahead": self._rival(ahead, me, now, True, laps_to_go),
                "behind": self._rival(behind, me, now, False, laps_to_go),
            },
            "radar": self._radar(t, me),
            "map": self._map(t, me, now, delta, ahead, behind),
        }

    def _delta(self, t: dict) -> float | None:
        var = DELTA_VARS.get(self.cfg.delta_reference, DELTA_VARS["session_best"])[0]
        return t.get(var) if t.get(var + "_OK") else None

    def _map(self, t: dict, me: int, now: float, delta, ahead, behind) -> dict:
        pcts = t.get("CarIdxLapDistPct") or []
        done = t.get("CarIdxLapCompleted") or []
        pct = pcts[me] if me < len(pcts) else -1
        laps_done = done[me] if me < len(done) else 0
        clean = bool(t.get("IsOnTrack", True)) and not t.get("OnPitRoad")
        self.map.update(now, pct, laps_done, t.get("Speed"), t.get("YawNorth"), clean)
        self.paint.update(pct, laps_done, delta if clean else None)

        on_pit = t.get("CarIdxOnPitRoad") or []
        # [pct, kind]: 0 car, 1 me, 2 in pit, 3 rival ahead, 4 rival behind
        cars = []
        for idx in self.tracks:
            kind = 1 if idx == me else 3 if idx == ahead else 4 if idx == behind else 0
            if kind == 0 and idx < len(on_pit) and on_pit[idx]:
                kind = 2
            cars.append([round(pcts[idx], 4), kind])

        out = {
            "version": self.map.version,
            "mirror": self.cfg.map_mirror,
            "recording": self.map.recording_pct,
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
        for idx in self.drivers:
            pct = pcts[idx] if idx < len(pcts) else -1
            if pct is None or pct < 0:  # not in world (garage, disconnected)
                self.tracks.pop(idx, None)
                continue
            tr = self.tracks.get(idx)
            if tr is None:
                self.tracks[idx] = CarTrack(max(laps[idx], 0), pct, now)
            else:
                tr.advance(pct, now)

    def _time_gap(self, ahead: CarTrack, behind: CarTrack, now: float) -> float:
        """Seconds since `ahead` was where `behind` is now."""
        t = ahead.time_at(behind.progress)
        if t is None:
            return (ahead.progress - behind.progress) * self.est_lap
        return now - t

    def _gap(self, a: int, b: int, now: float) -> tuple[float | None, int]:
        """Seconds car a is ahead of car b (negative if behind) + whole laps between."""
        A, B = self.tracks.get(a), self.tracks.get(b)
        if A is None or B is None:
            return None, 0
        diff = A.progress - B.progress
        laps = int(diff)  # truncates toward zero
        if diff >= 0:
            return self._time_gap(A, B, now), laps
        return -self._time_gap(B, A, now), laps

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

        total, estimated, to_go = None, False, None
        if 0 < total_laps < UNLIMITED_LAPS:
            total = total_laps
            to_go = total - my.progress if my else None
        elif remain is not None and my:
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

    def _standings(self, t: dict, me: int, now: float, race: bool):
        """Race order around me: rivals for the delta widgets, my position, relative rows."""
        class_only = self.cfg.standings_class_only
        positions = t.get("CarIdxClassPosition" if class_only else "CarIdxPosition") or []
        my_cls = self.drivers.get(me, {}).get("cls")

        entries = []
        for idx, d in self.drivers.items():
            if class_only and d["cls"] != my_cls:
                continue
            p = positions[idx] if idx < len(positions) else 0
            if p <= 0 and idx not in self.tracks and idx != me:
                continue
            entries.append((p if p > 0 else 999, idx, p))
        entries.sort()
        order = [idx for _, idx, _ in entries]
        if me not in order:
            return [], None, None, 0, len(order)

        i = order.index(me)
        ahead = order[i - 1] if i > 0 else None
        behind = order[i + 1] if i + 1 < len(order) else None
        my_pos = next(p for _, idx, p in entries if idx == me)
        return self._relative(t, me, now, race, positions), ahead, behind, my_pos, len(order)

    def _relative(self, t: dict, me: int, now: float, race: bool, positions: list) -> list[dict]:
        """Cars nearest to me on track (any class, lapped or not), nearest-first each side."""
        my = self.tracks.get(me)
        if my is None:
            return []
        pcts = t.get("CarIdxLapDistPct") or []
        bests = t.get("CarIdxBestLapTime") or []
        on_pit = t.get("CarIdxOnPitRoad") or []
        talking = t.get("RadioTransmitCarIdx", -1)  # -1 = nobody on the radio

        def best(idx):
            v = bests[idx] if idx < len(bests) else -1
            return v if v and v > 0 else None

        class_best: dict = {}
        for idx, d in self.drivers.items():
            b = best(idx)
            if b and (d["cls"] not in class_best or b < class_best[d["cls"]]):
                class_best[d["cls"]] = b

        ahead, behind = [], []
        for idx, tr in self.tracks.items():
            if idx == me:
                continue
            dp = pcts[idx] - pcts[me]
            dp -= round(dp)  # track distance in laps, (-0.5, 0.5], + = ahead on track
            (ahead if dp > 0 else behind).append((abs(dp), dp, idx, tr))
        n = self.cfg.standings_each_side
        ahead = sorted(ahead)[:n]
        behind = sorted(behind)[:n]

        def row(idx, dp, tr):
            d = self.drivers[idx]
            b = best(idx)
            gap, lap_rel = None, 0
            if idx != me:
                if dp > 0:  # they passed my current spot dp laps ago
                    t_then = tr.time_at(tr.progress - dp)
                    gap = -(now - t_then if t_then is not None else dp * self.est_lap)
                else:  # I was where they are now
                    t_then = my.time_at(my.progress + dp)
                    gap = now - t_then if t_then is not None else -dp * self.est_lap
                if race:
                    # whole laps between us in race distance: +1 = they're a lap up on me
                    lap_rel = round(tr.progress - my.progress - dp)
            p = positions[idx] if idx < len(positions) else 0
            return {
                "id": idx,
                "pos": p,
                "num": d["num"],
                "name": d["name"],
                "cc": d["cc"],
                "best": _r(b),
                "bestIsClassBest": b is not None and b == class_best.get(d["cls"]),
                "cls": d["clsName"],
                "clsColor": d["clsColor"],
                "gap": _r(gap),
                "lapRel": lap_rel,
                "isMe": idx == me,
                "inPit": bool(on_pit[idx]) if idx < len(on_pit) else False,
                "radio": idx == talking,
            }

        rows = [row(idx, dp, tr) for _, dp, idx, tr in reversed(ahead)]
        rows.append(row(me, 0.0, my))
        rows += [row(idx, dp, tr) for _, dp, idx, tr in behind]
        return rows

    def _rival(self, idx: int | None, me: int, now: float, is_ahead: bool, laps_to_go: float | None = None):
        """Gap to the car one position ahead/behind, how it changed vs one lap ago,
        and how many laps until the gap closes at that rate.

        trend < 0 is always good for the player (like the lap delta bar).
        """
        if idx is None:
            return None
        g, laps = self._gap(idx, me, now)
        my = self.tracks.get(me)
        if g is None or my is None:
            return None
        # history per car (signed gap, + = they're ahead), keyed by my absolute track bucket
        hist = self.trends.setdefault(idx, {})
        ab = int(my.progress * TREND_BUCKETS)
        hist.setdefault(ab, g)
        # gap at this spot one lap ago; until a lap of history exists, the oldest gap we have
        prev = hist.get(ab - TREND_BUCKETS)
        span = 1.0  # laps of history behind `prev`
        if prev is None:
            first_key, prev = next(iter(hist.items()))
            span = (ab - first_key) / TREND_BUCKETS
        if len(hist) > 3 * TREND_BUCKETS:
            self.trends[idx] = {k: v for k, v in hist.items() if k >= ab - 2 * TREND_BUCKETS}
        # ahead: gap shrinking -> g falls -> negative. behind: they close -> g rises -> positive.
        trend = g - prev if prev is not None else None
        gap = g if is_ahead else -g
        # closing speed in s/lap (> 0 = gap shrinking); needs >= 0.1 lap of history
        closing = None
        if trend is not None and span >= 0.1:
            closing = (-trend if is_ahead else trend) / span
        catch = gap / closing if closing and closing > 0.005 and gap > 0 and not laps else None
        d = self.drivers[idx]
        return {
            "num": d["num"],
            "name": d["name"],
            "gap": _r(gap),
            "laps": abs(laps),
            "trend": _r(trend),
            "closing": _r(closing),
            "catchLaps": _r(catch, 1),
            "catchAfterFlag": bool(catch is not None and laps_to_go is not None and catch > laps_to_go),
        }

    def _fuel(self, t: dict, me: int, laps_to_go: float | None) -> dict:
        level = t.get("FuelLevel")
        done = t.get("CarIdxLapCompleted") or []
        self.fuel.update(done[me] if me < len(done) else None, level, bool(t.get("OnPitRoad")))
        per_lap = self.fuel.per_lap
        laps_left = level / per_lap if level is not None and per_lap else None
        to_finish = laps_to_go * per_lap - level if per_lap and laps_to_go is not None and level is not None else None
        return {
            "level": _r(level, 2),
            "capacity": _r(self.fuel_capacity, 2),
            "perLap": _r(per_lap),
            "lapsLeft": _r(laps_left, 2),
            "toFinish": _r(to_finish, 2),
        }

    def _radar(self, t: dict, me: int) -> dict:
        rng = self.cfg.radar_range_m
        lr = t.get("CarLeftRight") or 0
        out = {"range": rng, "cars": [], "spotter": SPOTTER.get(lr, "off")}
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
