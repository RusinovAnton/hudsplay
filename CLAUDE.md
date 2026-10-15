# HUDsplay: notes for Claude

HUDsplay: personal iRacing HUD overlay. Built on macOS against mock data, continued on the
Windows sim PC with real iRacing. See README.md for architecture and run commands.

## Owner preferences

- Minimal, VS Code Dark+ look, Fira Code, `// title` comment-style headers.
- Every data type gets its own color variable (`frontend/theme.css`), editable live in edit mode.
- Ahead/behind is ONE global color pair (`--c-ahead` red, `--c-behind` green) used by
  relative gaps, ▲/▼ and radar (dimmed). Don't add per-widget copies.
- Map car dots: class color (pit = muted), lap-up / lap-down cars get a --c-lap-up red /
  --c-lap-down blue ring. No ahead/behind coloring on the map.
- Color themes: presets after popular VS Code themes (`THEMES` in app.js, Dark+ default =
  `theme.css`), picked first in edit mode -> colors; custom colors are saved per theme
  (localStorage `overlay.colors.v2`), "reset colors" drops them for the current theme.
  Every theme uses its most vivid red/green for gain/loss.
- Color-blind palettes (edit mode buttons, `PALETTES` in app.js) must cover every
  red/green var: good/bad, ahead/behind, radar-danger, lap-up/down.
- Widgets fade out in replay (`IsReplayPlaying`) and while iRacing isn't the foreground
  window (`focus.py`, checked by the server); edit mode always shows them.
- No pedal/input widget.
- Arrows ▲/▼ instead of the words "ahead"/"behind" in the UI.
- ▲/▼ widgets: gap + proximity bar + debounced status line ("catching in N laps").
  Ahead "+", behind "-". Color is ALWAYS the global ahead/behind color; gaining vs
  losing only changes saturation (full color = gaining, washed to --c-fg gray = losing).
  Relative widget still uses iRacing's convention: ahead "-", behind "+".
- Delta bar: side = sign, color = direction right now (green while the delta falls, even
  when still +; red while it rises, even when still -), intensity = rate of change.
  The delta number stays colored by sign, its intensity = rate of change too.
- Python is managed by uv only (`uv run`, `uv sync`); never system Python or `python -m venv`.

## Packaging

`build-installer.bat` → PyInstaller `hudsplay-backend.exe` (entry `packaging/backend.py`,
frontend bundled as data) + electron-builder NSIS installer (`electron/package.json`
"build", `electron/assets/installer.nsh`). Installed Electron spawns/kills the backend
itself and shows a tray icon; dev (`start.bat`) is unchanged.
Renamed from racehud (name taken) on 2026-10-15; installed Electron copies
`%APPDATA%\racehud` to the new profile once on first start (`electron/main.js`).
Code signing: SignPath is wired in `release.yml` but not registered yet, so the README
and site must not claim signed builds or show a code signing policy until it is. Paths: `config.ROOT` =
read-only app files, `config.DATA` = user files (repo root in dev,
`%APPDATA%\HUDsplay\data` when frozen). `%APPDATA%\HUDsplay` is Electron's profile
(layout/colors in localStorage). Don't write user files under ROOT.

## Website

Landing page in `docs/` (GitHub Pages from `default` → `/docs`, https://rusinovanton.github.io/hudsplay/).
Plain HTML/CSS, editor look, no build step. Screenshots + social card come from
`uv run python packaging/capture_screenshots.py` (mock race via headless Chrome/Edge,
also stamps image sizes into `docs/index.html`); rerun it after UI changes. The mock
track is the real Monza outline (bacinger/f1-circuits, MIT, attribution in `mock.py`).
Owner: no "clever" code-snippet jokes on the site.

## Rules

- All derived logic lives in `src/hudsplay/engine.py`. Sources only read raw
  values in iRacing SDK var names. Keep `sources/mock.py` producing the same
  shape so `uv run hudsplay --mock` stays a working UI dev loop.
- The engine runs at 60 Hz, so no YAML parsing or heavy work per frame. Session info is
  re-read only when its update counter changes (`sources/iracing.py`).
- The pump loop in `server.py` must never crash mid-race. Exceptions are logged and the loop continues.
- Frontend performance (the overlay shares the GPU with iRacing; the owner notices FPS
  flicker): no per-frame getComputedStyle, no canvas work for widgets that can't be seen
  (faded out, switched off, idle radar: not even a clear), round per-frame style values
  to visible steps (`step()`), cache static canvas layers (map overview: road + paint,
  rebuilt <= ~3x/s), map at 30 fps, no gradients in per-frame canvas drawing.

## Status (2026-10-13)

Verified on macOS with mock data: session (pos + lap), relative, fuel, 4 delta
widgets (best / ▲ / ▼ / closest, closest hidden by default, toggle in edit mode)
and radar (incl. three-wide) render. Gaps, trend, fuel, laps estimate and radar
compute correctly from fake telemetry.

Map widget: shape recorded on the first clean lap per track (Speed + YawNorth
dead-reckoning, `trackmap.py`), cached in `maps/<TrackID>-<config>.json`. User maps
(DATA/maps) win over maps shipped in the installer (repo `maps/`, bundled by
build-installer.bat). Each app run re-records the first clean laps under the hood: two
laps that agree with each other but not the map replace it. Laps with a spin (yaw rate)
or a small self-crossing loop are never saved; a saved map with a loop is re-recorded.
Tray "Track map" submenu (polls `/api/map`): re-record next lap (old map kept as
`.prev.json`), report on GitHub when the re-record came out the same, share maps the
app doesn't ship (copied to `maps-to-share/`, opens GitHub's upload page = fork + PR). Painted
every ~10 m like the delta bar: green where time was gained in that piece, red where lost
(vs `map_paint_reference`), intensity = how fast. Car dots from lap %.
(An age fade of the paint was tried in 0.1.5 and removed: owner saw FPS flicker.)

Map has a follow mode (edit mode -> select map -> "follow me" + "follow range"):
centred on me, rotated heading-up, paint drawn uncached for visible pieces only.
Session "pos" is colored vs grid position (recorded at SessionState 3/4): green
gained, red lost, stronger with more places.

Relative: 3 cars each side + the leader pinned on top (dashed line under it) when not
nearby. Position badge filled with the class color, black number (--c-badge-text) in
multiclass; class tag = first letter of the class name, bold, class color; or +1L/-1L tag,
radio icon from RadioTransmitCarIdx, iRating as "1.2k" (DriverInfo IRating; blank when
0/1, i.e. offline/AI) on a badge in the license color (`--c-lic-*`, letter from
LicString, LicColor is unreliable), 4 strengths by safety rating 0.x / 1.x / 2.x / 3+.

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
Race: no laps-total estimate before SessionState 4 (gridding, pace laps); until then the
relative is a "// grid" list (QualifyResultsInfo order, else grid order), also while
I'm still in the garage. Lap progress per car (`CarTrack`) is unwrapped from lap % and
re-aligned to CarIdxLapCompleted whenever it changes and on pit exit (mine re-aligns
everyone), so a pit-lane start doesn't leave every car +1L.
Map recording also drops a lap on any incident point.

**Not yet verified against real iRacing.** First Windows session checklist:

1. `uv sync`, then `uv run hudsplay --dump` while in a session. Check in `dump/irsdk_dump.txt`:
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
