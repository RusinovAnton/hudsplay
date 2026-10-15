// Transparent, click-through, always-on-top window covering the primary display.
// Loads the frontend served by the Python backend. Installed build: starts the bundled
// backend (resources/backend/hudsplay-backend.exe) itself; dev: start.bat runs `uv run hudsplay`.
//   Ctrl+Shift+O  toggle edit mode (window takes mouse input, drag widgets, pick colors)
//   Ctrl+Shift+R  reload frontend
//   Ctrl+Shift+Q  quit
// Tray icon: same actions + start with Windows + open settings folder.
const { app, BrowserWindow, Menu, Tray, dialog, globalShortcut, ipcMain, screen, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL = process.env.HUDSPLAY_URL || "http://127.0.0.1:8765/";
const ICON = path.join(__dirname, "assets", "icon.ico");
// backend's config.toml, maps/, hudsplay.log (see src/hudsplay/config.py)
const DATA_DIR = app.isPackaged ? path.join(app.getPath("appData"), "HUDsplay", "data") : path.resolve(__dirname, "..");
const BACKEND_RESTART_MS = 2000;
const REPO = "https://github.com/RusinovAnton/hudsplay";
const MAP_POLL_MS = 3000; // tray "Track map" submenu follows the backend's current track
const UKRAINE = "HUDsplay is made in Ukraine, while Russia wages its full-scale war against it. If you support this war or the Russian state waging it, you are not welcome to use HUDsplay. Slava Ukraini! 🇺🇦";

let win;
let tray;
let editMode = false;
let hoverClickable = false; // pointer over a clickable bit of the overlay (banner close button)
let backend = null;
let quitting = false;

// one-time move from the old name: the app was called racehud, so the first start after
// updating copies %APPDATA%\racehud (layout, colors, data\ with config and maps) over.
// Must run before anything (incl. the single-instance lock) creates the new profile.
if (app.isPackaged) {
  const oldDir = path.join(app.getPath("appData"), "racehud");
  const newDir = app.getPath("userData");
  try {
    if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) fs.cpSync(oldDir, newDir, { recursive: true });
  } catch (_e) {} // start fresh rather than not at all
}

if (!app.requestSingleInstanceLock()) app.quit(); // already running: the tray icon has it
// same id as "appId" in package.json: names the start-with-Windows registry value
// (removed again by assets/installer.nsh on uninstall)
app.setAppUserModelId("com.hudsplay.app");

// ---------------------------------------------------------------- backend (installed build)

// a backend left over from a crash would hold the port and serve stale code
function killStaleBackend() {
  if (app.isPackaged) spawnSync("taskkill", ["/F", "/IM", "hudsplay-backend.exe"], { windowsHide: true });
}

function startBackend() {
  if (!app.isPackaged || quitting) return;
  const exe = path.join(process.resourcesPath, "backend", "hudsplay-backend.exe");
  backend = spawn(exe, [], { windowsHide: true, stdio: "ignore" });
  backend.on("exit", () => {
    backend = null;
    if (!quitting) setTimeout(startBackend, BACKEND_RESTART_MS); // never leave the HUD without data
  });
  backend.on("error", () => {}); // reported via "exit"; the window keeps retrying the URL
}

function stopBackend() {
  if (backend) backend.kill();
  backend = null;
}

// ---------------------------------------------------------------- overlay window

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
    title: "HUDsplay",
    icon: ICON,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // never steal focus from iRacing
    backgroundColor: "#00000000",
    webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, "preload.js") },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  applyMouse();
  win.loadURL(URL);
  // backend not up yet -> retry
  win.webContents.on("did-fail-load", () => setTimeout(() => win.loadURL(URL), 1000));
}

// click-through except in edit mode or while hovering a clickable element; mouse moves
// are still forwarded so the page can tell when the pointer is over one
function applyMouse() {
  win.setIgnoreMouseEvents(!(editMode || hoverClickable), { forward: true });
}

function setEditMode(on) {
  editMode = on;
  applyMouse();
  win.setFocusable(on);
  if (on) win.focus();
  win.webContents.executeJavaScript(`window.hudsplay && window.hudsplay.setEditMode(${on})`);
  updateTray();
}

// ---------------------------------------------------------------- tray + start with Windows

const autostartOn = () => app.getLoginItemSettings().openAtLogin;

// ---------------------------------------------------------------- track maps (tray)

let mapInfo = null; // GET /api/map: current track, its map and what the backend does with it

async function api(pathname, method = "GET") {
  const res = await fetch(new globalThis.URL(pathname, URL), { method });
  return res.json();
}

async function pollMap() {
  let info = null;
  try { info = await api("api/map"); } catch (_e) {} // backend not up (yet)
  if (JSON.stringify(info) !== JSON.stringify(mapInfo)) { mapInfo = info; updateTray(); }
}

const MAP_STATUS = {
  recording: "drive 1 clean lap to record it",
  rerecording: "re-recording on the next clean lap",
  checking: "checking it on the first clean laps",
  ok: "checked, unchanged",
  updated: "recorded",
  unchanged: "re-recorded, came out the same",
};

async function rerecordMap() {
  try { mapInfo = await api("api/map/rerecord", "POST"); } catch (_e) {}
  updateTray();
}

// the re-recorded map came out the same: it's not my driving, report it
function reportMap() {
  const m = mapInfo || {};
  const title = `Track map wrong: ${m.track || m.key}`;
  const body = [
    `Track: ${m.track || "?"}`,
    `Map key: \`${m.key}\``,
    `HUDsplay ${app.getVersion()}`,
    "",
    "What's wrong with the map (where on the lap):",
    "",
    "",
    `Re-recording it gave the same shape. Please attach \`${m.key}.json\` from the folder HUDsplay opened.`,
  ].join("\n");
  shell.openExternal(`${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`);
  if (m.file) shell.showItemInFolder(m.file);
}

// maps recorded here that HUDsplay doesn't ship yet: GitHub's upload page makes the PR
async function shareMaps() {
  let res;
  try { res = await api("api/maps/share", "POST"); } catch (_e) {
    dialog.showMessageBox({ type: "error", title: "HUDsplay", message: "HUDsplay backend is not running." });
    return;
  }
  if (!res.files.length) {
    dialog.showMessageBox({
      type: "info", title: "HUDsplay",
      message: "Nothing to share",
      detail: app.isPackaged
        ? "HUDsplay already ships every track map you've recorded."
        : "Dev checkout: maps are recorded straight into the repo's maps/ folder, commit them with git.",
    });
    return;
  }
  shell.openPath(res.dir);
  shell.openExternal(`${REPO}/upload/default/maps`);
  dialog.showMessageBox({
    type: "info", title: "HUDsplay",
    message: `Share ${res.files.length} track map${res.files.length > 1 ? "s" : ""}`,
    detail: `${res.files.join("\n")}\n\nDrag the files from the folder that just opened onto the GitHub page, ` +
      "then click \"Propose changes\" and \"Create pull request\". GitHub forks the repo for you if needed.",
  });
}

function mapMenu() {
  const m = mapInfo;
  if (!m) return [{ label: "HUDsplay backend not running", enabled: false }];
  if (!m.key) return [{ label: "No session: join one in iRacing", enabled: false }];
  const status = !m.hasMap ? MAP_STATUS.recording : MAP_STATUS[m.status] || "";
  return [
    { label: m.track || m.key, enabled: false },
    { label: `${m.source === "bundled" ? "shipped map" : m.hasMap ? "your map" : "no map"}: ${status}`, enabled: false },
    { type: "separator" },
    {
      label: "Map is wrong: re-record next lap",
      enabled: m.hasMap && m.status !== "rerecording",
      click: rerecordMap,
    },
    {
      label: m.status === "unchanged" ? "Report map problem on GitHub…" : "Report map problem (re-record it first)",
      enabled: m.status === "unchanged",
      click: reportMap,
    },
    { type: "separator" },
    { label: "Share my track maps (pull request)…", click: shareMaps },
    { label: "Open maps folder", click: () => { const dir = m.mapsDir; fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } },
  ];
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "HUDsplay", enabled: false },
    { type: "separator" },
    { label: "Edit mode", type: "checkbox", checked: editMode, accelerator: "Ctrl+Shift+O", click: () => setEditMode(!editMode) },
    { label: "Reload overlay", accelerator: "Ctrl+Shift+R", click: () => win.reload() },
    { label: "Track map", submenu: mapMenu() },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: app.isPackaged && autostartOn(),
      enabled: app.isPackaged, // dev: would register the dev electron.exe
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); updateTray(); },
    },
    { label: "Open settings folder", click: () => { fs.mkdirSync(DATA_DIR, { recursive: true }); shell.openPath(DATA_DIR); } },
    { type: "separator" },
    { label: "About HUDsplay", click: showAbout },
    { label: "Quit", accelerator: "Ctrl+Shift+Q", click: () => app.quit() },
  ]));
}

function showAbout() {
  dialog.showMessageBox({
    type: "info", title: "About HUDsplay",
    message: `HUDsplay ${app.getVersion()}`,
    detail: `${UKRAINE}

MIT licensed. Not affiliated with iRacing.com Motorsport Simulations.
${REPO}`,
  });
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip("HUDsplay");
  tray.on("click", () => tray.popUpContextMenu());
  updateTray();
}

// first run of the installed app: start with Windows by default (togglable in the tray)
function initAutostart() {
  if (!app.isPackaged) return;
  const marker = path.join(app.getPath("userData"), "autostart-initialized");
  if (fs.existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true });
  fs.writeFileSync(marker, "");
}

// ---------------------------------------------------------------- app

app.whenReady().then(() => {
  initAutostart();
  killStaleBackend();
  startBackend();
  createWindow();
  createTray();
  setInterval(pollMap, MAP_POLL_MS);
  pollMap();
  globalShortcut.register("CommandOrControl+Shift+O", () => setEditMode(!editMode));
  globalShortcut.register("CommandOrControl+Shift+R", () => win.reload());
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
  // edit panel buttons (preload.js)
  ipcMain.on("hudsplay:edit-mode", (_e, on) => setEditMode(on));
  ipcMain.on("hudsplay:quit", () => app.quit());
  ipcMain.on("hudsplay:clickable", (_e, on) => { hoverClickable = !!on; applyMouse(); });
});

app.on("before-quit", () => { quitting = true; stopBackend(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
