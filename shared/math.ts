import { AIM_STEPS } from './constants';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const round2 = (v: number) => Math.round(v * 100) / 100;

/** 32 位整数哈希（确定性，客户端与服务器结果一致）。 */
export function hash32(a: number, b = 0, c = 0): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
export const hash01 = (a: number, b = 0, c = 0) => hash32(a, b, c) / 4294967296;

/** 可复现的伪随机数生成器（mulberry32）。 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export const aimToRad = (aim: number) => (aim / AIM_STEPS) * Math.PI * 2;
export function radToAim(rad: number): number {
  const twoPi = Math.PI * 2;
  let r = rad % twoPi;
  if (r < 0) r += twoPi;
  return Math.round((r / twoPi) * AIM_STEPS) % AIM_STEPS;
}

/** 线段（起点 + 单位方向 + 长度）与圆的最早相交距离，没有相交返回 -1。 */
export function segmentCircle(
  x0: number, z0: number, dx: number, dz: number, len: number,
  cx: number, cz: number, r: number,
): number {
  const fx = x0 - cx;
  const fz = z0 - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0; // 起点已在圆内
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > len) return -1;
  return t;
}

/** 与 btoa/atob 兼容的 Uint8Array Base64 编解码（Node 与浏览器均可用）。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(s);
}
export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
