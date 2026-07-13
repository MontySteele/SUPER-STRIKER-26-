// Minimal QR encoder: byte mode, ECC level L, versions 1-5 (single RS block,
// up to 106 bytes — plenty for a controller URL), fixed mask 0. Zero deps,
// ~150 lines, verified against a reference decoder. Only what the pairing
// screen needs; not a general-purpose QR library.

interface VersionSpec { data: number; ec: number; align: number }
// total data codewords, EC codewords, alignment center (0 = none) per version
const VERSIONS: VersionSpec[] = [
  { data: 19, ec: 7, align: 0 },    // v1
  { data: 34, ec: 10, align: 18 },  // v2
  { data: 55, ec: 15, align: 22 },  // v3
  { data: 80, ec: 20, align: 26 },  // v4
  { data: 108, ec: 26, align: 30 }, // v5
];

// --- GF(256) arithmetic, poly 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Reed-Solomon EC codewords for the given data. */
function rsEncode(data: number[], ecLen: number): number[] {
  // generator poly = Π (x - α^i), i = 0..ecLen-1
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gfMul(gen[j], EXP[i]);
      next[j + 1] ^= gen[j];
    }
    gen = next;
  }
  gen.reverse(); // highest degree first
  const rem = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/** Encode text into a QR module matrix (true = dark). Throws if too long. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const vIdx = VERSIONS.findIndex((v) => bytes.length <= v.data - 2);
  if (vIdx < 0) throw new Error('qr: text too long');
  const spec = VERSIONS[vIdx];
  const size = 17 + 4 * (vIdx + 1);

  // --- bit stream: mode 0100, 8-bit count, data, terminator, pad bytes
  const bits: number[] = [];
  const push = (val: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, spec.data * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  for (let pad = 0xec; codewords.length < spec.data; pad ^= 0xfd) codewords.push(pad);
  codewords.push(...rsEncode(codewords, spec.ec));

  // --- matrix + function-module mask
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fun: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (r: number, c: number, dark: boolean): void => {
    mod[r][c] = dark;
    fun[r][c] = true;
  };

  // timing
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // finders + separators
  const finder = (r0: number, c0: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, d !== 2 && d !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  // alignment (v2+, single pattern for v1-5)
  if (spec.align) {
    const a = spec.align;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        set(a + r, a + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }
  }

  // format info: ECC L (formatBits 01), mask 0, BCH-coded, two copies
  const fmtData = (0b01 << 3) | 0;
  let rem = fmtData;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const fmt = ((fmtData << 10) | rem) ^ 0x5412;
  const fbit = (i: number): boolean => ((fmt >> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
  set(7, 8, fbit(6));
  set(8, 8, fbit(7));
  set(8, 7, fbit(8));
  for (let i = 9; i < 15; i++) set(8, 14 - i, fbit(i));
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, fbit(i));
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, fbit(i));
  set(size - 8, 8, true); // dark module

  // --- zigzag data placement with mask 0: invert where (r+c) even
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fun[r][c]) continue;
        let dark = false;
        if (bi < codewords.length * 8) {
          dark = ((codewords[bi >> 3] >> (7 - (bi & 7))) & 1) !== 0;
          bi++;
        }
        if ((r + c) % 2 === 0) dark = !dark;
        mod[r][c] = dark;
      }
    }
  }
  return mod;
}

/** Paint a QR for `text` onto a canvas, with the standard 4-module quiet zone. */
export function drawQr(canvas: HTMLCanvasElement, text: string, scale = 4): void {
  const m = qrMatrix(text);
  const quiet = 4;
  const px = (m.length + quiet * 2) * scale;
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < m.length; r++) {
    for (let c = 0; c < m.length; c++) {
      if (m[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}
