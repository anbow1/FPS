import { floor, fract, int, ivec2, mix, textureLoad, vec2 } from 'three/tsl';
import { DataTexture, FloatType, NearestFilter, type Node, RGBAFormat } from 'three/webgpu';
import { LAKE_WAVES } from '../config.ts';
import type { Lake } from '../maps/lake.ts';

// Offline wave-propagation field for the lake's wind waves, solved once at load.
//
// The Eikonal equation |∇T| = 1 / c(x) is solved with the Fast Marching Method
// over the lake bed, where c is the phase speed at the local depth (linear
// dispersion, Eckart's approximation). A lake has no open boundary, so the
// sources are the upwind shore: every water cell whose upwind neighbour is dry,
// with a plane-wave arrival along the wind. Fronts then cross the lake, slow
// and bunch up in the shallows and turn to meet each shore along its depth
// contours. Wave height grows with the fetch (the distance the wind has blown
// over open water), accumulated along the same paths.
//
// After Tidewater's ShoreField (Dan Greenheck, MIT licence,
// github.com/dgreenheck/tidewater), via Castaway Lagoon's version.
//
// Texture (RGBA float, res × res over the lake's domain):
//   r  arrival time T (s): the wave phase is ω(t − T)
//   gb propagation direction × exposure (fetch-limited height factor, 0..1)
//   a  arrival time at the nearest shoreline, carried onto the bank (swash timing)

const G = 9.81;

export interface FieldDomain {
  x0: number;
  z0: number;
  sizeM: number;
  res: number;
}

/** A square domain around the lake, out to where the render's water ends. */
export function lakeDomain(lake: Lake): FieldDomain {
  const half = Math.max(lake.rx, lake.rz) * 1.38;
  return { x0: lake.cx - half, z0: lake.cz - half, sizeM: half * 2, res: LAKE_WAVES.res };
}

class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  push(k: number, v: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.keys.length * 2);
      keys.set(this.keys);
      const vals = new Int32Array(this.vals.length * 2);
      vals.set(this.vals);
      this.keys = keys;
      this.vals = vals;
    }
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((keys[p] as number) <= k) break;
      keys[i] = keys[p] as number;
      vals[i] = vals[p] as number;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }

  pop(): number {
    const { keys, vals } = this;
    const top = vals[0] as number;
    const n = --this.size;
    const k = keys[n] as number;
    const v = vals[n] as number;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (keys[c + 1] as number) < (keys[c] as number)) c++;
      if ((keys[c] as number) >= k) break;
      keys[i] = keys[c] as number;
      vals[i] = vals[c] as number;
      i = c;
    }
    keys[i] = k;
    vals[i] = v;
    return top;
  }
}

/** Phase speed (m/s) of a wave of angular frequency ω at depth h: ω/k with Eckart's k(h). */
export function phaseSpeed(omega: number, depthM: number): number {
  const k0 = (omega * omega) / G;
  const k = k0 / Math.sqrt(Math.tanh(k0 * depthM));
  return omega / k;
}

export interface ShoreFieldData {
  data: Float32Array;
  res: number;
  cellM: number;
}

/**
 * @param ground  terrain height at a world point
 * @param windDir unit direction the wind (and the waves) travel, XZ
 */
export function computeShoreField(domain: FieldDomain, levelM: number, ground: (x: number, z: number) => number, windDir: { x: number; z: number }): ShoreFieldData {
  const { x0, z0, sizeM, res } = domain;
  const h = sizeM / res;
  const N = res * res;
  const omega = (2 * Math.PI) / LAKE_WAVES.periodS;
  const depth = new Float32Array(N);
  const speed = new Float32Array(N);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const d = levelM - ground(x0 + (i + 0.5) * h, z0 + (j + 0.5) * h);
      depth[j * res + i] = d;
      speed[j * res + i] = d > 0 ? phaseSpeed(omega, Math.min(Math.max(d, LAKE_WAVES.minDepthM), LAKE_WAVES.maxDepthM)) : 0;
    }
  }
  const wl = Math.hypot(windDir.x, windDir.z) || 1;
  const sdx = windDir.x / wl;
  const sdz = windDir.z / wl;
  const c0 = phaseSpeed(omega, LAKE_WAVES.maxDepthM);

  const T = new Float32Array(N).fill(Infinity);
  const fetch = new Float32Array(N);
  const state = new Uint8Array(N);
  const heap = new MinHeap(N);
  const wet = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < res && j < res && (speed[j * res + i] as number) > 0;
  // Sources: water cells on the upwind shore (the cell one step upwind is dry or outside).
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      if ((speed[k] as number) <= 0) continue;
      if (wet(Math.round(i - sdx), Math.round(j - sdz))) continue;
      const x = x0 + (i + 0.5) * h;
      const z = z0 + (j + 0.5) * h;
      T[k] = (x * sdx + z * sdz) / c0 + sizeM / c0;
      state[k] = 1;
      heap.push(T[k] as number, k);
    }
  }

  const known = (k: number): number => ((state[k] as number) === 2 ? (T[k] as number) : Infinity);
  const solve = (i: number, j: number): number => {
    const k = j * res + i;
    const c = speed[k] as number;
    if (c <= 0) return Infinity;
    const f = h / c;
    const tx = Math.min(i > 0 ? known(k - 1) : Infinity, i < res - 1 ? known(k + 1) : Infinity);
    const tz = Math.min(j > 0 ? known(k - res) : Infinity, j < res - 1 ? known(k + res) : Infinity);
    const a = Math.min(tx, tz);
    const b = Math.max(tx, tz);
    if (!Number.isFinite(b) || b - a >= f) return a + f;
    return 0.5 * (a + b + Math.sqrt(2 * f * f - (a - b) * (a - b)));
  };
  while (heap.size > 0) {
    const k = heap.pop();
    if (state[k] === 2) continue;
    state[k] = 2;
    const i = k % res;
    const j = (k / res) | 0;
    let up = -1;
    let upT = Infinity;
    const consider = (nk: number): void => {
      if (state[nk] === 2 && (T[nk] as number) < upT) {
        upT = T[nk] as number;
        up = nk;
      }
    };
    if (i > 0) consider(k - 1);
    if (i < res - 1) consider(k + 1);
    if (j > 0) consider(k - res);
    if (j < res - 1) consider(k + res);
    if (up >= 0) fetch[k] = (fetch[up] as number) + h;
    const relax = (ni: number, nj: number): void => {
      const nk = nj * res + ni;
      if (state[nk] === 2 || (speed[nk] as number) <= 0) return;
      const t = solve(ni, nj);
      if (t < (T[nk] as number)) {
        T[nk] = t;
        state[nk] = 1;
        heap.push(t, nk);
      }
    };
    if (i > 0) relax(i - 1, j);
    if (i < res - 1) relax(i + 1, j);
    if (j > 0) relax(i, j - 1);
    if (j < res - 1) relax(i, j + 1);
  }

  // Extend onto the bank one ring of cells per pass (each pass reads the previous one only).
  const extend = (F: Float32Array, passes: number, inc: number): void => {
    const prev = new Float32Array(N);
    for (let pass = 0; pass < passes; pass++) {
      prev.set(F);
      let changed = false;
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
          const k = j * res + i;
          if (Number.isFinite(prev[k] as number)) continue;
          let s = 0;
          let n = 0;
          const add = (nk: number): void => {
            const v = prev[nk] as number;
            if (Number.isFinite(v)) {
              s += v;
              n++;
            }
          };
          if (i > 0) add(k - 1);
          if (i < res - 1) add(k + 1);
          if (j > 0) add(k - res);
          if (j < res - 1) add(k + res);
          if (n > 0) {
            F[k] = s / n + inc;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  };
  const tShore = new Float32Array(T);
  extend(tShore, 30, 0);
  const tFilled = new Float32Array(T);
  extend(tFilled, 18, h / 1.2);
  const fetchFilled = new Float32Array(fetch);
  for (let k = 0; k < N; k++) if (!Number.isFinite(T[k] as number)) fetchFilled[k] = Infinity;
  extend(fetchFilled, 18, 0);
  // Smooth first-order FMM kinks (keeps the phase monotonic).
  let ts = tFilled;
  for (let it = 0; it < 3; it++) {
    const out = new Float32Array(N);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * res + i;
        const t0 = ts[k] as number;
        if (!Number.isFinite(t0)) {
          out[k] = t0;
          continue;
        }
        let s = t0 * 4;
        let w = 4;
        const add = (nk: number): void => {
          const v = ts[nk] as number;
          if (Number.isFinite(v)) {
            s += v;
            w++;
          }
        };
        if (i > 0) add(k - 1);
        if (i < res - 1) add(k + 1);
        if (j > 0) add(k - res);
        if (j < res - 1) add(k + res);
        out[k] = s / w;
      }
    }
    ts = out;
  }

  const data = new Float32Array(N * 4);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const t = ts[k] as number;
      const at = (kk: number): number => ts[kk] as number;
      const tl = i > 0 ? at(k - 1) : t;
      const tr = i < res - 1 ? at(k + 1) : t;
      const td = j > 0 ? at(k - res) : t;
      const tu = j < res - 1 ? at(k + res) : t;
      const diff = (a: number, b: number): number => (Number.isFinite(a) && Number.isFinite(b) ? a - b : 0);
      let gx = diff(tr, tl);
      let gz = diff(tu, td);
      if (gx === 0 && Number.isFinite(tr) && Number.isFinite(t)) gx = tr - t;
      if (gz === 0 && Number.isFinite(tu) && Number.isFinite(t)) gz = tu - t;
      const len = Math.hypot(gx, gz) || 1;
      const dx = gx / len;
      const dz = gz / len;
      // Fetch-limited growth (height ∝ √fetch), less where the front has turned away from the wind.
      const f = fetchFilled[k] as number;
      const grown = Number.isFinite(f) ? Math.min(1, Math.sqrt(f / LAKE_WAVES.fullFetchM)) : 0;
      const align = dx * sdx + dz * sdz;
      const exposure = Math.max(0.02, grown * Math.min(1, Math.max(0.25, align * 0.9 + 0.35)));
      data[k * 4] = Number.isFinite(t) ? t : 1e5;
      data[k * 4 + 1] = dx * exposure;
      data[k * 4 + 2] = dz * exposure;
      const tsh = tShore[k] as number;
      data[k * 4 + 3] = Number.isFinite(tsh) ? tsh : Number.isFinite(t) ? t : 1e5;
    }
  }
  return { data, res, cellM: h };
}

export interface ShoreField {
  texture: DataTexture;
  domain: FieldDomain;
}

export function shoreFieldTexture(f: ShoreFieldData): DataTexture {
  const t = new DataTexture(f.data, f.res, f.res, RGBAFormat, FloatType);
  // 32-bit float: arrival times reach hundreds of seconds, beyond half-float precision.
  // Not every GPU can filter float32, so it is read with loads and blended by hand.
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** The field at a world XZ position, bilinear from four texel loads (clamped at the domain edge). */
export function shoreSample(field: ShoreField, xz: Node<'vec2'>): Node<'vec4'> {
  const { res, x0, z0, sizeM } = field.domain;
  const g = xz.sub(vec2(x0, z0)).div(sizeM / res).sub(0.5);
  const cell = floor(g);
  const f = fract(g);
  const clampI = (v: Node<'float'>): Node<'float'> => v.clamp(0, res - 1);
  const xa = clampI(cell.x);
  const za = clampI(cell.y);
  const xb = clampI(cell.x.add(1));
  const zb = clampI(cell.y.add(1));
  const at = (x: Node<'float'>, z: Node<'float'>): Node<'vec4'> => textureLoad(field.texture, ivec2(int(x), int(z))) as unknown as Node<'vec4'>;
  return mix(mix(at(xa, za), at(xb, za), f.x), mix(at(xa, zb), at(xb, zb), f.x), f.y);
}
