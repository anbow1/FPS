import { HITBOX, PLAYER } from '../config.ts';
import { Vec3 } from '../core/vec.ts';
import { type BoxCollider, rayBox, type RayBoxHit } from './collision.ts';

// Shared body model for the player and the AI: stance, per-part hitboxes and
// the effects each part carries (damage model brief).

export type Stance = 'stand' | 'crouch' | 'prone';
export type BodyPart = 'head' | 'chest' | 'abdomen' | 'armL' | 'armR' | 'legL' | 'legR';
export type Team = 'player' | 'enemy';

export const BODY_PARTS: readonly BodyPart[] = ['head', 'chest', 'abdomen', 'armL', 'armR', 'legL', 'legR'];

export function partMultiplier(part: BodyPart): number {
  switch (part) {
    case 'head':
      return HITBOX.headMultiplier;
    case 'chest':
      return HITBOX.chestMultiplier;
    case 'abdomen':
      return HITBOX.abdomenMultiplier;
    case 'armL':
    case 'armR':
      return HITBOX.armMultiplier;
    case 'legL':
    case 'legR':
      return HITBOX.legMultiplier;
  }
}

interface PartLayout {
  offset: [number, number, number]; // x right, y up, z forward(-) in the actor frame, feet origin
  size: [number, number, number];
}

// Sizes from the scale sheet soldier (H 1.83 m, W 0.60 m with kit, depth 0.45 m).
const LAYOUT: Record<Stance, Record<BodyPart, PartLayout>> = {
  stand: {
    head: { offset: [0, 1.62, 0], size: [0.22, 0.28, 0.25] },
    chest: { offset: [0, 1.3, 0], size: [0.44, 0.38, 0.3] },
    abdomen: { offset: [0, 0.99, 0], size: [0.36, 0.26, 0.26] },
    armL: { offset: [-0.26, 1.2, -0.12], size: [0.12, 0.55, 0.14] },
    armR: { offset: [0.24, 1.2, -0.16], size: [0.12, 0.55, 0.14] },
    legL: { offset: [-0.11, 0.44, 0], size: [0.17, 0.88, 0.19] },
    legR: { offset: [0.11, 0.44, 0], size: [0.17, 0.88, 0.19] },
  },
  crouch: {
    head: { offset: [0, 1.1, -0.1], size: [0.22, 0.28, 0.25] },
    chest: { offset: [0, 0.82, -0.05], size: [0.44, 0.36, 0.32] },
    abdomen: { offset: [0, 0.55, 0], size: [0.36, 0.24, 0.28] },
    armL: { offset: [-0.26, 0.72, -0.2], size: [0.12, 0.45, 0.16] },
    armR: { offset: [0.24, 0.72, -0.22], size: [0.12, 0.45, 0.16] },
    legL: { offset: [-0.13, 0.25, -0.1], size: [0.18, 0.5, 0.5] },
    legR: { offset: [0.13, 0.25, 0.05], size: [0.18, 0.5, 0.5] },
  },
  prone: {
    head: { offset: [0, 0.3, -0.85], size: [0.22, 0.25, 0.26] },
    chest: { offset: [0, 0.18, -0.45], size: [0.44, 0.28, 0.4] },
    abdomen: { offset: [0, 0.14, -0.1], size: [0.36, 0.24, 0.28] },
    armL: { offset: [-0.28, 0.14, -0.8], size: [0.12, 0.12, 0.5] },
    armR: { offset: [0.26, 0.14, -0.85], size: [0.12, 0.12, 0.5] },
    legL: { offset: [-0.13, 0.1, 0.45], size: [0.17, 0.17, 0.9] },
    legR: { offset: [0.13, 0.1, 0.45], size: [0.17, 0.17, 0.9] },
  },
};

export interface Hitbox {
  part: BodyPart;
  box: BoxCollider;
}

function makeBox(): BoxCollider {
  return {
    id: -1,
    center: new Vec3(),
    halfExtents: new Vec3(),
    yawRad: 0,
    cosYaw: 1,
    sinYaw: 0,
    surface: 'flesh',
    blocksVision: false,
    blocksMovement: false,
    minX: 0,
    maxX: 0,
    minZ: 0,
    maxZ: 0,
    minY: 0,
    maxY: 0,
    stamp: 0,
  };
}

export class BodyHitboxes {
  readonly parts: Hitbox[] = BODY_PARTS.map((part) => ({ part, box: makeBox() }));
  /** Bounding sphere for a cheap reject before the part tests. */
  readonly boundCenter = new Vec3();
  boundRadiusM = 1.2;

  /** Rebuild world-space hitboxes from feet position, yaw and stance. leanM shifts the upper body sideways. */
  update(feet: Vec3, yawRad: number, stance: Stance, leanM: number): void {
    const c = Math.cos(yawRad);
    const s = Math.sin(yawRad);
    const layout = LAYOUT[stance];
    for (const hb of this.parts) {
      const l = layout[hb.part];
      const upper = hb.part !== 'legL' && hb.part !== 'legR';
      const lx = l.offset[0] + (upper ? leanM : 0);
      const lz = l.offset[2];
      // Local → world, rotation by yaw about Y (same convention as collision.ts).
      hb.box.center.set(feet.x + c * lx + s * lz, feet.y + l.offset[1], feet.z - s * lx + c * lz);
      hb.box.halfExtents.set(l.size[0] / 2, l.size[1] / 2, l.size[2] / 2);
      hb.box.yawRad = yawRad;
      hb.box.cosYaw = c;
      hb.box.sinYaw = s;
    }
    this.boundCenter.set(feet.x, feet.y + (stance === 'prone' ? 0.25 : stance === 'crouch' ? 0.65 : 0.95), feet.z);
    this.boundRadiusM = stance === 'prone' ? 1.3 : 1.1;
  }

  /** Closest part the ray hits within maxDistM, or null. */
  raycast(origin: Vec3, dir: Vec3, maxDistM: number): { part: BodyPart; hit: RayBoxHit } | null {
    // Sphere reject.
    _oc.subVectors(this.boundCenter, origin);
    const along = _oc.dot(dir);
    if (along < -this.boundRadiusM || along > maxDistM + this.boundRadiusM) return null;
    const perp2 = _oc.dot(_oc) - along * along;
    if (perp2 > this.boundRadiusM * this.boundRadiusM) return null;
    let best: { part: BodyPart; hit: RayBoxHit } | null = null;
    for (const hb of this.parts) {
      const hit = rayBox(origin, dir, hb.box, maxDistM);
      if (hit && (!best || hit.entryM < best.hit.entryM)) best = { part: hb.part, hit };
    }
    return best;
  }

  partCenter(part: BodyPart): Vec3 {
    const hb = this.parts.find((p) => p.part === part);
    if (!hb) throw new Error(`unknown body part '${part}'`);
    return hb.box.center;
  }
}

const _oc = new Vec3();

export function eyeHeightFor(stance: Stance): number {
  return stance === 'prone' ? PLAYER.eyeProneM : stance === 'crouch' ? PLAYER.eyeCrouchM : PLAYER.eyeStandM;
}
