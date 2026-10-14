// Transparent, click-through, always-on-top window covering the primary display.
// Loads the frontend served by the Python backend. Installed build: starts the bundled
// backend (resources/backend/racehud-backend.exe) itself; dev: start.bat runs `uv run racehud`.
//   Ctrl+Shift+O  toggle edit mode (window takes mouse input, drag widgets, pick colors)
//   Ctrl+Shift+R  reload frontend
//   Ctrl+Shift+Q  quit
// Tray icon: same actions + start with Windows + open settings folder.
const { app, BrowserWindow, Menu, Tray, globalShortcut, screen, shell } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL = process.env.RACEHUD_URL || "http://127.0.0.1:8765/";
const ICON = path.join(__dirname, "assets", "icon.ico");
// backend's config.toml, maps/, racehud.log (see src/racehud/config.py)
const DATA_DIR = app.isPackaged ? path.join(app.getPath("appData"), "racehud", "data") : path.resolve(__dirname, "..");
const BACKEND_RESTART_MS = 2000;

let win;
let tray;
let editMode = false;
let backend = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit(); // already running: the tray icon has it
// same id as "appId" in package.json: names the start-with-Windows registry value
// (removed again by assets/installer.nsh on uninstall)
app.setAppUserModelId("com.racehud.app");

// ---------------------------------------------------------------- backend (installed build)

// a backend left over from a crash would hold the port and serve stale code
function killStaleBackend() {
  if (app.isPackaged) spawnSync("taskkill", ["/F", "/IM", "racehud-backend.exe"], { windowsHide: true });
}

function startBackend() {
  if (!app.isPackaged || quitting) return;
  const exe = path.join(process.resourcesPath, "backend", "racehud-backend.exe");
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
    title: "racehud",
    icon: ICON,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // never steal focus from iRacing
    backgroundColor: "#00000000",
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  win.loadURL(URL);
  // backend not up yet -> retry
  win.webContents.on("did-fail-load", () => setTimeout(() => win.loadURL(URL), 1000));
}

function setEditMode(on) {
  editMode = on;
  win.setIgnoreMouseEvents(!on);
  win.setFocusable(on);
  if (on) win.focus();
  win.webContents.executeJavaScript(`window.racehud && window.racehud.setEditMode(${on})`);
  updateTray();
}

// ---------------------------------------------------------------- tray + start with Windows

const autostartOn = () => app.getLoginItemSettings().openAtLogin;

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "racehud", enabled: false },
    { type: "separator" },
    { label: "Edit mode", type: "checkbox", checked: editMode, accelerator: "Ctrl+Shift+O", click: () => setEditMode(!editMode) },
    { label: "Reload overlay", accelerator: "Ctrl+Shift+R", click: () => win.reload() },
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
    { label: "Quit", accelerator: "Ctrl+Shift+Q", click: () => app.quit() },
  ]));
}

function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip("racehud");
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
  globalShortcut.register("CommandOrControl+Shift+O", () => setEditMode(!editMode));
  globalShortcut.register("CommandOrControl+Shift+R", () => win.reload());
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
});

app.on("before-quit", () => { quitting = true; stopBackend(); });
app.on("will-quit", () => globalShortcut.unregisterAll());
