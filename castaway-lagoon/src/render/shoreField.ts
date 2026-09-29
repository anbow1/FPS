import { floor, fract, int, ivec2, mix, textureLoad, vec2 } from 'three/tsl';
import { DataTexture, FloatType, NearestFilter, type Node, RGBAFormat } from 'three/webgpu';
import { SHORE, WATER_LEVEL_M } from '../config.ts';
import { heightAt } from '../game/terrain.ts';

// Offline wave-propagation field for the shoreline waves, solved once at load.
//
// The Eikonal equation |∇T| = 1 / c(x) is solved with the Fast Marching Method
// over the real seabed, where c is the phase speed of the swell at the local
// depth (linear dispersion, Eckart's approximation). The domain border is the
// source: a plane wave travelling along SHORE.swellDir. Wave fronts therefore
// slow and bunch up in the shallows, bend around the headlands and through the
// channel, and turn to meet the beach along its depth contours.
//
// Ported from Tidewater's ShoreField (Dan Greenheck, MIT licence,
// github.com/dgreenheck/tidewater), with two changes for the lagoon: full
// dispersion instead of the shallow-water speed (so deep-water phase matches
// the plane wave exactly), and a path loss that calms waves which reached the
// lagoon through the long, shallow channel.
//
// Texture (RGBA float, res × res over DOMAIN):
//   r  arrival time T (s): the wave phase is ω(t − T)
//   gb propagation direction × exposure (length = how much swell reaches here, 0..1)
//   a  arrival time at the nearest shoreline, carried inland (swash timing on the sand)

export const SHORE_DOMAIN = { x0: -300, z0: -470, sizeM: 620 } as const;

const G = 9.81;

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
  /** Seabed depth below sea level per cell (m, negative on land). */
  depth: Float32Array;
}

/** Ground height at the centre of every cell of a res² grid over SHORE_DOMAIN. */
export function heightGrid(height: (x: number, z: number) => number, res: number): Float32Array {
  const { x0, z0, sizeM } = SHORE_DOMAIN;
  const h = sizeM / res;
  const out = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const z = z0 + (j + 0.5) * h;
    for (let i = 0; i < res; i++) out[j * res + i] = height(x0 + (i + 0.5) * h, z);
  }
  return out;
}

let seabed: Float32Array | null = null;

/**
 * The lagoon's heights on the SHORE.res grid, computed once: the water's depth
 * texture and the wave field both need them, and heightAt is the slow part.
 */
export function seabedHeights(): Float32Array {
  seabed ??= heightGrid(heightAt, SHORE.res);
  return seabed;
}

export function computeShoreField(heights: Float32Array = seabedHeights(), res: number = SHORE.res): ShoreFieldData {
  if (heights.length !== res * res) throw new Error(`shore field: ${heights.length} heights for a ${res}² grid`);
  const { x0, z0, sizeM } = SHORE_DOMAIN;
  const h = sizeM / res;
  const N = res * res;
  const omega = (2 * Math.PI) / SHORE.periodS;
  const depth = new Float32Array(N);
  const speed = new Float32Array(N);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const d = WATER_LEVEL_M - (heights[j * res + i] as number);
      depth[j * res + i] = d;
      speed[j * res + i] = d > 0 ? phaseSpeed(omega, Math.min(Math.max(d, SHORE.minDepthM), SHORE.maxDepthM)) : 0;
    }
  }

  const T = new Float32Array(N).fill(Infinity);
  const loss = new Float32Array(N); // Σ ds / depth along the path the front took
  const state = new Uint8Array(N); // 0 far, 1 trial, 2 known
  const heap = new MinHeap(N);
  const sl = Math.hypot(SHORE.swellDir.x, SHORE.swellDir.z);
  const sdx = SHORE.swellDir.x / sl;
  const sdz = SHORE.swellDir.z / sl;
  const c0 = phaseSpeed(omega, SHORE.maxDepthM);
  // Plane-wave initial condition on the border water cells (offset keeps T positive).
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      if (i !== 0 && j !== 0 && i !== res - 1 && j !== res - 1) continue;
      const k = j * res + i;
      if ((speed[k] as number) <= 0) continue;
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
    // Path loss from the upwind neighbour (the known one the front arrived from).
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
    if (up >= 0) loss[k] = (loss[up] as number) + h / Math.max(depth[k] as number, 0.5);
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

  // Extend a field onto land one ring of cells per pass (average of the known neighbours + inc).
  // Each pass reads the previous pass only, so values never sweep across land in one pass.
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
  // Arrival at the nearest shoreline, carried unchanged onto the land (swash timing).
  const tShore = new Float32Array(T);
  extend(tShore, 40, 0);
  // T continued slowly up the beach, so the swash zone has a continuous phase.
  const tFilled = new Float32Array(T);
  extend(tFilled, 24, h / 1.5);
  const lossFilled = new Float32Array(loss);
  for (let k = 0; k < N; k++) if (!Number.isFinite(T[k] as number)) lossFilled[k] = Infinity;
  extend(lossFilled, 24, 0);

  // Smooth out first-order FMM kinks (keeps the phase monotonic).
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
      // Exposure: how squarely the local front faces the incoming swell, times the channel's losses.
      const align = dx * sdx + dz * sdz;
      const lossK = Math.exp(-SHORE.channelLossPerM * (Number.isFinite(lossFilled[k] as number) ? (lossFilled[k] as number) : 1e3));
      const exposure = Math.min(1, Math.max(0.02, align * 1.4 + 0.1)) * lossK;
      data[k * 4] = Number.isFinite(t) ? t : 1e5;
      data[k * 4 + 1] = dx * exposure;
      data[k * 4 + 2] = dz * exposure;
      const tsh = tShore[k] as number;
      data[k * 4 + 3] = Number.isFinite(tsh) ? tsh : Number.isFinite(t) ? t : 1e5;
    }
  }
  return { data, res, cellM: h, depth };
}

let fieldTexture: DataTexture | null = null;

/** The baked field as a float texture (built on first use, ~0.3 s at 512²). */
export function shoreFieldTexture(): DataTexture {
  if (fieldTexture) return fieldTexture;
  const f = computeShoreField();
  const t = new DataTexture(f.data, f.res, f.res, RGBAFormat, FloatType);
  // 32-bit float: arrival times reach several hundred seconds, beyond half-float precision.
  // Not every GPU can filter float32, so it is read with loads and blended by hand.
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  fieldTexture = t;
  return t;
}

/** The field at a world XZ position, bilinear from four texel loads (clamped at the domain edge). */
export function shoreSample(xz: Node<'vec2'>): Node<'vec4'> {
  const tex = shoreFieldTexture();
  const res = SHORE.res;
  const g = xz.sub(vec2(SHORE_DOMAIN.x0, SHORE_DOMAIN.z0)).div(SHORE_DOMAIN.sizeM / res).sub(0.5);
  const cell = floor(g);
  const f = fract(g);
  const clampI = (v: Node<'float'>): Node<'float'> => v.clamp(0, res - 1);
  const x0 = clampI(cell.x);
  const z0 = clampI(cell.y);
  const x1 = clampI(cell.x.add(1));
  const z1 = clampI(cell.y.add(1));
  const at = (x: Node<'float'>, z: Node<'float'>): Node<'vec4'> => textureLoad(tex, ivec2(int(x), int(z))) as unknown as Node<'vec4'>;
  return mix(mix(at(x0, z0), at(x1, z0), f.x), mix(at(x0, z1), at(x1, z1), f.x), f.y);
}
