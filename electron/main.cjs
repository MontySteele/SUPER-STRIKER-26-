// SUPER STRIKER '26 — native shell (§5.4).
//
// One BrowserWindow, fullscreen, GPU on, background throttling off, autoplay
// unlocked so the crowd comes up without a click, and gamepads reaching the
// renderer exactly as they do in Chrome. In dev it loads the Vite server; in
// production it serves the built dist/ over a privileged `ss26://` scheme
// rather than file://, because ES module scripts are blocked by CORS on
// file:// origins and the whole build is `<script type="module">`.
//
// CommonJS on purpose: `.cjs` sidesteps every ESM-entrypoint caveat, and the
// preload has to be CJS anyway to keep sandboxing on.

const { app, BrowserWindow, Menu, protocol, net, shell, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'ss26';
const ROOT = path.join(__dirname, '..');
const DIST = process.env.SS26_DIST ? path.resolve(process.env.SS26_DIST) : path.join(ROOT, 'dist');

// ------------------------------------------------------------------ options

const DEV_SERVER = process.env.SS26_DEV_SERVER || '';
// which page to open — 'index' (the game) or 'pad' (the controller bench)
const PAGE = (process.env.SS26_PAGE || 'index').replace(/\.html$/, '');
const START_QUERY = process.env.SS26_QUERY || '';
const WANT_FULLSCREEN = process.env.SS26_WINDOWED !== '1';
// windowed size, for the bench (`npm run app:bench` wants a known 1920x1080)
const WANT_W = Number(process.env.SS26_WIDTH || 0);
const WANT_H = Number(process.env.SS26_HEIGHT || 0);
// bench/capture runs must not float over whatever the user is doing
const WANT_FOCUS = process.env.SS26_NO_FOCUS !== '1';
const OPEN_DEVTOOLS = process.env.SS26_DEVTOOLS === '1';
// headless-ish smoke test: capture a PNG N ms after load, then quit
const CAPTURE_PATH = process.env.SS26_CAPTURE || '';
const CAPTURE_DELAY = Number(process.env.SS26_CAPTURE_DELAY || 6000);
const QUIT_AFTER = Number(process.env.SS26_QUIT_AFTER || 0);

let errorCount = 0;

// ----------------------------------------------------------- chromium flags

// Gamepads, WebGL2 and audio all want the GPU process healthy and the renderer
// never put to sleep. These must be set before `ready`.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// a blocklisted or virtualised GPU otherwise drops us to SwiftShader, which
// cannot hold 60Hz with 22 skinned players on the pitch
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
if (process.env.SS26_HEADLESS === '1') {
  // capture runs on a machine with no display attached
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}

// `ss26://` must be standard (so relative URLs and ES modules resolve) and
// secure (so it is a trustworthy origin: WebRTC/PeerJS, WebCrypto, storage).
protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}]);

// only one copy of the game at a time — two would fight over the same pads
if (!app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------- dist serving

/** Resolve a request path inside dist/, refusing anything that escapes it. */
function resolveInDist(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const clean = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  const full = path.normalize(path.join(DIST, clean));
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return null;
  return full;
}

function serveDist() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let file = resolveInDist(url.pathname);
    if (!file) return new Response('forbidden', { status: 403 });
    try {
      const st = await fsp.stat(file);
      if (st.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

// ------------------------------------------------------------------- window

function startUrl() {
  if (DEV_SERVER) {
    const base = DEV_SERVER.replace(/\/$/, '');
    return `${base}/${PAGE === 'index' ? '' : PAGE + '.html'}${START_QUERY}`;
  }
  return `${APP_SCHEME}://game/${PAGE}.html${START_QUERY}`;
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const win = new BrowserWindow({
    // an explicit size is taken at face value (the bench quotes numbers for a
    // 1920x1080 frame and a clamped window would quietly measure something
    // else); otherwise fit the work area
    width: WANT_W || Math.min(1600, width),
    height: WANT_H || Math.min(900, height),
    backgroundColor: '#06090d',
    show: false,
    title: "SUPER STRIKER '26",
    // native fullscreen, not HTML5 fullscreen: Escape belongs to the game's
    // pause card and must never be eaten by Chromium's exit-fullscreen handler
    fullscreen: WANT_FULLSCREEN,
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // the crowd/menu music starts on boot, with no click to unlock it
      autoplayPolicy: 'no-user-gesture-required',
      // a minimised or occluded window must keep simulating at 60Hz
      backgroundThrottling: false,
      webgl: true,
      experimentalFeatures: false,
      // PeerJS talks to a public broker over wss:// — leave the web security
      // model intact; the ss26:// origin is already a secure context
      webSecurity: true,
      spellcheck: false,
    },
  });

  wireLogging(win);

  win.once('ready-to-show', () => {
    if (WANT_W && WANT_H) win.setContentSize(WANT_W, WANT_H);
    if (WANT_FOCUS) win.show();
    else win.showInactive();
    if (WANT_FOCUS) win.focus();
    if (OPEN_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  });

  // external links (credits, the join URL) go to the real browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_SCHEME}://`) && !(DEV_SERVER && url.startsWith(DEV_SERVER))) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  void win.loadURL(startUrl());
  return win;
}

// ----------------------------------------------------------------- logging

function wireLogging(win) {
  const wc = win.webContents;
  const levels = ['verbose', 'info', 'warning', 'error'];

  // Electron >= 36 passes a single event object; older builds pass positionals.
  wc.on('console-message', (...args) => {
    let level, message, line, source;
    if (args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      ({ level, message, lineNumber: line, sourceId: source } = args[0]);
    } else {
      [, level, message, line, source] = args;
      level = levels[level] ?? String(level);
    }
    if (level === 'error') errorCount++;
    const where = source ? ` (${String(source).split('/').pop()}:${line})` : '';
    process.stdout.write(`[renderer:${level}] ${message}${where}\n`);
  });

  wc.on('preload-error', (_e, file, err) => {
    errorCount++;
    process.stderr.write(`[preload-error] ${file}: ${err && err.message}\n`);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => {
    errorCount++;
    process.stderr.write(`[did-fail-load] ${code} ${desc} ${url}\n`);
  });
  wc.on('render-process-gone', (_e, details) => {
    errorCount++;
    process.stderr.write(`[render-process-gone] ${JSON.stringify(details)}\n`);
  });
  wc.on('unresponsive', () => process.stderr.write('[unresponsive]\n'));
  wc.on('did-finish-load', () => process.stdout.write(`[shell] loaded ${wc.getURL()}\n`));
}

// -------------------------------------------------------------------- menu

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        // Cmd+Q is the only way out, exactly as asked
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Game',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload' },
        {
          label: 'Toggle Fullscreen',
          // NOT F11/Ctrl+Cmd+F: the game owns Escape, and this is the deliberate
          // escape hatch for debugging on a laptop screen
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w) w.setFullScreen(!w.isFullScreen());
          },
        },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { type: 'separator' },
        {
          label: 'Controller Test',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (!w) return;
            const base = DEV_SERVER
              ? `${DEV_SERVER.replace(/\/$/, '')}/pad.html`
              : `${APP_SCHEME}://game/pad.html`;
            void w.loadURL(base);
          },
        },
        {
          label: 'Back to the Game',
          click: () => {
            const w = BrowserWindow.getFocusedWindow();
            if (w) void w.loadURL(startUrl());
          },
        },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ------------------------------------------------------------ capture mode

async function capture(win) {
  const image = await win.webContents.capturePage();
  await fsp.mkdir(path.dirname(CAPTURE_PATH), { recursive: true });
  await fsp.writeFile(CAPTURE_PATH, image.toPNG());
  process.stdout.write(`[shell] captured ${CAPTURE_PATH} (${image.getSize().width}x${image.getSize().height})\n`);
}

// --------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  if (!DEV_SERVER) {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) {
      process.stderr.write(`[shell] no build at ${DIST} — run \`npm run build\` first\n`);
      app.exit(2);
      return;
    }
    serveDist();
  }
  buildMenu();
  ipcMain.on('ss26:quit', () => app.quit());
  const win = createWindow();

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (CAPTURE_PATH || QUIT_AFTER) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (CAPTURE_PATH) await capture(win);
        } catch (err) {
          errorCount++;
          process.stderr.write(`[shell] capture failed: ${err && err.message}\n`);
        }
        process.stdout.write(`[shell] renderer errors: ${errorCount}\n`);
        const code = errorCount > 0 ? 1 : 0;
        // app.exit() can sit waiting on a GPU process that will not come home;
        // give it half a second and then leave the hard way
        setTimeout(() => process.exit(code), 500).unref();
        app.exit(code);
      }, CAPTURE_PATH ? CAPTURE_DELAY : QUIT_AFTER);
    });
  }
}).catch((err) => {
  process.stderr.write(`[shell] failed to start: ${err && err.stack}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
