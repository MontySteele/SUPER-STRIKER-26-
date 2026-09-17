// `npm run app` — start the Vite dev server, wait for it to answer, then open
// the native shell against it. No extra dependencies (no concurrently, no
// wait-on): one child process each, and one signal handler that takes both
// down together so a Ctrl-C never leaves a stray Vite on port 5173.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 60_000;

/** First free port at or above `from` — other tooling often owns 5173 already. */
async function freePort(from) {
  const { createServer } = await import('node:net');
  for (let p = from; p < from + 60; p++) {
    const ok = await new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, HOST);
    });
    if (ok) return p;
  }
  throw new Error(`no free port near ${from}`);
}

const PORT = process.env.SS26_PORT
  ? Number(process.env.SS26_PORT)
  : await freePort(5173);
const URL_BASE = `http://${HOST}:${PORT}`;

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
});

let electron = null;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && electron.exitCode === null) electron.kill('SIGTERM');
  if (vite.exitCode === null) vite.kill('SIGTERM');
  // give both a beat to die politely, then leave
  setTimeout(() => process.exit(code), 250).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

vite.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[app] vite exited (${code}) — stopping the shell`);
    shutdown(code ?? 1);
  }
});

/** Poll the dev server until index.html comes back 200. */
async function waitForServer() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(URL_BASE + '/', { redirect: 'follow' });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`dev server never answered on ${URL_BASE}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

try {
  await waitForServer();
} catch (err) {
  console.error('[app]', err.message);
  shutdown(1);
  throw err;
}

console.log(`[app] dev server up on ${URL_BASE} — launching the shell`);

const electronBin = (await import('electron')).default;
electron = spawn(electronBin, [path.join(HERE, 'main.cjs'), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, SS26_DEV_SERVER: URL_BASE },
});

electron.on('exit', (code) => {
  console.log(`[app] shell exited (${code})`);
  shutdown(code ?? 0);
});
