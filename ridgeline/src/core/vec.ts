// Minimal 3D vector for game logic. Logic never touches THREE (rules §10), so
// systems can run headless in tests. Methods mutate `this` to avoid allocation
// in the frame loop.

export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Vec3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  addScaled(v: Vec3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }

  lengthXZ(): number {
    return Math.hypot(this.x, this.z);
  }

  normalize(): this {
    const len = this.length();
    if (len > 1e-9) this.scale(1 / len);
    return this;
  }

  distanceTo(v: Vec3): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  distanceToXZ(v: Vec3): number {
    return Math.hypot(this.x - v.x, this.z - v.z);
  }

  subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  cross(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  lerp(v: Vec3, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
}

/** Forward unit vector for a yaw/pitch pair. Yaw 0 looks down -Z (rules §4). */
export function directionFromYawPitch(yawRad: number, pitchRad: number, out: Vec3): Vec3 {
  const cp = Math.cos(pitchRad);
  return out.set(-Math.sin(yawRad) * cp, Math.sin(pitchRad), -Math.cos(yawRad) * cp);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. */
export function damp(current: number, target: number, ratePerSecond: number, dtSeconds: number): number {
  return lerp(current, target, 1 - Math.exp(-ratePerSecond * dtSeconds));
}

export function wrapAngle(angleRad: number): number {
  let a = angleRad;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}
