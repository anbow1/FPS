import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { attribute, float, mix, mx_noise_float, positionLocal, smoothstep, texture, uv, vec2, vec3 } from 'three/tsl';
import { BufferAttribute, type BufferGeometry, ExtrudeGeometry, Matrix4, MeshStandardNodeMaterial, Shape, type Texture, Vector2 } from 'three/webgpu';

// Parts for guns that read as machined and moulded, not as boxes: each part is
// cut from its real outline (a side profile, or a cross-section along the
// barrel), its corners filleted and its edges rounded by a bevel, the normals
// smooth across the bevel and hard between the flat faces — the thin line of
// light along every edge that a box's knife edge never catches. Each vertex
// carries `edge`, 0 on the flat faces and 1 on the middle of a bevel, so the
// finish wears through to bare steel, or the varnish to pale wood, where hands
// and holsters rub it off first.

type Pt = readonly [number, number];

/**
 * A closed outline with its corners filleted: `radius` per corner (m) or one for all. Points run
 * counter-clockwise in the shape's plane.
 */
export function filleted(points: readonly Pt[], radius: number | readonly number[]): Shape {
  const n = points.length;
  const s = new Shape();
  const at = (i: number): Vector2 => new Vector2(...(points[((i % n) + n) % n] as Pt));
  for (let i = 0; i < n; i++) {
    const p = at(i);
    const prev = at(i - 1);
    const next = at(i + 1);
    const r = typeof radius === 'number' ? radius : ((radius[i] as number | undefined) ?? 0);
    const inLen = p.distanceTo(prev);
    const outLen = p.distanceTo(next);
    const rr = Math.min(r, inLen * 0.45, outLen * 0.45);
    const a = p.clone().addScaledVector(prev.clone().sub(p).normalize(), rr);
    const b = p.clone().addScaledVector(next.clone().sub(p).normalize(), rr);
    if (i === 0) s.moveTo(a.x, a.y);
    else s.lineTo(a.x, a.y);
    if (rr > 1e-5) s.quadraticCurveTo(p.x, p.y, b.x, b.y);
  }
  s.closePath();
  return s;
}

/** Smooth normals over the bevels, hard creases between faces, and the `edge` attribute from the extrusion axis. */
function finish(g: BufferGeometry): BufferGeometry {
  const out = toCreasedNormals(g, Math.PI / 5);
  const nrm = out.getAttribute('normal');
  const edge = new Float32Array(nrm.count);
  for (let i = 0; i < nrm.count; i++) {
    // Caps face along the extrusion (|nz| = 1), the sides across it (nz = 0); the bevel turns between them.
    const t = Math.abs(nrm.getZ(i));
    edge[i] = Math.max(0, 1 - Math.abs(t - 0.7071) / 0.32);
  }
  out.setAttribute('edge', new BufferAttribute(edge, 1));
  return out;
}

function extrude(shape: Shape, depth: number, bevel: number, segments: number): ExtrudeGeometry {
  return new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    // The bevel cuts inward, so the outline stays the part's outer edge.
    bevelOffset: -bevel,
    bevelSegments: segments,
    curveSegments: 6,
  });
}

/**
 * A part cut from its side profile: `outline` in (z, y) model metres (−Z forward), `width` across x
 * centred on `x`, corners filleted by `fillet`, edges rounded by `bevel`.
 */
export function sidePart(outline: readonly Pt[], width: number, bevel: number, fillet: number | readonly number[] = 0.002, x = 0, segments = 3): BufferGeometry {
  const g = finish(extrude(filleted(outline, fillet), width, bevel, segments));
  // Shape (x, y) is model (z, y); the extrusion runs along x. A rotation, so the winding holds.
  const d = Math.max(1e-4, width - 2 * bevel);
  g.applyMatrix4(new Matrix4().set(0, 0, -1, x + d / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  return g;
}

/** A part from its cross-section: `section` in (x, y) model metres, run along z from `z0` back to `z1` (> z0). */
export function sectionPart(section: readonly Pt[], z0: number, z1: number, bevel: number, fillet: number | readonly number[] = 0.002, segments = 3): BufferGeometry {
  const g = finish(extrude(filleted(section, fillet), z1 - z0, bevel, segments));
  g.translate(0, 0, z0 + bevel);
  // The extrusion's side walls run v along the part; swap so u runs along it, as on the profiles' faces —
  // a wood grain laid along u then follows every part's length, not across a handguard.
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getY(i), uv.getX(i));
  return g;
}

/** An arc of points (x, y) about (cx, cy), radii rx, ry, from angle a0 to a1 (rad), `n` steps. */
export function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

/** Scales x by `k(z)` (m): grips and stocks swell and taper along their length. */
export function taperX(g: BufferGeometry, k: (z: number) => number): BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) * k(pos.getZ(i)));
  g.computeBoundingSphere();
  return g;
}

/** Fine noise in the model's own space (positionLocal: a viewmodel is not instanced). */
function grain(scale: number, seed: number) {
  return mx_noise_float(positionLocal.mul(scale).add(vec3(seed, seed * 1.7, seed * 0.3)));
}

/**
 * Phosphated or blued steel, dark and matte, worn to bright bare metal on the bevels where the noise
 * lets it through — the more `wear`, the wider.
 */
export function steelMaterial(name: string, colour: [number, number, number], wear: number, roughness = 0.55): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, metalness: 0 });
  const edge = attribute('edge', 'float');
  const n = grain(260, 3.1).mul(0.5).add(0.5);
  const blotch = grain(40, 7.7).mul(0.5).add(0.5);
  const worn = smoothstep(0.55, 0.85, edge.mul(float(0.45).add(n.mul(0.9))).mul(wear).add(blotch.sub(0.8).max(0).mul(wear * 0.6)));
  const finishColour = vec3(...colour).mul(float(0.85).add(blotch.mul(0.3)));
  m.colorNode = mix(finishColour, vec3(0.55, 0.55, 0.56), worn);
  m.metalnessNode = mix(float(0.15), float(1), worn);
  m.roughnessNode = mix(float(roughness).add(n.sub(0.5).mul(0.12)), float(0.28), worn);
  return m;
}

/** Varnished wood from a grain texture laid along the part (u along it), the varnish worn pale on the bevels. */
export function woodMaterial(name: string, map: Texture, repeat: [number, number]): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name, metalness: 0 });
  const edge = attribute('edge', 'float');
  const wood = texture(map, uv().mul(vec2(...repeat))).rgb;
  const n = grain(180, 5.3).mul(0.5).add(0.5);
  const worn = smoothstep(0.5, 0.9, edge.mul(float(0.5).add(n)));
  m.colorNode = mix(wood, wood.mul(1.45).add(vec3(0.03, 0.02, 0.01)), worn);
  m.roughnessNode = mix(float(0.38).add(n.mul(0.1)), float(0.8), worn);
  return m;
}
