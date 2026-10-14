// Lets the overlay page ask the Electron shell to leave edit mode or quit (edit panel
// "done" / "exit racehud" buttons, banner close button). Click-through and focus belong
// to the window, so the page can't change them itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("racehudShell", {
  setEditMode: (on) => ipcRenderer.send("racehud:edit-mode", !!on),
  quit: () => ipcRenderer.send("racehud:quit"),
  // take mouse clicks while the pointer is over a clickable element (window is click-through)
  setClickable: (on) => ipcRenderer.send("racehud:clickable", !!on),
});
