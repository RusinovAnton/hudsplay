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
- ▲/▼ widgets: gap + proximity bar + debounced status line ("catching in N laps").
  Ahead "+", behind "-". Color is ALWAYS the global ahead/behind color; gaining vs
  losing only changes saturation (full color = gaining, washed to --c-fg gray = losing).
  Relative widget still uses iRacing's convention: ahead "-", behind "+".
- Delta bars: color = sign (green good / red bad), intensity = direction
  (bright while |delta| grows, faded while it shrinks).
- Python is managed by uv only (`uv run`, `uv sync`); never system Python or `python -m venv`.

## Packaging

`build-installer.bat` → PyInstaller `racehud-backend.exe` (entry `packaging/backend.py`,
frontend bundled as data) + electron-builder NSIS installer (`electron/package.json`
"build", `electron/assets/installer.nsh`). Installed Electron spawns/kills the backend
itself and shows a tray icon; dev (`start.bat`) is unchanged. Paths: `config.ROOT` =
read-only app files, `config.DATA` = user files (repo root in dev,
`%APPDATA%\racehud\data` when frozen). `%APPDATA%\racehud` is Electron's profile
(layout/colors in localStorage). Don't write user files under ROOT.

## Website

Landing page in `docs/` (GitHub Pages from `default` → `/docs`, https://rusinovanton.github.io/racehud/).
Plain HTML/CSS, editor look, no build step. Screenshots + social card come from
`uv run python packaging/capture_screenshots.py` (mock race via headless Chrome/Edge,
also stamps image sizes into `docs/index.html`); rerun it after UI changes. The mock
track is the real Monza outline (bacinger/f1-circuits, MIT, attribution in `mock.py`).
Owner: no "clever" code-snippet jokes on the site.

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

Map has a follow mode (edit mode -> select map -> "follow me" + "follow range"):
centred on me, rotated heading-up, paint drawn uncached for visible pieces only.
Session "pos" is colored vs grid position (recorded at SessionState 3/4): green
gained, red lost, stronger with more places.

Relative: position badge (class color in multiclass), class tag or +1L/-1L tag,
radio icon from RadioTransmitCarIdx, iRating as "1.2k" (DriverInfo IRating; blank when
0/1, i.e. offline/AI).

Edit mode: click selects a widget -> panel sliders for its size, card background
opacity and whole-widget opacity (per widget, saved with position in localStorage).
Drag = move, mouse wheel = resize. Radar also has "view range" in metres (what's drawn)
and "show ahead" / "show behind" (bumper gap, default 2 m / 3 m): it shows only while a
car is that close or alongside.
Relative rows slide when order changes. Radar glow flashes at ~6 Hz when three wide.

Laps widget: last lap (LapLastLapTime, green when it's my best) + optimal lap, computed
in `OptimalLap` (best time per SplitTimeInfo sector over clean laps, summed).

Relative widget = cars nearest on track (any class), first column = race position
(ranked live by track progress while racing; CarIdxPosition only updates at timing
lines), lap-up/lap-down cars colored. The ▲/▼ delta widgets = nearest car ahead /
behind on track (any class, any lap, same gap timing as the relative; cars on pit
road skipped unless I'm on it), tagged +1L/-1L or class. Hidden in qualifying.
In practice + qualifying the relative becomes "standings": every car with a time (best
lap from live, session ResultsPositions or remembered, so pit/garage/disconnected cars
stay), window around me, gap = their best - mine. Radar hidden in qualifying.
Race: no laps-total estimate before SessionState 4 (gridding, pace laps).

**Not yet verified against real iRacing.** First Windows session checklist:

1. `uv sync`, then `uv run racehud --dump` while in a session. Check in `dump/irsdk_dump.txt`:
   - Driver country field. The engine reads `DriverInfo.Drivers[].FlairName`
     (`engine.py`, `_load_info`). The real key name is a guess. Fix it if different.
   - `SessionLapsTotal` exists as a telemetry var (fallback: `SessionInfo.Sessions[].SessionLaps`).
   - `LapDeltaToSessionBestLap` behaves as expected (own best this session).
2. `start.bat`, iRacing in borderless windowed mode. Check transparency, click-through,
   always-on-top, and Ctrl+Shift+O edit mode.
3. Confirm ~60 Hz updates (Windows timer resolution is raised via `timeBeginPeriod(1)` in `__main__.py`).
4. Track map: drive one clean lap, check `maps/*.json` appears. YawNorth sign verified
   2026-10-14 (compass heading, clockwise positive; Navarra was mirrored before the fix).
5. Radar in a real pack: side assignment comes from `CarLeftRight` and the nearest
   overlapping cars. The lateral distance itself isn't in the SDK.

## Ideas backlog (owner picks)

- Pit fuel: exact litres to add at the stop, auto-filled into the iRacing pit macro
- Multiclass: faster-class car approaching warning (time to catch)
- Incidents counter vs limit
