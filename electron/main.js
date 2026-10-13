// Transparent, click-through, always-on-top window covering the primary display.
// Loads the frontend served by the Python backend (uv run racehud).
//   Ctrl+Shift+O  toggle edit mode (window takes mouse input, drag widgets, pick colors)
//   Ctrl+Shift+R  reload frontend
//   Ctrl+Shift+Q  quit
const { app, BrowserWindow, globalShortcut, screen } = require("electron");

const URL = process.env.OVERLAY_URL || "http://127.0.0.1:8765/";
let win;
let editMode = false;

function createWindow() {
  const { bounds } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...bounds,
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
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("CommandOrControl+Shift+O", () => setEditMode(!editMode));
  globalShortcut.register("CommandOrControl+Shift+R", () => win.reload());
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
});

app.on("will-quit", () => globalShortcut.unregisterAll());
