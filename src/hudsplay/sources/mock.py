"""Fake race for building the UI without iRacing (works on macOS).

Produces the same telemetry/session-info shape pyirsdk does. Two cars are pinned
near the player so the radar and gap bars always have something to show.
"""

from __future__ import annotations

import math
import random
import time

TRACK_LEN_M = 5793.0  # Monza GP
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

# Monza GP outline in metres (x east, y north), clockwise from the start line.
# Converted from the GeoJSON of bacinger/f1-circuits (circuits/it-1922.geojson):
#   Copyright (c) 2019-2025 Tomislav Bacinger, MIT License
#   https://github.com/bacinger/f1-circuits
MONZA = [
    (-414.3, -487.5), (-377.8, -61.1), (-361.2, 117.6), (-359.4, 124.9), (-354.3, 129.1), (-347.9, 130.1),
    (-340.1, 129.1), (-332.7, 128.5), (-325.8, 129.1), (-321.1, 132.7), (-317.5, 137.9), (-316.5, 142.6),
    (-316.5, 147.8), (-342.4, 245.3), (-346.1, 271.8), (-347.5, 295.8), (-345.6, 321.9), (-335.9, 449),
    (-332.2, 469.8), (-327.6, 489.1), (-320.7, 509.9), (-311.5, 532.3), (-300.9, 554.2), (-285.2, 578.8),
    (-269.1, 599), (-247.4, 622), (-223.9, 642.3), (-197.7, 661), (-169.6, 677.2), (-137.8, 692.9),
    (-106, 703.8), (-70.9, 713.6), (-31.3, 720.5), (9.3, 724.1), (167.3, 737.6), (360.9, 749.1),
    (372.4, 750.1), (378.4, 753.3), (383.4, 758.5), (389.8, 781), (392.6, 787.1), (397.2, 791.3),
    (405.1, 793.9), (431.3, 798.6), (459.9, 804.8), (500.5, 817.9), (681.5, 878.3), (697.2, 882),
    (712, 882), (726.2, 879.3), (736.4, 875.2), (746.1, 869.5), (755.3, 863.2), (766.8, 850.7),
    (773.3, 840.9), (777.8, 828.8), (780.2, 815.3), (788, 729.9), (802.8, 584), (802.3, 570.9),
    (800, 562.5), (796.3, 555.2), (790.3, 550), (779.2, 542.7), (660.8, 479.2), (564.5, 425.6),
    (504.6, 392.7), (475.5, 376), (442.8, 353.2), (419.3, 335.4), (399.1, 317.7), (294, 228),
    (219.4, 160.8), (61.7, 23.3), (-33.2, -59.6), (-46.1, -72.6), (-51.1, -80.9), (-52.1, -89.2),
    (-52.1, -99.2), (-48.8, -121.1), (-47.9, -133), (-47.9, -150.2), (-49.3, -159.6), (-53, -171.6),
    (-58.5, -185.6), (-67.7, -199.8), (-80.2, -214.3), (-94.4, -226.3), (-106, -235.1), (-111.9, -242),
    (-116.5, -251.3), (-120.7, -268.5), (-130.4, -347.2), (-140.5, -431.1), (-218.8, -1183.5), (-222.1, -1210.5),
    (-225.3, -1223.1), (-231.8, -1236.1), (-240.6, -1246.6), (-250.7, -1256), (-264.9, -1265.3), (-280.6, -1271),
    (-298.6, -1274.2), (-313.8, -1273.1), (-328.1, -1270), (-344.7, -1263.7), (-360.8, -1256.4), (-372.8, -1248.1),
    (-387.1, -1237.2), (-403.2, -1219.9), (-414.3, -1204.3), (-423.9, -1187.7), (-432.2, -1167.9), (-440, -1146),
    (-446, -1123.5), (-448.8, -1104.3), (-452, -1075.1), (-452.5, -1045.9), (-452.9, -1018.3), (-454.3, -963.6),
    (-455.3, -915.6), (-454.3, -863.5), (-448.4, -795.3), (-425.8, -579.6),
]


def _build_track(per_m: float = 2.0):
    """Closed polyline through MONZA, resampled and arc-length parametrised to TRACK_LEN_M."""
    pts, n = MONZA, len(MONZA)
    raw = []
    for i in range(n):
        (ax, ay), (bx, by) = pts[i], pts[(i + 1) % n]
        steps = max(1, round(((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5 / per_m))
        raw += [(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps) for k in range(steps)]
    m = len(raw)
    seg = [math.dist(raw[k], raw[(k + 1) % m]) for k in range(m)]
    total = sum(seg)
    scale = TRACK_LEN_M / total
    xs, ys, ss, acc = [], [], [], 0.0
    for k in range(m):
        xs.append(raw[k][0] * scale)
        ys.append(raw[k][1] * scale)
        ss.append(acc / total)
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


# repeats every INCIDENT_CYCLE_S from 5 min in: off-track, contact, spin (+1 then +1 more =
# escalated), off-track. Keeps the incident alert showing up in long runs / the web demo.
INCIDENTS = ((10, 1), (30, 4), (60, 1), (61, 1), (100, 1))
INCIDENT_CYCLE_S = 150


def _incidents(now: float) -> int:
    t = now - 300
    if t < 0:
        return 0
    cycles, at = divmod(t, INCIDENT_CYCLE_S)
    per_cycle = sum(x for _, x in INCIDENTS)
    return int(cycles) * per_cycle + sum(x for s, x in INCIDENTS if at >= s)


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
    focus_check = False  # no sim window to be in front of: never fade the widgets

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
                        # every license class and safety rating level shows up
                        "LicString": f"{'RDCBAP'[i % 6]} {(i * 1.37) % 4.99:.2f}",
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
                "TrackDisplayName": "Autodromo Nazionale Monza",
                "TrackDisplayShortName": "Monza",
                "TrackConfigName": "Grand Prix",
                "WeekendOptions": {
                    "IncidentLimit": 25,
                    "IncidentWarningInitialLimit": 17,
                    "IncidentWarningSubsequentLimit": 4,
                },
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
        # CarLeftRight as real iRacing sends it: 1 clear, 2 right, 3 left, 4 both,
        # 5 two right, 6 two left (see SPOTTER in engine.py)
        if n_left and n_right:
            lr = 4
        elif n_left:
            lr = 3 if n_left == 1 else 6
        elif n_right:
            lr = 2 if n_right == 1 else 5
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
            "PlayerCarMyIncidentCount": _incidents(now),
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
