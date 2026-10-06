import type { Vec3 } from './vec.ts';

// Unit quaternion for orientations in the logic layer (no three.js here,
// rules §2.5). Same convention as three.js: (x, y, z, w), rotating body-frame
// vectors into the world frame.

export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q: Quat): this {
    return this.set(q.x, q.y, q.z, q.w);
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  normalize(): this {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    return this.set(this.x / l, this.y / l, this.z / l, this.w / l);
  }

  /** Rotation of `angleRad` about the unit axis (ax, ay, az). */
  setAxisAngle(ax: number, ay: number, az: number, angleRad: number): this {
    const s = Math.sin(angleRad / 2);
    return this.set(ax * s, ay * s, az * s, Math.cos(angleRad / 2));
  }

  /** this = a · b (apply b, then a). */
  multiplyQuats(a: Quat, b: Quat): this {
    const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    return this.set(x, y, z, w);
  }

  /** Body → world: rotates `v` in place. */
  rotate(v: Vec3): Vec3 {
    const { x, y, z, w } = this;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return v.set(ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x);
  }

  /** World → body: rotates `v` in place by the inverse. */
  unrotate(v: Vec3): Vec3 {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    this.rotate(v);
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return v;
  }

  /**
   * Integrates a body-frame angular velocity (rad/s) over `dtS`:
   * q ← q · exp(½ ω dt), renormalised.
   */
  integrateBodyRate(wx: number, wy: number, wz: number, dtS: number): this {
    const rate = Math.hypot(wx, wy, wz);
    if (rate < 1e-12) return this;
    const angle = rate * dtS;
    const s = Math.sin(angle / 2) / rate;
    scratchA.copy(this);
    scratchB.set(wx * s, wy * s, wz * s, Math.cos(angle / 2));
    return this.multiplyQuats(scratchA, scratchB).normalize();
  }

  /** Orientation from yaw (about +Y, 0 = facing −Z), pitch (nose up +) and roll (right wing down +), applied yaw → pitch → roll. */
  setFromYawPitchRoll(yawRad: number, pitchRad: number, rollRad: number): this {
    const qy = new Quat().setAxisAngle(0, 1, 0, yawRad);
    const qp = new Quat().setAxisAngle(1, 0, 0, pitchRad);
    const qr = new Quat().setAxisAngle(0, 0, 1, -rollRad);
    return this.multiplyQuats(qy, new Quat().multiplyQuats(qp, qr));
  }
}

// Scratch for the per-substep integration: no allocation in the hot loop (rules §10).
const scratchA = new Quat();
const scratchB = new Quat();
