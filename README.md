<p align="center"><img src="docs/img/icon.png" alt="racehud logo" width="96" height="96"></p>

# racehud

Personal, minimal iRacing HUD overlay. VS Code look, Fira Code, every color configurable.
Website: https://rusinovanton.github.io/racehud/ (source in `docs/`, images from
`uv run python packaging/capture_screenshots.py`). MIT licensed, see [LICENSE](LICENSE).

![racehud overlay with mock race data at 1920x1080](docs/screenshot.png)

Widgets: session (lap / estimated total, position vs grid, time left), clock,
relative (cars ±2 on track, class and lap tags, radio indicator), fuel (tank bar,
per lap, laps left, needed to finish), deltas (session best + gap and catch
estimate for the car ahead/behind), radar (cars alongside, three-wide warning),
track map (recorded on your first clean lap, painted green/red by delta, overview
or follow mode).

## Installer (recommended)

Run **`racehud-setup.exe`**. It installs racehud for your user (no admin
needed), adds desktop + Start menu shortcuts, and starts it. Windows SmartScreen may
warn because the installer isn't code-signed: "More info" → "Run anyway".

- Runs in the **system tray** (gauge icon): edit mode, reload, start with Windows
  (on by default), open settings folder, quit.
- Settings (`config.toml`), recorded track maps and the log are in
  `%APPDATA%\racehud\data` (tray → "Open settings folder"). Layout and colors from
  edit mode are kept in `%APPDATA%\racehud`. Uninstalling keeps both.
- In iRacing: Options → Graphics → **Borderless windowed**, otherwise the overlay is hidden.

**Build the installer** (needs the dev setup below): double-click
**`build-installer.bat`** → `packaging\installer\racehud-setup.exe`. It
bundles the Python backend with PyInstaller (`racehud-backend.exe`) and the
overlay with electron-builder (NSIS). Bump `version` in `electron/package.json` for
a new release. The icon comes from `uv run python packaging/make_icon.py`.

**Release:** bump `version` in `electron/package.json`, commit, then push a tag
`v<version>` (`git tag v0.1.0 && git push origin v0.1.0`). GitHub Actions
(`.github/workflows/release.yml`) builds the installer on Windows and publishes it as a
release; the website's download button always points at the latest one.

## Dev setup on Windows (the iRacing PC)

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

**Stuck at "Downloading Electron binary"?** It's ~110 MB with no progress bar, so
give it a few minutes. If it never finishes (antivirus, firewall, slow GitHub),
close the window and retry from a mirror in PowerShell, then run `start.bat` again:

```powershell
cd electron; $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules\electron\install.js
```

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
- Behaviour: create `config.toml` in the repo root (installed: `%APPDATA%\racehud\data`):

```toml
[racehud]
standings_each_side = 2
standings_class_only = true
name_format = "short"   # or "full"
radar_range_m = 50   # max distance sent; view range is set in edit mode
delta_reference = "session_best"   # best | optimal | session_optimal | session_last
map_paint_reference = "session_last"   # same choices, for the map paint
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

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org).

- Committers and reviewers: [Anton Rusinov](https://github.com/RusinovAnton)
- Approvers: [Anton Rusinov](https://github.com/RusinovAnton)

Release installers are built from this repository by GitHub Actions
(`.github/workflows/release.yml`) and signed only after an approver confirms the
signing request. Only installers built from this repository's source are signed.

### Privacy

racehud doesn't collect, store or send any personal data or telemetry. It reads
iRacing's local telemetry on your PC and stays on your PC. The overlay downloads the
Fira Code web font from Google Fonts and country flag images from flagcdn.com; those
requests are plain file downloads that don't include anything about you or your
sessions. Settings, layout and recorded track maps are stored locally in
`%APPDATA%\racehud`.
