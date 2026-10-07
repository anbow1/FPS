import { abs, attribute, clamp, float, floor, fract, Fn, fwidth, hash, max, min, mix, mx_noise_float, normalLocal, normalView, positionLocal, positionView, smoothstep, step, vec2, vec3 } from 'three/tsl';
import { Color, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from 'three/webgpu';

// Aircraft skin materials (values from pbr-material-reference.png: "aircraft
// grey, matte" #6A6D71 rough 0.58 with panel-line AO for the stealth type,
// "blue-grey camo" #7B8898 rough 0.62 with an exhaust-soot mask for the twin;
// canopy acrylic #DFE6EA rough 0.05).
//
// Everything is drawn in skin coordinates (`surf` = along, across in metres,
// written by airframe.ts), so panels keep their real size on every part:
//   panels    frames at an irregular pitch along the body, splits across that
//             change from bay to bay, a few access panels with rounded corners;
//             recessed seams shade through a bump of their own height;
//   fasteners rows of rivet heads beside the seams on the older airframe,
//             faded out before they would alias;
//   paint     per-panel batch variation, darker seam sealant, edge tape on the
//             stealth type; hard-edged camouflage and a light belly on the twin;
//   weather   flow streaks behind panels and exhaust soot towards the nozzles.
// Invented types: no national markings or numbers (rules §13).

type F = Node<'float'>;
type V3 = Node<'vec3'>;

const lin = (hex: number): V3 => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** Anti-aliased line coverage for a distance field `d` (m) of half-width `w`: fades when thinner than a pixel. */
export function lineAA(d: F, w: number | F): F {
  const px = max(fwidth(d), 1e-5);
  const hw = typeof w === 'number' ? float(w) : w;
  return clamp(hw.add(px.mul(0.5)).sub(d).div(px), 0, 1).mul(clamp(hw.mul(2).div(px), 0, 1));
}

/**
 * View-space normal bumped by a procedural height `h` (m): Mikkelsen's surface-gradient perturbation
 * (as three's BumpMapNode) but from screen derivatives of the expression itself, since a procedural
 * height has no texture to re-sample.
 */
export function bumpNormal(h: F): V3 {
  return Fn(() => {
    const dHdx = h.dFdx();
    const dHdy = h.dFdy();
    const sx = positionView.dFdx().normalize();
    const sy = positionView.dFdy().normalize();
    const n = normalView;
    const r1 = sy.cross(n);
    const r2 = n.cross(sx);
    const det = sx.dot(r1);
    const grad = det.sign().mul(dHdx.mul(r1).add(dHdy.mul(r2)));
    return det.abs().mul(n).sub(grad).normalize();
  })();
}

export interface PanelStyle {
  /** Mean frame pitch along the body and split pitch across (m). */
  frameM: number;
  splitM: number;
  /** Seam half-width (m) and share of panels with an inner access panel. */
  seamM: number;
  access: number;
  /** Rivet rows beside the seams (older airframe). */
  rivets: boolean;
  /** Lighter, glossier tape over the seams (stealth coatings). */
  tape: boolean;
}

export interface PaintSpec {
  name: string;
  base: number;
  roughness: number;
  panels: PanelStyle;
  /** Underside colour, blended in where the skin faces down. */
  belly?: number;
  /** Hard-edged camouflage tones (plan view), dark and light. */
  camo?: { dark: number; light: number; scaleM: number };
  /** Exhaust soot from this station aft (m) to the nozzle exit. */
  soot?: { fromZ: number; toZ: number };
}

interface PanelPattern {
  seam: F;
  access: F;
  rivet: F;
  tape: F;
  panelId: F;
}

/** Jittered boundary i of a 1-D partition with mean pitch p (seeded). */
function boundary(i: F, p: number | F, seed: number): F {
  const pp = typeof p === 'number' ? float(p) : p;
  return i.mul(pp).add(hash(i.add(seed)).sub(0.5).mul(pp).mul(0.36));
}

function panelPattern(style: PanelStyle): PanelPattern {
  const surf = attribute('surf', 'vec2');
  const u = surf.x;
  const v = surf.y;
  // Along: frames at an irregular pitch. Find the panel [b(i), b(i+1)) containing u.
  const i0 = floor(u.div(style.frameM));
  const bPrev = boundary(i0.sub(1), style.frameM, 11);
  const b0 = boundary(i0, style.frameM, 11);
  const b1 = boundary(i0.add(1), style.frameM, 11);
  const b2 = boundary(i0.add(2), style.frameM, 11);
  const iu = i0.add(step(b1, u)).sub(step(u, b0));
  const startU = mix(mix(b0, b1, step(b1, u)), bPrev, step(u, b0));
  const endU = mix(mix(b1, b2, step(b1, u)), b0, step(u, b0));
  const du = min(u.sub(startU).abs(), endU.sub(u).abs());
  // Across: each bay has its own split pitch and offset.
  const q = mix(float(style.splitM * 0.6), float(style.splitM * 1.4), hash(iu.mul(7.13)));
  const off = hash(iu.mul(3.71)).mul(q);
  const vv = v.sub(off).div(q);
  const jv = floor(vv);
  const lv = fract(vv).mul(q);
  const dv = min(lv, q.sub(lv));
  const dSeam = min(du, dv);
  const seam = lineAA(dSeam, style.seamM);
  const panelId = hash(iu.mul(17.3).add(jv.mul(5.71)));
  // Access panel: an inset rounded rectangle in some panels.
  const lu = u.sub(startU);
  const wu = endU.sub(startU);
  const cu = wu.mul(0.5);
  const cv = q.mul(0.5);
  const hu = wu.mul(mix(float(0.18), float(0.38), hash(panelId.mul(3.1))));
  const hv = q.mul(mix(float(0.18), float(0.36), hash(panelId.mul(5.3))));
  const r = 0.04;
  const qx = abs(lu.sub(cu)).sub(hu).add(r);
  const qy = abs(lv.sub(cv)).sub(hv).add(r);
  const rect = vec2(max(qx, 0), max(qy, 0)).length().add(min(max(qx, qy), 0)).sub(r);
  const access = lineAA(abs(rect), style.seamM * 0.8).mul(step(1 - style.access, hash(panelId.mul(9.7))));
  // Rivet rows 25 mm inside the frame seams, 60 mm pitch; gone before a rivet is a pixel.
  let rivet: F = float(0);
  if (style.rivets) {
    const along = fract(v.div(0.06)).sub(0.5).abs().mul(0.06);
    const row = du.sub(0.025).abs();
    const dot = vec2(along, row).length();
    rivet = lineAA(dot, 0.0045).mul(float(1).sub(smoothstep(0.004, 0.012, fwidth(u))));
  }
  const tape = style.tape ? lineAA(dSeam, 0.035) : float(0);
  return { seam, access, rivet, tape, panelId };
}

/** The airframe paint. Requires the `surf` attribute (airframe.ts geometry). */
export function paintMaterial(spec: PaintSpec): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: spec.name, roughness: spec.roughness, metalness: 0 });
  const p = panelPattern(spec.panels);
  const P = positionLocal;
  let colour: V3 = lin(spec.base);
  if (spec.camo) {
    // Painted camouflage: domain-warped noise in plan view with hard (anti-aliased) edges.
    const s = spec.camo.scaleM;
    const warp = vec2(mx_noise_float(P.xz.div(s * 1.7)), mx_noise_float(P.xz.div(s * 1.7).add(19.1))).mul(s * 0.6);
    const w = P.xz.add(warp).div(s);
    const n1 = mx_noise_float(w);
    const n2 = mx_noise_float(w.mul(1.3).add(vec2(7.7, 3.1)));
    const edge = (x: F): F => clamp(x.div(max(fwidth(x), 1e-4)).mul(0.7).add(0.5), 0, 1);
    colour = mix(colour, lin(spec.camo.dark), edge(n1.sub(0.18)));
    colour = mix(colour, lin(spec.camo.light), edge(n2.sub(0.22)).mul(float(1).sub(edge(n1.sub(0.18)))));
  }
  if (spec.belly !== undefined) {
    // Undersides: a soft demarcation along the side, as sprayed.
    colour = mix(colour, lin(spec.belly), smoothstep(-0.05, -0.45, normalLocal.y));
  }
  // Batch-to-batch paint variation per panel, a little lighter tape over seams, dark sealant in them.
  colour = colour.mul(float(0.965).add(p.panelId.mul(0.07)));
  if (spec.panels.tape) colour = mix(colour, colour.mul(1.08), p.tape.mul(0.8));
  colour = colour.mul(float(1).sub(p.seam.mul(0.42))).mul(float(1).sub(p.access.mul(0.3)));
  colour = colour.mul(float(1).sub(p.rivet.mul(0.12)));
  // Weathering: streaks carried aft by the airflow, soot towards the nozzles.
  const surf = attribute('surf', 'vec2');
  const streak = smoothstep(0.35, 0.8, mx_noise_float(vec2(surf.x.mul(0.35), surf.y.mul(4.5)))).mul(0.06);
  colour = colour.mul(float(1).sub(streak));
  if (spec.soot) {
    const soot = smoothstep(spec.soot.fromZ, spec.soot.toZ, P.z).mul(mx_noise_float(vec2(surf.x.mul(1.2), surf.y.mul(3))).mul(0.25).add(0.75));
    colour = mix(colour, lin(0x2b2b2c), soot.mul(0.55));
  }
  m.colorNode = colour;
  const rough = float(spec.roughness).add(p.panelId.sub(0.5).mul(0.06)).sub(p.tape.mul(spec.panels.tape ? 0.1 : 0)).add(p.seam.mul(0.1));
  m.roughnessNode = rough.clamp(0.25, 1);
  // Recessed seams (0.6 mm), raised rivet heads (0.3 mm).
  m.normalNode = bumpNormal(p.seam.add(p.access.mul(0.7)).mul(-0.0006).add(p.rivet.mul(0.0003)));
  return m;
}

/** Plain materials for parts without the skin pattern. */
export function plain(name: string, hex: number, roughness: number, metalness = 0): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ name, color: new Color(hex), roughness, metalness });
}

/**
 * Canopy acrylic, with the stealth type's gold-tinted metallised coating as a coloured specular. From
 * outside a canopy reads dark with the sky reflected in it: a dark tint at 60 % opacity keeps the
 * reflection strong (three's opacity scales reflections too) and the pilot still shows through.
 */
export function canopyMaterial(tint: number, coating: number | null): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial({ name: 'canopy', color: new Color(tint), roughness: 0.04, metalness: 0, transparent: true, opacity: 0.6, clearcoat: 1, clearcoatRoughness: 0.02 });
  if (coating !== null) {
    m.specularColor = new Color(coating);
    m.specularIntensity = 1;
  }
  m.depthWrite = false;
  return m;
}

/**
 * Engine nozzle metal: titanium with heat tint (straw → blue → violet towards the exit) on the twin,
 * a dark ceramic coating on the stealth type. `z0`→`z1` is the nozzle's length.
 */
export function nozzleMaterial(kind: 'titanium' | 'ceramic', z0: number, z1: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: `nozzle ${kind}`, roughness: 0.5, metalness: kind === 'titanium' ? 1 : 0 });
  const f = clamp(positionLocal.z.sub(z0).div(z1 - z0), 0, 1);
  if (kind === 'titanium') {
    const straw = lin(0xc9a865);
    const blue = lin(0x6f7fae);
    const violet = lin(0x8a7a9c);
    const base = lin(0xc4bcb2);
    const tint = mix(mix(base, straw, smoothstep(0.1, 0.35, f)), mix(blue, violet, smoothstep(0.7, 1, f)), smoothstep(0.4, 0.65, f));
    m.colorNode = tint.mul(mx_noise_float(positionLocal.mul(vec3(8, 8, 1.5))).mul(0.08).add(0.92));
    m.roughnessNode = mix(float(0.38), float(0.55), f);
  } else {
    m.colorNode = mix(lin(0x5c5c5e), lin(0x3a3a3c), f);
    m.roughnessNode = float(0.55);
  }
  return m;
}
