import { G_TOLERANCE } from '../config.ts';

// The pilot's tolerance to sustained G as a pool that drains and recovers
// (tuned by hand against the brief): above ~5.5 G blood leaves the head, grey-out
// and tunnel vision build as the pool empties (a sustained 7 G greys out in
// about 15 s, 9 G in about 5 s); below 4 G it refills. Negative G fills the head
// instead: a separate red-out pool.

export interface GTolerance {
  /** 1 = rested, 0 = grey-out complete (G-LOC). */
  pool: number;
  /** 0 … 1 red-out from sustained negative G. */
  redOut: number;
  /** Seconds of G-induced loss of consciousness left (controls dead). */
  glocS: number;
}

export function createGTolerance(): GTolerance {
  return { pool: 1, redOut: 0, glocS: 0 };
}

export function stepGTolerance(g: GTolerance, loadFactor: number, dtS: number): void {
  const t = G_TOLERANCE;
  if (loadFactor > t.drainOnsetG) g.pool -= (loadFactor - t.drainOnsetG) * t.drainPerGs * dtS;
  else if (loadFactor < t.recoverBelowG) g.pool += t.recoverPerS * dtS;
  g.pool = Math.min(1, Math.max(0, g.pool));
  if (loadFactor < t.redOutOnsetG) g.redOut += (t.redOutOnsetG - loadFactor) * t.redOutPerGs * dtS;
  else g.redOut -= 0.35 * dtS;
  g.redOut = Math.min(1, Math.max(0, g.redOut));
  if (g.pool <= 0 && g.glocS <= 0) g.glocS = 6;
  if (g.glocS > 0) {
    g.glocS -= dtS;
    if (g.glocS <= 0) g.pool = 0.25;
  }
}

/** Visual grey-out 0 … 1 (desaturation and tunnel) from the pool. */
export function greyOut(g: GTolerance): number {
  if (g.glocS > 0) return 1;
  const x = Math.min(1, Math.max(0, (0.55 - g.pool) / 0.55));
  return x * x * (3 - 2 * x);
}
