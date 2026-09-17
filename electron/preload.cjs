// Preload for the native shell. Sandboxed and context-isolated: it exposes a
// single read-only fact — "you are running inside the desktop app" — so the
// game can, for instance, hide browser-only advice ("reload the page (F5)")
// or skip the guest-link QR when there is no browser URL to share.
//
// Deliberately no Node, no fs, no ipcRenderer surface: the renderer is the
// whole game and must not gain powers the browser build does not have.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ss26Native', {
  isNative: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  /** Quit the app (Cmd+Q also works); the menus may wire an EXIT row to it. */
  quit: () => ipcRenderer.send('ss26:quit'),
});
