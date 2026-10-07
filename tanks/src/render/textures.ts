import * as THREE from 'three/webgpu';
import { tileableFbm } from '../core/noise';
import { Rng } from '../core/rng';

export const NOISE_SIZE = 256;

/**
 * Shared tileable noise, kept on the CPU too so scatter placement can read exactly what
 * the terrain shader shows. Channels: R macro, G mid, B fine grain, A cellular-ish pebbles.
 */
export interface NoiseSet {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  a: Float32Array;
  texture: THREE.DataTexture;
  /** RG = XY gradient of B (fine), BA = gradient of A; for detail normals */
  gradient: THREE.DataTexture;
}

export function makeNoiseSet(seed: number): NoiseSet {
  const S = NOISE_SIZE;
  const r = tileableFbm(S, 4, 5, seed + 1);
  const g = tileableFbm(S, 8, 5, seed + 2);
  const b = tileableFbm(S, 16, 4, seed + 3);
  const a = tileableFbm(S, 32, 3, seed + 4);
  const data = new Uint8Array(S * S * 4);
  const grad = new Uint8Array(S * S * 4);
  const stretch = (v: number) => Math.min(1, Math.max(0, (v - 0.5) * 1.9 + 0.5));
  for (let i = 0; i < S * S; i++) {
    r[i] = stretch(r[i]!);
    g[i] = stretch(g[i]!);
    b[i] = stretch(b[i]!);
    a[i] = stretch(a[i]!);
    data[i * 4] = r[i]! * 255;
    data[i * 4 + 1] = g[i]! * 255;
    data[i * 4 + 2] = b[i]! * 255;
    data[i * 4 + 3] = a[i]! * 255;
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const xp = (x + 1) % S;
      const xm = (x + S - 1) % S;
      const yp = (y + 1) % S;
      const ym = (y + S - 1) % S;
      const i = (y * S + x) * 4;
      const gbx = (b[y * S + xp]! - b[y * S + xm]!) * 4;
      const gby = (b[yp * S + x]! - b[ym * S + x]!) * 4;
      const gax = (a[y * S + xp]! - a[y * S + xm]!) * 4;
      const gay = (a[yp * S + x]! - a[ym * S + x]!) * 4;
      grad[i] = Math.min(255, Math.max(0, (gbx * 0.5 + 0.5) * 255));
      grad[i + 1] = Math.min(255, Math.max(0, (gby * 0.5 + 0.5) * 255));
      grad[i + 2] = Math.min(255, Math.max(0, (gax * 0.5 + 0.5) * 255));
      grad[i + 3] = Math.min(255, Math.max(0, (gay * 0.5 + 0.5) * 255));
    }
  }
  const mk = (d: Uint8Array) => {
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { r, g, b, a, texture: mk(data), gradient: mk(grad) };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

/** Track link pattern: grayscale height (used as bump map), U runs along the belt. One repeat = one link. */
export function makeTrackTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 128);
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, 64, 128);
  // grouser bar
  const grd = ctx.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, '#5a5a5a');
  grd.addColorStop(0.5, '#9a9a9a');
  grd.addColorStop(1, '#5a5a5a');
  ctx.fillStyle = grd;
  ctx.fillRect(8, 0, 40, 128);
  // rubber pads
  ctx.fillStyle = '#2a2a2a';
  ctx.fillRect(14, 10, 28, 48);
  ctx.fillRect(14, 70, 28, 48);
  // end connectors
  ctx.fillStyle = '#b0b0b0';
  ctx.fillRect(0, 0, 8, 128);
  ctx.fillRect(56, 0, 8, 128);
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 60, 64, 6);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Soft round particle sprite with a noisy edge (alpha in A). */
export function makeSmokeSprite(seed: number): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileableFbm(S, 4, 4, seed);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2 + 0.5) / (S / 2);
      const dy = (y - S / 2 + 0.5) / (S / 2);
      const d = Math.sqrt(dx * dx + dy * dy);
      const v = n[y * S + x]!;
      // noisy edge inside the circle, and always 0 at its rim: the old falloff left ~0.2 at the
      // middle of each side where the noise was low, so dense smoke drew its square outline
      let a = Math.max(0, 1 - d * (0.8 + v * 0.7)) * Math.min(1, Math.max(0, (1 - d) * 4));
      a = a * a * (3 - 2 * a);
      const i = (y * S + x) * 4;
      const shade = 200 + v * 55;
      img.data[i] = shade;
      img.data[i + 1] = shade;
      img.data[i + 2] = shade;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Track-mark decal: tread imprint with soft edges; U across track, V along travel. */
export function makeTrackMarkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  const img = ctx.createImageData(64, 64);
  const rng = new Rng(9);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const u = x / 63;
      const edge = Math.min(1, Math.min(u, 1 - u) * 7);
      const grouser = Math.sin((y / 64) * Math.PI * 8) > 0.2 ? 1 : 0.55;
      const a = edge * (0.55 + 0.45 * grouser) * (0.8 + rng.next() * 0.2);
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * grouser;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Scorch mark: dark blotch with ragged edge. */
export function makeScorchTexture(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S, S);
  const img = ctx.createImageData(S, S);
  const n = tileableFbm(S, 8, 4, 77);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x - S / 2) / (S / 2);
      const dy = (y - S / 2) / (S / 2);
      const d = Math.sqrt(dx * dx + dy * dy) + (n[y * S + x]! - 0.5) * 0.6;
      const a = Math.max(0, Math.min(1, (1 - d) * 2.2));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function makeRoadTexture(road: Float32Array, n: number): THREE.DataTexture {
  const d = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) d[i] = Math.round(road[i]! * 255);
  const t = new THREE.DataTexture(d, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
