"""Fake race for building the UI without iRacing (works on macOS).

Produces the same telemetry/session-info shape pyirsdk does. Two cars are pinned
near the player so the radar and gap bars always have something to show.
"""

from __future__ import annotations

import math
import random
import time

TRACK_LEN_M = 4000.0
BASE_LAP = 95.0
RACE_LEN_S = 45 * 60
PLAYER = 7
RADAR_LEFT = 6  # oscillates alongside on the left
RADAR_RIGHT = 8  # hovers just behind on the right
RADAR_LEFT2 = 9  # second car on the left: when it overlaps with RADAR_LEFT -> three wide
GT4 = {14, 15, 16, 17, 18}  # second, slower class -> multiclass relative
BACKMARKER = 19  # lapped car the player catches -> relative "lap down" color
PINNED = {RADAR_LEFT: "L", RADAR_LEFT2: "L", RADAR_RIGHT: "R"}
MAX_CARS = 64

def _build_track(n: int = 2000):
    """Closed blob-shaped circuit, arc-length parametrised to TRACK_LEN_M."""
    raw = []
    for k in range(n):
        th = 2 * math.pi * k / n
        r = 1 + 0.25 * math.cos(3 * th) + 0.1 * math.sin(2 * th)
        raw.append((r * math.cos(th), 0.7 * r * math.sin(th)))
    seg = [math.dist(raw[k], raw[(k + 1) % n]) for k in range(n)]
    scale = TRACK_LEN_M / sum(seg)
    xs, ys, ss, acc = [], [], [], 0.0
    for k in range(n):
        xs.append(raw[k][0] * scale)
        ys.append(raw[k][1] * scale)
        ss.append(acc / (sum(seg)))
        acc += seg[k]
    return ss, xs, ys


TRACK_S, TRACK_X, TRACK_Y = _build_track()


def _track_pos(pct: float) -> tuple[float, float]:
    import bisect

    pct %= 1
    i = bisect.bisect_right(TRACK_S, pct) - 1
    j = (i + 1) % len(TRACK_S)
    s0, s1 = TRACK_S[i], TRACK_S[j] if j else 1.0
    f = (pct - s0) / (s1 - s0) if s1 > s0 else 0.0
    return TRACK_X[i] + (TRACK_X[j] - TRACK_X[i]) * f, TRACK_Y[i] + (TRACK_Y[j] - TRACK_Y[i]) * f


def _yaw_north(pct: float) -> float:
    """Compass heading from north, clockwise positive (like iRacing, see TrackMap)."""
    x0, y0 = _track_pos(pct - 0.0005)
    x1, y1 = _track_pos(pct + 0.0005)
    return math.atan2(x1 - x0, y1 - y0)


DRIVERS = [
    ("Lena Hartmann", "Germany", 12),
    ("Tomás Ferreira", "Portugal", 7),
    ("Kenji Arakawa", "Japan", 31),
    ("Oliver Brandt", "Denmark", 4),
    ("Sofia Marchetti", "Italy", 88),
    ("Jack O'Neill", "Ireland", 21),
    ("Mateo Ruiz", "Spain", 55),
    ("You Driver", "Ukraine", 42),
    ("Emma Laurent", "France", 3),
    ("Lucas Nowak", "Poland", 19),
    ("Aiden Clarke", "United Kingdom", 66),
    ("Noah Becker", "Austria", 9),
    ("Isla Murray", "Australia", 27),
    ("Ethan Walsh", "United States", 14),
    ("Mila Novak", "Czechia", 73),
    ("Arvid Lund", "Sweden", 5),
    ("Rafael Costa", "Brazil", 11),
    ("Hugo Janssen", "Netherlands", 23),
    ("Leo Virtanen", "Finland", 8),
    ("Chloe Martin", "Canada", 99),
]


class MockSource:
    def __init__(self, seed: int = 1):
        rng = random.Random(seed)
        self.rng = rng
        n = len(DRIVERS)
        self.pace = [1 + rng.uniform(-0.012, 0.02) for _ in range(n)]
        for i in GT4:
            self.pace[i] = 1.07 + rng.uniform(0, 0.02)
        self.pace[PLAYER] = 1.0
        self.prog = [3.0 - i * 0.012 for i in range(n)]  # 3 laps in, single file
        # GT4s: two just ahead on the same lap (player catches them), rest a lap down
        gt4 = sorted(GT4)
        self.prog[gt4[0]] = self.prog[PLAYER] + 0.006
        self.prog[gt4[1]] = self.prog[PLAYER] + 0.015
        for k, i in enumerate(gt4[2:]):
            self.prog[i] = self.prog[PLAYER] - 1 + 0.03 + 0.25 * k
        # backmarker: a lap down, just ahead of the player on track, slower
        self.prog[BACKMARKER] = self.prog[PLAYER] - 1 + 0.004
        self.pace[BACKMARKER] = 1.08
        self.last_cross = [None] * n
        self.last_lap = [-1.0] * n
        # pretend a few laps already happened so best laps are filled in
        self.best_lap = [BASE_LAP * pc + rng.uniform(0.2, 1.2) for pc in self.pace]
        self.fuel = 52.0
        self.t0 = time.monotonic()
        self.prev_now: float | None = None
        self.info = {
            "DriverInfo": {
                "DriverCarIdx": PLAYER,
                "DriverCarFuelMaxLtr": 60.0,
                "DriverCarEstLapTime": BASE_LAP,
                "Drivers": [
                    {
                        "CarIdx": i,
                        "UserName": name,
                        "CarNumber": str(num),
                        "CarClassID": 2 if i in GT4 else 1,
                        "CarClassShortName": "GT4" if i in GT4 else "GT3",
                        "CarClassColor": 0x53FF77 if i in GT4 else 0xFFDA59,
                        "FlairName": country,
                        "IRating": 900 + (i * 733) % 3600,
                        "CarIsPaceCar": 0,
                        "IsSpectator": 0,
                    }
                    for i, (name, country, num) in enumerate(DRIVERS)
                ],
            },
            "SplitTimeInfo": {
                "Sectors": [
                    {"SectorNum": 0, "SectorStartPct": 0.0},
                    {"SectorNum": 1, "SectorStartPct": 0.33},
                    {"SectorNum": 2, "SectorStartPct": 0.67},
                ]
            },
            "WeekendInfo": {
                "TrackLength": f"{TRACK_LEN_M / 1000:.2f} km",
                "TrackID": 0,
                "TrackDisplayName": "Mock Raceway",
                "TrackDisplayShortName": "Mock",
                "TrackConfigName": "mock",
            },
            "SessionInfo": {
                "Sessions": [{"SessionNum": 0, "SessionType": "Race", "SessionLaps": "unlimited"}]
            },
        }

    @staticmethod
    def _speed(prog: float) -> float:
        # same "corners" for everyone: speed varies 3x per lap
        return 1 + 0.22 * math.sin(2 * math.pi * (prog % 1) * 3)

    def read(self):
        now = time.monotonic() - self.t0 + 300.0  # pretend 5 min into the session
        dt = 0.0 if self.prev_now is None else min(now - self.prev_now, 0.5)
        self.prev_now = now
        n = len(DRIVERS)
        old = list(self.prog)

        for i in range(n):
            if i in PINNED:
                continue
            noise = 1 + self.rng.uniform(-0.01, 0.01)
            self.prog[i] += dt / (BASE_LAP * self.pace[i]) * self._speed(self.prog[i]) * noise
        p = self.prog[PLAYER]
        self.prog[RADAR_LEFT] = p + 0.0035 * math.sin(now / 8)
        self.prog[RADAR_RIGHT] = p - 0.004 + 0.004 * math.sin(now / 11 + 1)
        self.prog[RADAR_LEFT2] = p - 0.003 + 0.0035 * math.sin(now / 7 + 2)

        for i in range(n):
            if math.floor(self.prog[i]) > math.floor(old[i]) and dt > 0:
                if self.last_cross[i] is not None:
                    lap = now - self.last_cross[i]
                    self.last_lap[i] = lap
                    if self.best_lap[i] < 0 or lap < self.best_lap[i]:
                        self.best_lap[i] = lap
                self.last_cross[i] = now

        self.fuel = max(0.0, self.fuel - dt * 2.7 / BASE_LAP * self._speed(p))

        order = sorted(range(n), key=lambda i: -self.prog[i])
        position = [0] * MAX_CARS
        for rank, i in enumerate(order, 1):
            position[i] = rank
        class_position = [0] * MAX_CARS
        for group in ([i for i in order if i not in GT4], [i for i in order if i in GT4]):
            for rank, i in enumerate(group, 1):
                class_position[i] = rank

        def pad(values, fill):
            return list(values) + [fill] * (MAX_CARS - len(values))

        # every car has a lane (pinned ones fixed, others alternate) so passes and
        # lappings come by on a side, like the real spotter reports them
        alongside = []
        for i in range(n):
            if i == PLAYER:
                continue
            d = (self.prog[i] - p + 0.5) % 1 - 0.5  # wrapped track distance in laps
            if abs(d) * TRACK_LEN_M < 4.8:
                alongside.append(PINNED.get(i, "L" if i % 2 == 0 else "R"))
        n_left, n_right = alongside.count("L"), alongside.count("R")
        # irsdk_CarLeftRight: 1 clear, 2 left, 3 right, 4 both, 5 two left, 6 two right
        if n_left and n_right:
            lr = 4
        elif n_left:
            lr = 2 if n_left == 1 else 5
        elif n_right:
            lr = 3 if n_right == 1 else 6
        else:
            lr = 1

        pct_p = p % 1
        # lap delta: 0 at the line, different shape each lap -> map paint changes per lap
        lap_rng = random.Random(math.floor(p))
        # corner-by-corner: slow drift + medium + fast wiggles, all 0 at the line
        w = 2 * math.pi * pct_p
        shape = ((1, 0.25), (3, 0.12), (7, 0.06), (13, 0.035), (23, 0.02))
        delta = sum(lap_rng.uniform(-amp, amp) * math.sin(k * w) for k, amp in shape)
        last_rng = random.Random(math.floor(p) + 10_000)
        delta_last = sum(last_rng.uniform(-amp, amp) * math.sin(k * w) for k, amp in shape)
        speed = (p - old[PLAYER]) * TRACK_LEN_M / dt if dt > 0 else 0.0
        telemetry = {
            "Speed": speed,
            "YawNorth": _yaw_north(pct_p),
            "SessionTime": now,
            "SessionNum": 0,
            "SessionState": 4,  # racing
            "SessionTimeRemain": max(0.0, RACE_LEN_S - now),
            "SessionLapsTotal": 32767,
            "PlayerCarIdx": PLAYER,
            # off-track, contact, spin (+1 then +1 more = escalated), off-track
            "PlayerCarMyIncidentCount": sum(x for at, x in ((310, 1), (330, 4), (360, 1), (361, 1), (400, 1)) if now >= at),
            "IsOnTrack": True,
            "OnPitRoad": False,
            "FuelLevel": self.fuel,
            "LapDeltaToSessionBestLap": delta,
            "LapDeltaToSessionBestLap_OK": True,
            "LapDeltaToSessionLastlLap": delta_last,
            "LapDeltaToSessionLastlLap_OK": p >= 1,
            "CarLeftRight": lr,
            "CarIdxLapCompleted": pad([math.floor(x) for x in self.prog], -1),
            "CarIdxLapDistPct": pad([x % 1 for x in self.prog], -1.0),
            "CarIdxPosition": position,
            "CarIdxClassPosition": class_position,
            "CarIdxBestLapTime": pad(self.best_lap, -1.0),
            "CarIdxLastLapTime": pad(self.last_lap, -1.0),
            "LapLastLapTime": self.last_lap[PLAYER],
            "LapBestLapTime": self.best_lap[PLAYER],
            "CarIdxOnPitRoad": pad([False] * n, False),
            # a car near the player talks for 3 s every 10 s
            "RadioTransmitCarIdx": (RADAR_RIGHT, -1, -1, RADAR_LEFT, -1, PLAYER, -1)[int(now // 10) % 7]
            if now % 10 < 3
            else -1,
        }
        return telemetry, self.info
