// Minimal 2D/3D math for the sim. Sim space: x = pitch length, y = pitch width, z = up.

export interface V2 { x: number; y: number; }
export interface V3 { x: number; y: number; z: number; }

export const v2 = (x = 0, y = 0): V2 => ({ x, y });
export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

export function len2(v: V2): number { return Math.hypot(v.x, v.y); }
export function len3(v: V3): number { return Math.hypot(v.x, v.y, v.z); }
export function dist2(a: V2, b: V2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
export function sub2(a: V2, b: V2): V2 { return { x: a.x - b.x, y: a.y - b.y }; }
export function add2(a: V2, b: V2): V2 { return { x: a.x + b.x, y: a.y + b.y }; }
export function scale2(a: V2, s: number): V2 { return { x: a.x * s, y: a.y * s }; }
export function dot2(a: V2, b: V2): number { return a.x * b.x + a.y * b.y; }

export function norm2(v: V2): V2 {
  const l = len2(v);
  return l > 1e-8 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

/** Frame-rate independent exponential smoothing. halfLife in seconds. */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return lerp(current, target, 1 - Math.pow(0.5, dt / halfLife));
}

export function angleOf(v: V2): number { return Math.atan2(v.y, v.x); }

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current: number, target: number, halfLife: number, dt: number): number {
  return current + angleDiff(current, target) * (1 - Math.pow(0.5, dt / halfLife));
}

/** Distance from point p to segment a-b. */
export function distToSegment(p: V2, a: V2, b: V2): number {
  const ab = sub2(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 < 1e-8) return dist2(p, a);
  const t = clamp(dot2(sub2(p, a), ab) / l2, 0, 1);
  return dist2(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
