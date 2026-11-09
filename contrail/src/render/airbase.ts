import { abs, dot, float, floor, fract, fwidth, max, mix, mx_noise_float, positionLocal, sin, smoothstep, step, texture, vec2, vec3 } from 'three/tsl';
import { BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, LinearFilter, Mesh, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node, PlaneGeometry, SRGBColorSpace } from 'three/webgpu';
import { TERRAIN } from '../sim/terrain.ts';

// The airbase at the centre of the map (brief: "a runway and an airbase at the
// centre for take-off and landing, with runway concrete, paint and tyre-mark
// decals from the PBR sheet"). Runway 3000 × 45 m along north–south ("36" at
// the south end, "18" at the north), with threshold piano keys, designators,
// a dashed centreline, touchdown-zone and aiming-point markings, edge lines,
// concrete slab joints and rubber deposits where wheels touch down. A parallel
// asphalt taxiway with connectors, a concrete apron, hardened shelters, a
// hangar and a tower. Values: runway concrete #A09D96 r 0.85, road paint
// #D6D6D0 r 0.60, asphalt #3A3A3C r 0.92, weathered concrete #8F8B85 r 0.88,
// tyre rubber #2C2C2E — all from pbr-material-reference.png.

export const RUNWAY = { lengthM: 3000, widthM: 45, elevationM: TERRAIN.airbaseElevationM, headingDeg: 360 } as const;
/** South threshold (landing northbound on runway 36): world z. */
export const THRESHOLD_36_Z = RUNWAY.lengthM / 2;

const lin = (hex: number): Node<'vec3'> => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

function designatorTexture(): CanvasTexture {
  // Two designators side by side, white on black, drawn once at load.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  // In memory, not on the GPU: drawn once, then copied into a WebGPU texture, and a GPU canvas's copy reads it back across contexts (seconds on software GPUs).
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('2D canvas unavailable for the runway designators');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#fff';
  g.font = 'bold 220px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('36', 128, 132);
  g.fillText('18', 384, 132);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

function runwayMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'runway', roughness: 0.85, metalness: 0 });
  // Local plane coordinates: u across (−22.5…22.5 m), v along (−1500…1500 m, +v = south).
  const u = positionLocal.x;
  const v = positionLocal.y.negate();
  const au = abs(u);
  const av = abs(v);
  const fromThreshold = float(RUNWAY.lengthM / 2).sub(av);
  const aa = (d: Node<'float'>): Node<'float'> => float(1).sub(smoothstep(float(0), max(fwidth(d), 0.02), d));
  // Edge lines 0.9 m wide.
  const edge = aa(abs(au.sub(21.45)).sub(0.45));
  // Threshold piano keys: 8 stripes each side, 1.8 m wide, 30 m long, starting 6 m in.
  const keyBand = step(6, fromThreshold).mul(step(fromThreshold, 36));
  const keys = keyBand.mul(step(3, au)).mul(step(au, 20)).mul(step(fract(au.sub(3).div(3.6)), 0.5));
  // Centreline dashes: 30 m paint, 20 m gap, 0.9 m wide.
  const centre = aa(au.sub(0.45)).mul(step(fract(v.div(50)), 0.6)).mul(step(120, fromThreshold));
  // Touchdown zone: three pairs of bars per side every 150 m from 150 to 600 m; aiming point at 400 m.
  const tdz = step(fract(fromThreshold.div(150)), 0.15).mul(step(140, fromThreshold)).mul(step(fromThreshold, 620)).mul(step(6, au)).mul(step(au, 12));
  const aim = step(360, fromThreshold).mul(step(fromThreshold, 410)).mul(step(6, au)).mul(step(au, 16));
  // Designators: 30 m tall numbers 45 m in from each threshold, read from the approach.
  const tex = designatorTexture();
  const nearSouth = step(0, v);
  // Bottom of the digits towards the threshold, read left to right from the approach (canvas
  // textures are flipped, so uv.y = 1 is the top of the canvas).
  const local = vec2(u.div(36).add(0.5), fromThreshold.sub(45).div(30));
  const inBox = step(0, local.x).mul(step(local.x, 1)).mul(step(0, local.y)).mul(step(local.y, 1));
  // South end, landing north: "36" (left half). North end, landing south: "18", mirrored in u.
  const southUv = vec2(local.x.mul(0.5), local.y);
  const northUv = vec2(float(1).sub(local.x).mul(0.5).add(0.5), local.y);
  const atlasUv = mix(northUv, southUv, nearSouth);
  const digits = texture(tex, atlasUv).r.mul(inBox);
  const paint = max(max(max(edge, keys), max(centre, tdz)), max(aim, digits));
  // Concrete slabs every 7.5 m with tar-sealed joints, and a little macro staining. Up close (sitting on
  // it, taxiing) one flat beige read as a plane, not concrete: each slab is poured a shade apart, the
  // aggregate speckles, a share of the slabs carry hairline cracks that stop at their joints, and the
  // centreline is spotted with oil. The fine detail fades by pixel footprint, so it never shimmers.
  const xy = vec2(u, v);
  const joint = max(aa(abs(fract(u.div(7.5)).sub(0.5)).mul(7.5).sub(3.7)), aa(abs(fract(v.div(7.5)).sub(0.5)).mul(7.5).sub(3.7)));
  const stain = mx_noise_float(vec2(u.div(18), v.div(60))).mul(0.06).add(1);
  const slab = floor(xy.div(7.5));
  const slabHash = fract(sin(dot(slab, vec2(12.9898, 78.233))).mul(43758.5453));
  const slabTone = slabHash.mul(0.12).add(0.93);
  const footprint = fwidth(u);
  const near = float(1).sub(smoothstep(0.04, 0.25, footprint));
  const aggregate = mx_noise_float(xy.mul(9)).mul(0.05).add(mx_noise_float(xy.mul(31)).mul(0.035)).mul(near);
  const warp = vec2(mx_noise_float(xy.mul(0.4)), mx_noise_float(xy.mul(0.4).add(7.3)));
  const isoline = mx_noise_float(xy.mul(0.22).add(warp.mul(0.6)));
  const lineW = max(fwidth(isoline), 0.004);
  const crack = float(1)
    .sub(smoothstep(lineW.mul(0.5), lineW.mul(1.5), abs(isoline)))
    .mul(step(fract(slabHash.mul(7.31)), 0.3))
    .mul(float(1).sub(smoothstep(0.02, 0.08, footprint)));
  const oil = smoothstep(0.5, 0.78, mx_noise_float(xy.mul(vec2(0.9, 0.22)).add(3.1))).mul(float(1).sub(smoothstep(1.2, 3, au))).mul(0.5);
  let colour: Node<'vec3'> = lin(0xa09d96).mul(stain).mul(slabTone).mul(aggregate.add(1));
  colour = mix(colour, lin(0x2e2c2a), max(joint.mul(0.55), crack.mul(0.5)));
  colour = mix(colour, lin(0x4a4640), oil);
  // Rubber deposits where the wheels touch down: dark streaks along the runway, 250–900 m in.
  const rubberBand = smoothstep(200, 300, fromThreshold).mul(float(1).sub(smoothstep(800, 950, fromThreshold)));
  const streaks = smoothstep(0.1, 0.6, mx_noise_float(vec2(u.div(1.6), v.div(40)))).mul(float(1).sub(smoothstep(4, 10, au)));
  colour = mix(colour, lin(0x2c2c2e), rubberBand.mul(streaks).mul(0.85));
  colour = mix(colour, lin(0xd6d6d0), paint.mul(float(1).sub(rubberBand.mul(streaks).mul(0.6))));
  m.colorNode = colour;
  // Paint, polished rubber and oil are smoother than the broomed concrete.
  m.roughnessNode = mix(mix(mix(float(0.85), float(0.62), rubberBand.mul(streaks)), float(0.5), oil), float(0.6), paint);
  return m;
}

function asphaltMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'taxiway', roughness: 0.92, metalness: 0 });
  const u = positionLocal.x;
  // Taxiway centreline: yellow by convention (not on the sheet: chosen to match real airfields).
  const line = float(1).sub(smoothstep(0.15, 0.2, abs(u)));
  const wear = mx_noise_float(positionLocal.xy.div(25)).mul(0.08).add(1);
  m.colorNode = mix(lin(0x3a3a3c).mul(wear), lin(0xc9a43a), line.mul(0.85));
  return m;
}

export function buildAirbase(): Group {
  const root = new Group();
  root.name = 'airbase';
  const y = RUNWAY.elevationM + 0.05;
  const flat = (w: number, l: number): PlaneGeometry => new PlaneGeometry(w, l).rotateX(-Math.PI / 2);
  // Local y of the plane points north after the rotation; the shader reads local coordinates.
  const runway = new Mesh(new PlaneGeometry(RUNWAY.widthM, RUNWAY.lengthM), runwayMaterial());
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(0, y, 0);
  runway.receiveShadow = true;
  root.add(runway);
  const asphalt = asphaltMaterial();
  const taxi = new Mesh(new PlaneGeometry(23, RUNWAY.lengthM), asphalt);
  taxi.rotation.x = -Math.PI / 2;
  taxi.position.set(200, y - 0.01, 0);
  taxi.receiveShadow = true;
  root.add(taxi);
  for (const z of [-1450, -450, 450, 1450]) {
    const link = new Mesh(new PlaneGeometry(23, 178), asphalt);
    link.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    link.position.set(111.5, y - 0.02, z);
    link.receiveShadow = true;
    root.add(link);
  }
  const concrete = new MeshStandardNodeMaterial({ name: 'apron concrete', color: new Color(0x8f8b85), roughness: 0.88, metalness: 0 });
  const apron = new Mesh(flat(360, 620), concrete);
  apron.position.set(390, y - 0.02, 0);
  apron.receiveShadow = true;
  root.add(apron);
  // Hardened aircraft shelters along the apron's east side, doors facing west.
  const shelterGeo = new CylinderGeometry(12, 12, 36, 24, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const s = new Mesh(shelterGeo, concrete);
    s.position.set(600, y, -250 + i * 100);
    s.rotation.y = Math.PI / 2;
    s.castShadow = true;
    s.receiveShadow = true;
    root.add(s);
  }
  const hangar = new Mesh(new BoxGeometry(60, 16, 45), new MeshStandardNodeMaterial({ name: 'hangar', color: new Color(0x7b8186), roughness: 0.7, metalness: 0 }));
  hangar.position.set(420, y + 8, 420);
  hangar.castShadow = true;
  hangar.receiveShadow = true;
  root.add(hangar);
  const tower = new Mesh(new BoxGeometry(8, 24, 8), concrete);
  tower.position.set(300, y + 12, -420);
  tower.castShadow = true;
  root.add(tower);
  const cab = new Mesh(new BoxGeometry(11, 4, 11), new MeshPhysicalNodeMaterial({ name: 'tower glass', color: new Color(0x4a5a60), roughness: 0.05, metalness: 0, clearcoat: 1 }));
  cab.position.set(300, y + 26, -420);
  root.add(cab);
  return root;
}
