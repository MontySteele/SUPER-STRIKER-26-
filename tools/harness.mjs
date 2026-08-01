// Shared plumbing for the headless capture tools (§7A.9): find the Chromium
// that is actually installed, launch it with WebGL2 that works without a GPU,
// run our own vite dev server for the duration, and prove the PNGs that come
// out are real renders rather than black rectangles.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';

/**
 * Headless WebGL2 without a GPU. SwiftShader is ANGLE's software backend;
 * --enable-unsafe-swiftshader is what stops Chromium refusing to hand a
 * software WebGL context to a page. Everything else is the usual container
 * hygiene (no /dev/shm, no sandbox).
 */
export const GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--no-sandbox',
  '--disable-dev-shm-usage',
];

/**
 * Playwright resolves its browser from its own bundled revision number, which
 * will not match a pre-provisioned PLAYWRIGHT_BROWSERS_PATH. Prefer the real
 * binary on disk; fall back to playwright's own lookup.
 */
export function chromiumExecutablePath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  for (const p of [
    `${root}/chromium`,
    `${root}/chromium-1194/chrome-linux/chrome`,
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export async function launchBrowser() {
  const executablePath = chromiumExecutablePath();
  return chromium.launch({ args: GPU_ARGS, ...(executablePath ? { executablePath } : {}) });
}

/**
 * Start `vite` on a private port and resolve once it prints its URL. Returns
 * the base URL plus a stop() that takes the whole process group down.
 */
export function startDevServer({ port = 5273 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname,
        '--port', String(port), '--strictPort'],
      { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`vite did not start within 60s:\n${out}`));
    }, 60_000);

    const onData = (buf) => {
      out += buf.toString();
      const m = out.match(/https?:\/\/localhost:(\d+)\/?/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve({
          url: `http://localhost:${m[1]}`,
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000).unref?.();
          }),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited with code ${code}:\n${out}`));
    });
  });
}

// ------------------------------------------------------------- PNG sanity
// Headless WebGL fails silently: the page reports success and the screenshot
// is a uniform black rectangle. Every capture is therefore decoded and
// checked for actual variation before it counts as a shot.

/** Minimal decoder: 8-bit non-interlaced RGB/RGBA PNG, which is what
 *  Playwright writes. Returns { width, height, pixels } (RGBA). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (depth ${bitDepth}, color ${colorType}, interlace ${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * 4, 255);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 255; break;
        case 2: line[i] = (line[i] + b) & 255; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 255; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pr) & 255;
          break;
        }
        default: break;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * bpp, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      if (bpp === 4) out[d + 3] = line[s + 3];
    }
    prev = line;
  }
  return { width, height, pixels: out };
}

/**
 * Reject blank frames. A real render of this game has a wide luminance spread
 * and hundreds of distinct colours; a lost context gives one flat colour.
 */
export function pixelStats(pngPath) {
  const { width, height, pixels } = decodePng(readFileSync(pngPath));
  let min = 255, max = 0, sum = 0, n = 0;
  const seen = new Set();
  for (let i = 0; i < pixels.length; i += 4) {
    const lum = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    sum += lum;
    n++;
    if (seen.size < 4096) {
      seen.add(((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3));
    }
  }
  return {
    width, height,
    minLum: min,
    maxLum: max,
    meanLum: Math.round((sum / n) * 10) / 10,
    colors: seen.size,
    blank: max - min < 8 || seen.size < 8,
  };
}

/** Tiny flag parser: --key value and --flag. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
