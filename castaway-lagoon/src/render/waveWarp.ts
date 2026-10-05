import { float, floor, fract, hash, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

// Domain warp for a tiled wave patch, shared file for file by Castaway Lagoon
// and Tanks (docs/graphics-playbook.md §7.9). After ClearWater6.1's wave_warp
// by SamG-Coder (MIT): the FFT patch is looked up through a smooth offset field
// tens of metres across, so the eye cannot find its period; the slopes are
// carried through the offset's Jacobian, so the normals still belong to the
// displaced surface.

type N2 = Node<'vec2'>;
type N3 = Node<'vec3'>;

/** A C2 value-noise field on unit cells: vec3(value 0–1, ∂/∂x, ∂/∂z), quintic fade with its derivative. */
function noiseField(p: N2, seed: number): N3 {
  const i = floor(p);
  const f = fract(p);
  const corner = (dx: number, dz: number): Node<'float'> => hash(i.x.add(dx).mul(127.1).add(i.y.add(dz).mul(311.7)).add(seed));
  const a = corner(0, 0);
  const b = corner(1, 0);
  const c = corner(0, 1);
  const d = corner(1, 1);
  const quintic = (t: Node<'float'>): Node<'float'> => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
  const quinticD = (t: Node<'float'>): Node<'float'> => t.mul(t).mul(t.sub(1)).mul(t.sub(1)).mul(30);
  const u = quintic(f.x);
  const v = quintic(f.y);
  const du = quinticD(f.x);
  const dv = quinticD(f.y);
  const value = a.add(b.sub(a).mul(u)).add(c.sub(a).mul(v)).add(a.sub(b).sub(c).add(d).mul(u).mul(v));
  const ddx = b.sub(a).add(a.sub(b).sub(c).add(d).mul(v)).mul(du);
  const ddz = c.sub(a).add(a.sub(b).sub(c).add(d).mul(u)).mul(dv);
  return vec3(value, ddx, ddz);
}

export interface WaveWarp {
  /** Where to look the patch up instead of xz (metres). */
  lookup: N2;
  /** Turns a slope (∂h/∂x, ∂h/∂z) read at `lookup` into the slope of the warped surface at xz. */
  slope: (s: N2) => N2;
}

/**
 * Warp for a patch: offsets of up to ±amplitudeM/2 varying over cellM metres. ClearWater uses
 * a cell four times the patch and an amplitude about a sixth of the cell (24 m and 4.2 m for its
 * 6 m patch).
 */
export function waveWarp(xz: N2, cellM: number, amplitudeM: number, seed: number): WaveWarp {
  const q = xz.div(cellM);
  const a = noiseField(q, seed);
  const b = noiseField(q, seed + 41.7);
  const k = float(amplitudeM / cellM);
  const lookup = xz.add(vec2(a.x.sub(0.5), b.x.sub(0.5)).mul(amplitudeM));
  // d(lookup)/d(xz) = I + amplitude·∇noise; the chain rule maps the patch slope back to xz.
  const slope = (s: N2): N2 => vec2(s.x.mul(a.y.mul(k).add(1)).add(s.y.mul(b.y.mul(k))), s.x.mul(a.z.mul(k)).add(s.y.mul(b.z.mul(k).add(1))));
  return { lookup, slope };
}
