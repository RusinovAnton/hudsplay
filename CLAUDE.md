# racehud: notes for Claude

racehud: personal iRacing HUD overlay. Built on macOS against mock data, continued on the
Windows sim PC with real iRacing. See README.md for architecture and run commands.

## Owner preferences

- Minimal, VS Code Dark+ look, Fira Code, `// title` comment-style headers.
- Every data type gets its own color variable (`frontend/theme.css`), editable live in edit mode.
- Ahead/behind is ONE global color pair (`--c-ahead` red, `--c-behind` green) used by
  relative gaps, ▲/▼, map rival dots and radar (dimmed). Don't add per-widget copies.
- Color-blind palettes (edit mode buttons, `PALETTES` in app.js) must cover every
  red/green var: good/bad, ahead/behind, radar-danger, lap-up/down.
- No pedal/input widget.
- Arrows ▲/▼ instead of the words "ahead"/"behind" in the UI.
- ▲/▼ widgets: gap only (no trend number), ahead "+", behind "-", gap text and
  bar colored green/red by gaining/losing vs one lap ago. (Relative widget still
  uses iRacing's convention: ahead "-", behind "+".)
- Delta bars: color = sign (green good / red bad), intensity = direction
  (bright while |delta| grows, faded while it shrinks).
- Python is managed by uv only (`uv run`, `uv sync`); never system Python or `python -m venv`.

## Rules

- All derived logic lives in `src/racehud/engine.py`. Sources only read raw
  values in iRacing SDK var names. Keep `sources/mock.py` producing the same
  shape so `uv run racehud --mock` stays a working UI dev loop.
- The engine runs at 60 Hz, so no YAML parsing or heavy work per frame. Session info is
  re-read only when its update counter changes (`sources/iracing.py`).
- The pump loop in `server.py` must never crash mid-race. Exceptions are logged and the loop continues.

## Status (2026-10-13)

Verified on macOS with mock data: session (pos + lap), relative, fuel, 4 delta
widgets (best / ▲ / ▼ / closest, closest hidden by default, toggle in edit mode)
and radar (incl. three-wide) render. Gaps, trend, fuel, laps estimate and radar
compute correctly from fake telemetry.

Map widget: shape recorded on the first clean lap per track (Speed + YawNorth
dead-reckoning, `trackmap.py`), cached in `maps/<TrackID>-<config>.json`. Painted
every ~10 m green/red by delta gained/lost vs `delta_reference` (same reference as
the delta bar). Car dots from lap %.

Edit mode: click selects a widget -> panel sliders for its size, card background
opacity and whole-widget opacity (per widget, saved with position in localStorage).
Drag = move, mouse wheel = resize. Radar also has "view range" in metres: it shows only
while a car is inside that range or alongside.
Relative rows slide when order changes. Radar glow flashes at ~6 Hz when three wide.

Relative widget = cars nearest on track (any class), first column = race position,
lap-up/lap-down cars colored. The ▲/▼ delta widgets use race-position rivals
(same class), not track neighbours.

**Not yet verified against real iRacing.** First Windows session checklist:

1. `uv sync`, then `uv run racehud --dump` while in a session. Check in `dump/irsdk_dump.txt`:
   - Driver country field. The engine reads `DriverInfo.Drivers[].FlairName`
     (`engine.py`, `_load_info`). The real key name is a guess. Fix it if different.
   - `SessionLapsTotal` exists as a telemetry var (fallback: `SessionInfo.Sessions[].SessionLaps`).
   - `LapDeltaToSessionBestLap` behaves as expected (own best this session).
2. `start.bat`, iRacing in borderless windowed mode. Check transparency, click-through,
   always-on-top, and Ctrl+Shift+O edit mode.
3. Confirm ~60 Hz updates (Windows timer resolution is raised via `timeBeginPeriod(1)` in `__main__.py`).
4. Track map: drive one clean lap, check `maps/*.json` appears and the shape is not
   mirrored (YawNorth sign convention is a guess). If mirrored: `map_mirror = true`
   in config.toml, or better fix the sign in `TrackMap.update`.
5. Radar in a real pack: side assignment comes from `CarLeftRight` and the nearest
   overlapping cars. The lateral distance itself isn't in the SDK.

## Ideas backlog (owner picks)

- Pit fuel: exact litres to add at the stop, auto-filled into the iRacing pit macro
- Multiclass: faster-class car approaching warning (time to catch)
- Incidents counter vs limit
