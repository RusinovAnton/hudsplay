# racehud

Personal, minimal iRacing HUD overlay. VS Code look, Fira Code, every color configurable.

![racehud overlay with mock race data at 1920x1080](docs/screenshot.png)

Widgets: session (lap / estimated total, position vs grid, time left), clock,
relative (cars ±2 on track, class and lap tags, radio indicator), fuel (tank bar,
per lap, laps left, needed to finish), deltas (session best + gap and catch
estimate for the car ahead/behind), radar (cars alongside, three-wide warning),
track map (recorded on your first clean lap, painted green/red by delta, overview
or follow mode).

## Install on Windows (the iRacing PC)

1. Open **PowerShell** and install [uv](https://docs.astral.sh/uv/) (it also downloads Python):

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

2. Install Node.js LTS (runs the overlay window):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

   No winget? Use the LTS installer from https://nodejs.org.

3. **Close every open PowerShell / cmd window.** Windows that were already open
   don't see the new tools (`'uv' is not recognized`). If it persists, sign out of
   Windows and back in.
4. In iRacing: Options → Graphics → **Borderless windowed**. In fullscreen the
   overlay is hidden.
5. Get the code: `git clone git@github.com:RusinovAnton/racehud.git`, or download
   the zip and unpack it.

## Run

Double-click **`start.bat`**. The first run takes 1–2 minutes (Python, packages,
Electron download). It opens a backend console window and the overlay, which
shows up once you're in a session.

Manual start instead: `uv run racehud` in one terminal,
`cd electron && npm install && npm start` in another.

| Hotkey | Action |
| --- | --- |
| Ctrl+Shift+O | edit mode: click a widget for its settings, drag to move, mouse wheel to resize, show/hide, colors |
| Ctrl+Shift+R | reload overlay |
| Ctrl+Shift+Q | quit overlay |

The track map needs one clean lap per track/config to record its shape; after
that it's saved in `maps/`.

## Customize

- Layout, sizes, opacity, colors: edit mode (saved per machine). "copy css" →
  paste into `frontend/theme.css` to make colors the defaults. Palette buttons
  include color-blind-safe sets.
- Behaviour: create `config.toml` in the repo root:

```toml
[racehud]
standings_each_side = 2
standings_class_only = true
name_format = "short"   # or "full"
radar_range_m = 50   # max distance sent; view range is set in edit mode
delta_reference = "session_best"   # best | optimal | session_optimal | session_last
map_mirror = false                 # flip a mirrored track map
```

## Preview without iRacing

Runs a fake race, on any OS (macOS too):

```bash
uv run racehud --mock
```

Open http://127.0.0.1:8765/ and press `e` for edit mode.

## Debug

```bat
uv run racehud --dump
```

Writes every telemetry var + session info YAML to `dump/irsdk_dump.txt`.

## Architecture

```
iRacing (shared memory, 60 Hz)
  -> src/racehud/sources/iracing.py   pyirsdk reader          (Windows only)
  -> src/racehud/engine.py            gaps, fuel, laps, radar (all derived logic)
  -> src/racehud/trackmap.py          track shape recording + delta paint
  -> src/racehud/server.py            aiohttp: serves frontend/, streams JSON on /ws
  -> frontend/                        HTML/CSS/JS widgets
  -> electron/                        transparent click-through window over the game
```

`--mock` swaps the iRacing source for a fake race (`sources/mock.py`) with the
same data shape, so the UI and engine can be developed on any OS.
