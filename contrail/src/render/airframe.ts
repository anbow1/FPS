import { BufferAttribute, BufferGeometry } from 'three/webgpu';

// Geometry builders for procedural airframes: a lofted fuselage from
// superellipse cross-sections, lifting surfaces from a NACA 4-digit thickness
// distribution over a trapezoid planform, and bodies of revolution (nacelles,
// nozzles, drop tanks). All in metres, in the aircraft's own frame: x right,
// y up, nose towards −z (rules §6: fix orientation in the asset, never with a
// wrapper rotation).

export interface Section {
  /** Station along the body (m, −z = forward). */
  z: number;
  halfWidthM: number;
  halfHeightM: number;
  /** Height of the section centre (m). */
  centreYM: number;
  /** Superellipse exponent: 2 = ellipse, < 2 diamond-ish (chines), > 2 boxy. */
  exponent: number;
  /** Squashes the lower half (1 = symmetric, < 1 flatter belly). */
  bellyScale?: number;
}

/** A closed loft through the sections, `around` points per ring, with capped ends. */
export function loft(sections: readonly Section[], around = 32): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const s of sections) {
    for (let i = 0; i < around; i++) {
      const t = (i / around) * Math.PI * 2;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const e = 2 / s.exponent;
      const x = Math.sign(c) * Math.pow(Math.abs(c), e) * s.halfWidthM;
      let y = Math.sign(sn) * Math.pow(Math.abs(sn), e) * s.halfHeightM;
      if (y < 0) y *= s.bellyScale ?? 1;
      positions.push(x, s.centreYM + y, s.z);
    }
  }
  for (let r = 0; r < sections.length - 1; r++) {
    for (let i = 0; i < around; i++) {
      const a = r * around + i;
      const b = r * around + ((i + 1) % around);
      const c = (r + 1) * around + i;
      const d = (r + 1) * around + ((i + 1) % around);
      indices.push(a, c, b, b, c, d);
    }
  }
  // End caps (fans to the ring centre).
  for (const [ring, flip] of [
    [0, true],
    [sections.length - 1, false],
  ] as const) {
    const s = sections[ring];
    if (!s) continue;
    const centre = positions.length / 3;
    positions.push(0, s.centreYM, s.z);
    for (let i = 0; i < around; i++) {
      const a = ring * around + i;
      const b = ring * around + ((i + 1) % around);
      if (flip) indices.push(centre, a, b);
      else indices.push(centre, b, a);
    }
  }
  return finish(positions, indices);
}

export interface Surface {
  /** Root leading edge (m) and root chord (m). */
  rootX: number;
  rootY: number;
  rootLeZ: number;
  rootChordM: number;
  /** Tip position: distance along the span direction from the root (m). */
  spanM: number;
  tipLeZ: number;
  tipChordM: number;
  /** Thickness / chord at root and tip. */
  rootThickness: number;
  tipThickness: number;
  /** Span direction angle from +x towards +y (rad): 0 = flat wing, π/2 = vertical fin. */
  dihedralRad: number;
  /** Mirror to the left side as well. */
  mirror: boolean;
}

/** A lifting surface with a NACA 00xx thickness profile, closed at root and tip. */
export function surface(s: Surface, chordPoints = 14, spanPoints = 6): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const sides = s.mirror ? [1, -1] : [1];
  for (const side of sides) {
    const base = positions.length / 3;
    const ring = chordPoints * 2;
    const sx = Math.cos(s.dihedralRad) * side;
    const sy = Math.sin(s.dihedralRad);
    // Thickness direction: perpendicular to the span, in the x-y plane.
    const tx = -Math.sin(s.dihedralRad) * side;
    const ty = Math.cos(s.dihedralRad);
    for (let j = 0; j <= spanPoints; j++) {
      const f = j / spanPoints;
      const chord = s.rootChordM + (s.tipChordM - s.rootChordM) * f;
      const le = s.rootLeZ + (s.tipLeZ - s.rootLeZ) * f;
      const thick = (s.rootThickness + (s.tipThickness - s.rootThickness) * f) * chord;
      const ox = s.rootX * side + sx * s.spanM * f;
      const oy = s.rootY + sy * s.spanM * f;
      for (let k = 0; k < ring; k++) {
        // Upper surface LE → TE, then lower surface TE → LE, cosine spacing towards the leading edge.
        const upper = k < chordPoints;
        const u = upper ? k / (chordPoints - 1) : 1 - (k - chordPoints) / (chordPoints - 1);
        const xc = (1 - Math.cos(u * Math.PI)) / 2;
        const half = nacaHalfThickness(xc) * thick;
        const off = upper ? half : -half;
        positions.push(ox + tx * off, oy + ty * off, le + xc * chord);
      }
    }
    for (let j = 0; j < spanPoints; j++) {
      for (let k = 0; k < ring; k++) {
        const a = base + j * ring + k;
        const b = base + j * ring + ((k + 1) % ring);
        const c = base + (j + 1) * ring + k;
        const d = base + (j + 1) * ring + ((k + 1) % ring);
        if (side > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
    // Tip cap.
    const tip = base + spanPoints * ring;
    for (let k = 1; k < chordPoints - 1; k++) {
      const top = tip + k;
      const nextTop = tip + k + 1;
      const bottom = tip + ring - k;
      const nextBottom = tip + ring - k - 1;
      if (side > 0) indices.push(top, nextBottom, nextTop, top, bottom, nextBottom);
      else indices.push(top, nextTop, nextBottom, top, nextBottom, bottom);
    }
  }
  return finish(positions, indices);
}

/** A body of revolution along z: `profile` is [z, radius] pairs, centred at (x, y). */
export function lathe(profile: readonly (readonly [number, number])[], x: number, y: number, around = 20, open = false): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [z, r] of profile) {
    for (let i = 0; i < around; i++) {
      const t = (i / around) * Math.PI * 2;
      positions.push(x + Math.cos(t) * r, y + Math.sin(t) * r, z);
    }
  }
  for (let p = 0; p < profile.length - 1; p++) {
    for (let i = 0; i < around; i++) {
      const a = p * around + i;
      const b = p * around + ((i + 1) % around);
      const c = (p + 1) * around + i;
      const d = (p + 1) * around + ((i + 1) % around);
      indices.push(a, c, b, b, c, d);
    }
  }
  if (!open) {
    const last = profile.length - 1;
    const lastEntry = profile[last];
    if (lastEntry) {
      const centre = positions.length / 3;
      positions.push(x, y, lastEntry[0]);
      for (let i = 0; i < around; i++) indices.push(centre, last * around + ((i + 1) % around), last * around + i);
    }
  }
  return finish(positions, indices);
}

/** NACA 4-digit symmetric half-thickness for thickness 1 (closed trailing edge). */
function nacaHalfThickness(x: number): number {
  return 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
}

function finish(positions: number[], indices: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
