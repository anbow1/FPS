import type { HitPart, P3, ThreatKind } from './events.ts';

// What a bullet, a knife or a thrown stone can hit besides the world: the
// creatures and the guerrillas, each a handful of spheres laid along its body
// every step (head, chest, hips, tail…) from the same pose the renderer draws,
// so what you see is what you hit. Headless: no THREE.

export interface HitSphere {
  x: number;
  y: number;
  z: number;
  r: number;
  part: HitPart;
}

export interface Target {
  readonly id: number;
  readonly kind: ThreatKind;
  alive: boolean;
  readonly hitSpheres: HitSphere[];
  /** Takes damage at a part, from a direction; returns true if it died of it. */
  hurt(amount: number, part: HitPart, dir: P3, byPlayer: boolean): boolean;
}

export interface TargetHit {
  target: Target;
  part: HitPart;
  t: number;
  x: number;
  y: number;
  z: number;
}

/** Nearest sphere the ray o + d·t (|d| = 1) enters within [0, maxT], over every live target. */
export function rayTargets(o: P3, d: P3, maxT: number, targets: Iterable<Target>, ignoreId = -1): TargetHit | null {
  let best: TargetHit | null = null;
  for (const tg of targets) {
    if (!tg.alive || tg.id === ignoreId) continue;
    for (const s of tg.hitSpheres) {
      const ox = o.x - s.x;
      const oy = o.y - s.y;
      const oz = o.z - s.z;
      const b = ox * d.x + oy * d.y + oz * d.z;
      const c = ox * ox + oy * oy + oz * oz - s.r * s.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      const at = t < 0 && c < 0 ? 0 : t; // starting inside: a hit at once
      if (at < 0 || at > maxT) continue;
      if (!best || at < best.t) best = { target: tg, part: s.part, t: at, x: o.x + d.x * at, y: o.y + d.y * at, z: o.z + d.z * at };
    }
  }
  return best;
}

/** Writes a sphere into a target's list (reusing the slot), so per-step pose updates allocate nothing. */
export function setSphere(list: HitSphere[], i: number, x: number, y: number, z: number, r: number, part: HitPart): void {
  const s = list[i];
  if (s) {
    s.x = x;
    s.y = y;
    s.z = z;
    s.r = r;
    s.part = part;
  } else list[i] = { x, y, z, r, part };
}
