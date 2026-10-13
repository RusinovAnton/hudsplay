# iRacing overlay

Personal, minimal iRacing overlay. VS Code look, Fira Code, every color configurable.

Widgets: session (position, lap / estimated total, time left), relative (cars ±2 on track), fuel
(tank, per lap, laps left, needed to finish), deltas (session best + live gap
trend to car ahead/behind), radar (cars within 20 m, side warnings), track map
(recorded on your first clean lap, painted green/red every 10 m by delta).

## Architecture

```
iRacing (shared memory, 60 Hz)
  -> src/overlay/sources/iracing.py   pyirsdk reader          (Windows only)
  -> src/overlay/engine.py            gaps, fuel, laps, radar (all derived logic)
  -> src/overlay/server.py            aiohttp: serves frontend/, streams JSON on /ws
  -> frontend/                        HTML/CSS/JS widgets
  -> electron/                        transparent click-through window over the game
```

`--mock` swaps the iRacing source for a fake race (`sources/mock.py`) with the
same data shape, so the UI and engine can be developed on any OS.

## Run

Requirements: [uv](https://docs.astral.sh/uv/), Node 20+ (for Electron, Windows only).

UI preview with fake data (macOS / anywhere):

```bash
uv run overlay --mock
```

Open http://127.0.0.1:8765/ and press `e` for edit mode.

On the iRacing PC (Windows):

```bat
start.bat
```

Or manually: `uv run overlay` in one terminal, `cd electron && npm install && npm start` in another.

iRacing must run in **borderless windowed** mode, or the overlay is hidden.

| Hotkey | Action |
| --- | --- |
| Ctrl+Shift+O | edit mode: drag to move, mouse wheel to resize, show/hide, colors |
| Ctrl+Shift+R | reload overlay |
| Ctrl+Shift+Q | quit overlay |

## Customize

- Colors: edit mode → color pickers (saved per machine). "copy css" → paste into
  `frontend/theme.css` to make them the defaults.
- Behaviour: create `config.toml` in the repo root:

```toml
[overlay]
standings_each_side = 2
standings_class_only = true
name_format = "short"   # or "full"
radar_range_m = 50   # max distance sent; view range is set in edit mode
delta_reference = "session_best"   # best | optimal | session_optimal | session_last
map_mirror = false                 # flip a mirrored track map
```

## Debug

```bat
uv run overlay --dump
```

Writes every telemetry var + session info YAML to `dump/irsdk_dump.txt`.
