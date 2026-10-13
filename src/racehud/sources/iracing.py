"""Live iRacing data via pyirsdk (Windows only, iRacing must be running)."""

from __future__ import annotations

import time

TELEMETRY_VARS = (
    "SessionTime",
    "SessionNum",
    "SessionState",
    "SessionTimeRemain",
    "SessionLapsTotal",
    "PlayerCarIdx",
    "IsOnTrack",
    "OnPitRoad",
    "FuelLevel",
    "LapDeltaToSessionBestLap",
    "LapDeltaToSessionBestLap_OK",
    "LapDeltaToBestLap",
    "LapDeltaToBestLap_OK",
    "LapDeltaToOptimalLap",
    "LapDeltaToOptimalLap_OK",
    "LapDeltaToSessionOptimalLap",
    "LapDeltaToSessionOptimalLap_OK",
    "LapDeltaToSessionLastlLap",
    "LapDeltaToSessionLastlLap_OK",
    "Speed",
    "YawNorth",
    "CarLeftRight",
    "CarIdxLapCompleted",
    "CarIdxLapDistPct",
    "CarIdxPosition",
    "CarIdxClassPosition",
    "CarIdxBestLapTime",
    "CarIdxLastLapTime",
    "CarIdxOnPitRoad",
    "RadioTransmitCarIdx",
)
INFO_KEYS = ("DriverInfo", "WeekendInfo", "SessionInfo")


class IRacingSource:
    def __init__(self):
        import irsdk

        self.ir = irsdk.IRSDK()
        self.connected = False
        self.info: dict = {}
        self._info_updates: dict[str, int] = {}
        self._next_attempt = 0.0

    def _check_connection(self) -> bool:
        ir = self.ir
        if self.connected and not (ir.is_initialized and ir.is_connected):
            ir.shutdown()
            self.connected = False
            self._info_updates.clear()
        if not self.connected and time.monotonic() >= self._next_attempt:
            self._next_attempt = time.monotonic() + 1.0
            self.connected = bool(ir.startup()) and ir.is_initialized and ir.is_connected
        return self.connected

    def read(self):
        if not self._check_connection():
            return None
        ir = self.ir
        ir.freeze_var_buffer_latest()
        telemetry = {name: ir[name] for name in TELEMETRY_VARS}

        changed = False
        for key in INFO_KEYS:
            update = ir.get_session_info_update_by_key(key)
            if update != self._info_updates.get(key):
                self._info_updates[key] = update
                changed = True
        if changed:
            self.info = {key: ir[key] or {} for key in INFO_KEYS}
        return telemetry, self.info


def dump(path: str = "dump") -> None:
    """Write session info YAML + one telemetry frame to disk for inspection."""
    import os

    import irsdk

    ir = irsdk.IRSDK()
    if not ir.startup():
        raise SystemExit("iRacing not running (or not in a session)")
    os.makedirs(path, exist_ok=True)
    out = os.path.join(path, "irsdk_dump.txt")
    ir.parse_to(out)
    print(f"wrote {out}")
