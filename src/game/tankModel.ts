import * as THREE from 'three';
import { box, convexHull2, cyl, latheX, mergeParts, prismX, prismY, sphereCap } from '../render/geom';
import { makeTrackTexture } from '../render/textures';
import { makeVehicleUniforms, vehicleMaterial, type VehicleUniforms } from '../render/vehicleMaterial';

export type TankStyle = 'west' | 'east';

export interface WheelSpec {
  z: number;
  y: number;
  r: number;
}

/** Everything the simulation needs to animate and hit-test a built tank. */
export interface TankModel {
  root: THREE.Group;
  hull: THREE.Group;
  turret: THREE.Group;
  gun: THREE.Group;
  muzzle: THREE.Object3D;
  sight: THREE.Object3D;
  /** rest-pose pivots in the hull frame */
  turretPivot: THREE.Vector3;
  gunPivot: THREE.Vector3; // in turret frame
  uniforms: VehicleUniforms;
  materials: THREE.Material[];
  trackMats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  trackTex: [THREE.Texture, THREE.Texture];
  wheels: THREE.InstancedMesh;
  wheelSpecs: WheelSpec[]; // per side (mirrored)
  sprockets: THREE.Mesh[]; // [L, R]
  idlers: THREE.Mesh[];
  trackX: number;
  linkPitch: number;
  /** hitboxes: centre + half extents; hull in hull frame, turret in turret frame */
  hullBox: { c: THREE.Vector3; h: THREE.Vector3 };
  turretBox: { c: THREE.Vector3; h: THREE.Vector3 };
  gunLength: number;
  exhaust: THREE.Vector3[]; // hull frame
  headlights: THREE.Vector3[]; // hull frame
  headlightMat: THREE.MeshStandardMaterial;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Layout {
  roadWheels: WheelSpec[];
  sprocket: WheelSpec;
  idler: WheelSpec;
  rollers: WheelSpec[];
  trackX: number;
  trackW: number;
  trackT: number;
}

function buildTrackGeometry(l: Layout, side: -1 | 1, pitch: number): THREE.BufferGeometry {
  const halfT = l.trackT / 2;
  // Belt centre-line = convex hull of every wheel circle grown by half the belt thickness.
  const pts: [number, number][] = [];
  const add = (w: WheelSpec) => {
    for (let a = 0; a < 360; a += 6) {
      const r = (a * Math.PI) / 180;
      pts.push([w.z + Math.cos(r) * (w.r + halfT), w.y + Math.sin(r) * (w.r + halfT)]);
    }
  };
  l.roadWheels.forEach(add);
  add(l.sprocket);
  add(l.idler);
  l.rollers.forEach(add);
  const hull = convexHull2(pts);
  // resample evenly
  const path: [number, number][] = [];
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLen.push(d);
    total += d;
  }
  const N = Math.round(total / 0.08);
  let seg = 0;
  let acc = 0;
  for (let k = 0; k < N; k++) {
    const s = (k / N) * total;
    while (acc + segLen[seg]! < s) {
      acc += segLen[seg]!;
      seg++;
    }
    const a = hull[seg]!;
    const b = hull[(seg + 1) % hull.length]!;
    const t = (s - acc) / segLen[seg]!;
    path.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  // hull is CCW in (z,y); outward normal of edge (dz,dy) is (dy,-dz)
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const x0 = side * l.trackX - l.trackW / 2;
  const x1 = side * l.trackX + l.trackW / 2;
  const normalAt = (k: number): [number, number] => {
    const p = path[(k - 1 + N) % N]!;
    const q = path[(k + 1) % N]!;
    const dz = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dz, dy);
    return [dy / len, -dz / len];
  };
  const quad = (
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    na: THREE.Vector3, nb: THREE.Vector3, ua: [number, number], ub: [number, number], uc: [number, number], ud: [number, number],
  ) => {
    for (const [v, n, t] of [[a, na, ua], [b, na, ub], [c, nb, uc], [a, na, ua], [c, nb, uc], [d, nb, ud]] as const) {
      pos.push(v.x, v.y, v.z);
      nrm.push(n.x, n.y, n.z);
      uv.push(t[0], t[1]);
    }
  };
  let v = 0;
  for (let k = 0; k < N; k++) {
    const kn = (k + 1) % N;
    const p = path[k]!;
    const q = path[kn]!;
    const [nz0, ny0] = normalAt(k);
    const [nz1, ny1] = normalAt(kn);
    const vNext = v + Math.hypot(q[0] - p[0], q[1] - p[1]) / pitch;
    const o0 = V(0, p[1] + ny0 * halfT, p[0] + nz0 * halfT);
    const o1 = V(0, q[1] + ny1 * halfT, q[0] + nz1 * halfT);
    const i0 = V(0, p[1] - ny0 * halfT, p[0] - nz0 * halfT);
    const i1 = V(0, q[1] - ny1 * halfT, q[0] - nz1 * halfT);
    const n0 = V(0, ny0, nz0);
    const n1 = V(0, ny1, nz1);
    // outer face (tread)
    quad(o0.clone().setX(x0), o0.clone().setX(x1), o1.clone().setX(x1), o1.clone().setX(x0), n0, n1, [0, v], [1, v], [1, vNext], [0, vNext]);
    // inner face
    const m0 = n0.clone().negate();
    const m1 = n1.clone().negate();
    quad(i0.clone().setX(x1), i0.clone().setX(x0), i1.clone().setX(x0), i1.clone().setX(x1), m0, m1, [0.2, v], [0.8, v], [0.8, vNext], [0.2, vNext]);
    // sides
    const sx = V(1, 0, 0);
    const sxn = V(-1, 0, 0);
    quad(i0.clone().setX(x1), o0.clone().setX(x1), o1.clone().setX(x1), i1.clone().setX(x1), sx, sx, [1, v], [1, v], [1, vNext], [1, vNext]);
    quad(o0.clone().setX(x0), i0.clone().setX(x0), i1.clone().setX(x0), o1.clone().setX(x0), sxn, sxn, [0, v], [0, v], [0, vNext], [0, vNext]);
    v = vNext;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('tankPos', new THREE.Float32BufferAttribute(pos.slice(), 3));
  g.computeBoundingSphere();
  return g;
}

function roadWheelGeom(r: number, width: number): { tyre: THREE.BufferGeometry; disc: THREE.BufferGeometry } {
  const w = width / 2;
  const gap = width * 0.18;
  // two wheel halves with a guide-horn gap
  const tyreProfile = (x0: number, x1: number): [number, number][] => [
    [r * 0.82, x0], [r * 0.97, x0], [r, x0 + 0.02], [r, x1 - 0.02], [r * 0.97, x1], [r * 0.82, x1],
  ];
  const discProfile = (x0: number, x1: number, outer: boolean): [number, number][] => [
    [0.001, outer ? x1 + 0.03 : x0], [r * 0.18, outer ? x1 + 0.03 : x0], [r * 0.22, outer ? x1 : x0 + 0.01],
    [r * 0.6, outer ? x1 - 0.03 : x0 + 0.03], [r * 0.82, outer ? x1 : x0], [r * 0.82, outer ? x0 : x1],
  ];
  const tyre = mergeParts([latheX(tyreProfile(-w, -gap / 2), 28), latheX(tyreProfile(gap / 2, w), 28)]);
  const disc = mergeParts([latheX(discProfile(gap / 2, w, true), 28), latheX(discProfile(-w, -gap / 2, false), 28), cyl(r * 0.2, r * 0.2, gap + 0.02, 12, 'x')]);
  return { tyre, disc };
}

function sprocketGeom(r: number, width: number, teeth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = teeth * 2;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = i % 2 === 0 ? r : r * 0.86;
    const x = Math.cos(a) * rr;
    const y = Math.sin(a) * rr;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const ring = (x: number) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth: width * 0.22, bevelEnabled: false, curveSegments: 1 });
    g.rotateY(Math.PI / 2);
    g.translate(x - width * 0.11, 0, 0);
    return g;
  };
  return mergeParts([ring(-width * 0.32), ring(width * 0.32), cyl(r * 0.55, r * 0.55, width * 0.9, 16, 'x'), cyl(r * 0.25, r * 0.25, width * 1.1, 10, 'x')]);
}

function layoutFor(style: TankStyle): Layout {
  if (style === 'west') {
    const r = 0.34;
    const trackT = 0.09;
    const roadWheels: WheelSpec[] = [];
    for (let i = 0; i < 7; i++) roadWheels.push({ z: -2.55 + i * 0.85, y: r + trackT, r });
    return {
      roadWheels,
      sprocket: { z: -3.3, y: 0.66, r: 0.33 },
      idler: { z: 3.28, y: 0.64, r: 0.3 },
      rollers: [-2.2, -0.75, 0.7, 2.1].map((z) => ({ z, y: 1.0, r: 0.1 })),
      trackX: 1.53,
      trackW: 0.63,
      trackT,
    };
  }
  const r = 0.4;
  const trackT = 0.085;
  const roadWheels: WheelSpec[] = [];
  for (let i = 0; i < 6; i++) roadWheels.push({ z: -2.35 + i * 0.9, y: r + trackT, r });
  return {
    roadWheels,
    sprocket: { z: -3.12, y: 0.68, r: 0.3 },
    idler: { z: 3.02, y: 0.6, r: 0.28 },
    rollers: [-1.5, 0.0, 1.5].map((z) => ({ z, y: 1.0, r: 0.08 })),
    trackX: 1.5,
    trackW: 0.58,
    trackT,
  };
}

export function buildTank(style: TankStyle, seed: number): TankModel {
  const west = style === 'west';
  const uniforms = makeVehicleUniforms(
    seed,
    west ? [0x4b5340, 0x4f3f2e, 0x262628] : [0x5c5b3e, 0x5c5b3e, 0x5c5b3e],
  );
  const paint = vehicleMaterial(west ? 'natoGreen' : 'khakiGreen', uniforms, { camo: west });
  const dark = vehicleMaterial('parkerised', uniforms);
  const rubber = vehicleMaterial('tyreRubber', uniforms);
  const steel = vehicleMaterial('steelWorn', uniforms, { params: { roughness: 0.45 } });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0a0f12, roughness: 0.04, metalness: 0.0, envMapIntensity: 1.6 });
  const headlightMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.1, emissive: 0xfff2d8, emissiveIntensity: 0 });
  const layout = layoutFor(style);
  const linkPitch = 0.16;

  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);

  // ---------------------------------------------------------------- hull
  const hullPaint: THREE.BufferGeometry[] = [];
  const hullDark: THREE.BufferGeometry[] = [];
  const hullRubber: THREE.BufferGeometry[] = [];
  const hullGlass: THREE.BufferGeometry[] = [];
  const hullSteel: THREE.BufferGeometry[] = [];
  const lights: THREE.BufferGeometry[] = [];
  let turretPivot: THREE.Vector3;
  let hullBox: TankModel['hullBox'];
  const exhaust: THREE.Vector3[] = [];
  const headlights: THREE.Vector3[] = [];

  if (west) {
    hullPaint.push(prismX([[-3.72, 1.0], [3.5, 1.0], [3.95, 1.26], [2.3, 1.8], [-3.8, 1.8]], -1.86, 1.86));
    hullPaint.push(prismX([[-3.6, 0.5], [3.1, 0.5], [3.72, 1.0], [-3.75, 1.0]], -1.15, 1.15));
    // armoured side skirts, segmented; thicker front three
    for (let i = 0; i < 7; i++) {
      const z0 = -3.45 + i * 1.0;
      const thick = i >= 4 ? 0.1 : 0.06;
      hullPaint.push(box(thick, 0.5, 0.97, 1.86 + thick / 2, 0.78, z0 + 0.5));
      hullPaint.push(box(thick, 0.5, 0.97, -1.86 - thick / 2, 0.78, z0 + 0.5));
    }
    // engine deck grilles
    for (const z of [-3.3, -2.55, -1.8]) hullDark.push(box(2.6, 0.03, 0.6, 0, 1.815, z));
    hullDark.push(box(0.5, 0.25, 0.08, 1.2, 1.45, -3.83), box(0.5, 0.25, 0.08, -1.2, 1.45, -3.83));
    exhaust.push(V(1.2, 1.45, -3.9), V(-1.2, 1.45, -3.9));
    // driver hatch + periscopes
    hullPaint.push(box(0.7, 0.05, 0.6, -0.65, 1.82, 1.9));
    for (const x of [-0.95, -0.65, -0.35]) hullGlass.push(box(0.16, 0.06, 0.03, x, 1.86, 2.22));
    // headlights + tow hooks
    for (const x of [-1.55, 1.55]) {
      hullDark.push(box(0.26, 0.2, 0.14, x, 1.38, 3.72));
      lights.push(box(0.18, 0.12, 0.02, x, 1.39, 3.8));
      headlights.push(V(x, 1.39, 3.85));
      hullDark.push(box(0.14, 0.14, 0.2, x * 0.55, 0.78, 3.62));
    }
    // front fenders
    hullPaint.push(box(0.66, 0.04, 0.6, 1.53, 1.02, 3.55), box(0.66, 0.04, 0.6, -1.53, 1.02, 3.55));
    turretPivot = V(0, 1.8, 0.1);
    hullBox = { c: V(0, 1.15, 0.05), h: V(1.9, 0.65, 3.85) };
  } else {
    hullPaint.push(prismX([[-3.45, 1.0], [3.3, 1.0], [3.58, 1.12], [1.85, 1.6], [-3.5, 1.56]], -1.72, 1.72));
    hullPaint.push(prismX([[-3.3, 0.5], [2.9, 0.5], [3.45, 1.0], [-3.45, 1.0]], -1.1, 1.1));
    // thin fenders over the tracks
    hullPaint.push(box(0.36, 0.035, 6.9, 1.9, 1.02, 0.0), box(0.36, 0.035, 6.9, -1.9, 1.02, 0.0));
    // rubber side flaps (front half)
    for (let i = 0; i < 4; i++) {
      hullRubber.push(box(0.03, 0.42, 0.78, 2.07, 0.8, 0.6 + i * 0.8), box(0.03, 0.42, 0.78, -2.07, 0.8, 0.6 + i * 0.8));
    }
    // ERA on the upper glacis
    const ga = Math.atan2(1.6 - 1.12, 3.58 - 1.85);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 7; c++) {
        const t = 0.2 + r * 0.28;
        const z = 3.58 - (3.58 - 1.85) * t;
        const y = 1.12 + (1.6 - 1.12) * t + 0.06;
        hullPaint.push(box(0.4, 0.09, 0.5, -1.35 + c * 0.45, y, z, ga, 0, 0));
      }
    }
    // stowage + external fuel tanks on the fenders
    for (let i = 0; i < 3; i++) {
      hullPaint.push(box(0.34, 0.34, 0.9, 1.9, 1.22, -1.8 + i * 1.0));
      hullDark.push(box(0.3, 0.3, 0.8, -1.9, 1.2, -1.6 + i * 0.95));
    }
    // rear fuel drums
    hullDark.push(cyl(0.3, 0.3, 0.8, 18, 'x', 0.6, 1.4, -3.72), cyl(0.3, 0.3, 0.8, 18, 'x', -0.6, 1.4, -3.72));
    for (const z of [-3.1, -2.3]) hullDark.push(box(2.4, 0.03, 0.55, 0, 1.585, z));
    hullDark.push(box(0.35, 0.2, 0.25, 1.75, 1.2, -2.9));
    exhaust.push(V(1.95, 1.2, -2.9));
    for (const x of [-1.45, 1.45]) {
      hullDark.push(cyl(0.1, 0.1, 0.12, 12, 'z', x, 1.28, 3.35));
      lights.push(cyl(0.08, 0.08, 0.02, 12, 'z', x, 1.28, 3.42));
      headlights.push(V(x, 1.28, 3.45));
    }
    hullGlass.push(box(0.2, 0.06, 0.03, 0, 1.62, 1.95));
    turretPivot = V(0, 1.58, 0.35);
    hullBox = { c: V(0, 1.05, 0.05), h: V(1.85, 0.56, 3.5) };
  }
  // return rollers + suspension arms
  for (const s of [-1, 1] as const) {
    for (const rl of layout.rollers) hullDark.push(cyl(rl.r, rl.r, 0.3, 10, 'x', s * layout.trackX, rl.y, rl.z));
    for (const w of layout.roadWheels) hullDark.push(box(0.12, 0.12, 0.55, s * (layout.trackX - 0.35), w.y + 0.1, w.z + 0.22, -0.35, 0, 0));
  }

  const addMesh = (parent: THREE.Object3D, parts: THREE.BufferGeometry[], mat: THREE.Material, offset: THREE.Vector3) => {
    if (!parts.length) return;
    const m = new THREE.Mesh(mergeParts(parts, offset), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  };
  const O = new THREE.Vector3();
  addMesh(hull, hullPaint, paint, O);
  addMesh(hull, hullDark, dark, O);
  addMesh(hull, hullRubber, rubber, O);
  addMesh(hull, hullGlass, glass, O);
  addMesh(hull, hullSteel, steel, O);
  addMesh(hull, lights, headlightMat, O);

  // ---------------------------------------------------------------- running gear
  const { tyre, disc } = roadWheelGeom(layout.roadWheels[0]!.r, 0.58);
  // two materials in one instanced draw is impossible, so tyres and discs are separate instanced meshes;
  // the disc mesh is the "wheels" handle, tyres follow it through a shared matrix buffer.
  const count = layout.roadWheels.length * 2;
  const wheels = new THREE.InstancedMesh(mergeParts([disc]), paint, count);
  const tyres = new THREE.InstancedMesh(mergeParts([tyre]), rubber, count);
  tyres.instanceMatrix = wheels.instanceMatrix;
  wheels.castShadow = tyres.castShadow = true;
  wheels.receiveShadow = tyres.receiveShadow = true;
  wheels.frustumCulled = tyres.frustumCulled = false;
  hull.add(wheels, tyres);

  const spGeo = sprocketGeom(layout.sprocket.r, 0.55, 12);
  const idGeo = mergeParts([...Object.values(roadWheelGeom(layout.idler.r, 0.55))]);
  const sprockets: THREE.Mesh[] = [];
  const idlers: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const sp = new THREE.Mesh(spGeo, dark);
    sp.position.set(s * layout.trackX, layout.sprocket.y, layout.sprocket.z);
    const id = new THREE.Mesh(idGeo, paint);
    id.position.set(s * layout.trackX, layout.idler.y, layout.idler.z);
    sp.castShadow = id.castShadow = true;
    hull.add(sp, id);
    sprockets.push(sp);
    idlers.push(id);
  }

  const trackBase = makeTrackTexture();
  const mkTrack = (side: -1 | 1) => {
    const tex = trackBase.clone();
    tex.needsUpdate = true;
    const mat = vehicleMaterial('rubberTrack', uniforms, { params: { bumpMap: tex, bumpScale: 3.0, roughnessMap: tex, roughness: 1.0, metalness: 0.0 } });
    const mesh = new THREE.Mesh(buildTrackGeometry(layout, side, linkPitch), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    hull.add(mesh);
    return { mat, tex };
  };
  const tl = mkTrack(-1);
  const tr = mkTrack(1);

  // ---------------------------------------------------------------- turret
  const turret = new THREE.Group();
  turret.position.copy(turretPivot);
  hull.add(turret);
  const tPaint: THREE.BufferGeometry[] = [];
  const tDark: THREE.BufferGeometry[] = [];
  const tGlass: THREE.BufferGeometry[] = [];
  let gunPivot: THREE.Vector3;
  let turretBox: TankModel['turretBox'];
  const sight = new THREE.Object3D();

  if (west) {
    tPaint.push(
      prismY(
        [[-1.75, -2.3], [1.75, -2.3], [1.8, 0.95], [1.42, 1.95], [-1.42, 1.95], [-1.8, 0.95]],
        0,
        0.82,
        [[-1.62, -2.2], [1.62, -2.2], [1.66, 0.9], [1.32, 1.78], [-1.32, 1.78], [-1.66, 0.9]],
      ),
    );
    tPaint.push(box(0.9, 0.64, 0.45, 0, 0.4, 2.05)); // mantlet
    // commander cupola + periscopes
    tPaint.push(cyl(0.38, 0.36, 0.22, 20, 'y', 0.78, 0.93, -0.65));
    tPaint.push(cyl(0.3, 0.3, 0.06, 20, 'y', 0.78, 1.07, -0.65));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      tGlass.push(box(0.1, 0.07, 0.03, 0.78 + Math.sin(a) * 0.37, 0.95, -0.65 + Math.cos(a) * 0.37, 0, a, 0));
    }
    // gunner primary sight
    tPaint.push(box(0.4, 0.3, 0.6, 0.85, 0.97, 1.0));
    tGlass.push(box(0.3, 0.18, 0.03, 0.85, 0.99, 1.31));
    sight.position.set(0.85, 1.05, 1.3);
    // commander panoramic periscope
    tPaint.push(cyl(0.14, 0.16, 0.3, 14, 'y', -0.3, 0.97, -0.3));
    tGlass.push(box(0.2, 0.1, 0.03, -0.3, 1.06, -0.15));
    // loader hatch + MG
    tPaint.push(cyl(0.34, 0.34, 0.05, 18, 'y', -0.72, 0.845, -0.55));
    tDark.push(cyl(0.02, 0.025, 1.0, 8, 'z', -0.72, 1.05, -0.2), box(0.1, 0.14, 0.4, -0.72, 1.0, -0.6));
    // smoke dischargers
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        tDark.push(cyl(0.055, 0.055, 0.32, 10, 'z', s * 1.78, 0.5 + (i % 2) * 0.13, -0.9 - Math.floor(i / 2) * 0.13, false));
      }
    }
    // bustle stowage basket
    tDark.push(box(3.2, 0.04, 0.45, 0, 0.55, -2.52), box(3.2, 0.3, 0.03, 0, 0.7, -2.75));
    tPaint.push(box(1.2, 0.3, 0.38, 0.8, 0.72, -2.5), box(0.9, 0.26, 0.38, -0.6, 0.7, -2.5));
    // antennas + wind sensor
    tDark.push(cyl(0.008, 0.015, 2.4, 6, 'y', 1.45, 2.0, -2.05), cyl(0.008, 0.015, 2.4, 6, 'y', -1.45, 2.0, -2.05));
    tDark.push(cyl(0.015, 0.015, 0.5, 6, 'y', 0.1, 1.07, -1.9));
    gunPivot = V(0, 0.4, 1.7);
    turretBox = { c: V(0, 0.42, -0.2), h: V(1.8, 0.45, 2.15) };
  } else {
    tPaint.push(sphereCap(1.38, 0.74, 1.5, 32, 12, 0, 0, 0.0));
    tPaint.push(cyl(1.38, 1.38, 0.12, 32, 'y', 0, -0.05, 0));
    // Kontakt ERA "V" on the turret front
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const a = 0.35 + c * 0.22;
        for (const s of [-1, 1]) {
          const ang = s * a;
          tPaint.push(box(0.3, 0.14, 0.42, Math.sin(ang) * 1.36, 0.22 + r * 0.17, Math.cos(ang) * 1.36, 0, ang, 0));
        }
      }
    }
    tPaint.push(box(0.75, 0.5, 0.35, 0, 0.3, 1.35)); // mantlet
    // cupola with heavy MG
    tPaint.push(cyl(0.36, 0.38, 0.2, 20, 'y', 0.55, 0.72, -0.35));
    tDark.push(cyl(0.028, 0.035, 1.5, 8, 'z', 0.55, 1.0, 0.25), box(0.18, 0.2, 0.45, 0.55, 0.95, -0.35));
    tPaint.push(cyl(0.32, 0.32, 0.05, 18, 'y', -0.55, 0.7, -0.3));
    // gunner sight "doghouse"
    tPaint.push(box(0.36, 0.28, 0.45, -0.62, 0.72, 0.55));
    tGlass.push(box(0.26, 0.16, 0.03, -0.62, 0.74, 0.79));
    sight.position.set(-0.62, 0.8, 0.8);
    // IR searchlight
    tDark.push(cyl(0.22, 0.22, 0.28, 18, 'z', 0.62, 0.62, 1.1));
    tGlass.push(cyl(0.19, 0.19, 0.02, 18, 'z', 0.62, 0.62, 1.25));
    // smoke launchers on the front arc
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const a = s * (0.9 + i * 0.13);
        tDark.push(cyl(0.05, 0.05, 0.28, 10, 'z', Math.sin(a) * 1.28, 0.42, Math.cos(a) * 1.28 - 0.1));
      }
    }
    // snorkel tube + stowage on the turret rear
    tDark.push(cyl(0.12, 0.12, 1.6, 12, 'x', 0, 0.45, -1.55));
    tPaint.push(box(1.1, 0.3, 0.3, 0.6, 0.3, -1.45));
    tDark.push(cyl(0.008, 0.015, 2.3, 6, 'y', -0.9, 1.6, -0.9));
    gunPivot = V(0, 0.3, 1.15);
    turretBox = { c: V(0, 0.33, 0), h: V(1.4, 0.42, 1.5) };
  }
  addMesh(turret, tPaint, paint, turretPivot);
  addMesh(turret, tDark, dark, turretPivot);
  addMesh(turret, tGlass, glass, turretPivot);
  turret.add(sight);

  // ---------------------------------------------------------------- gun
  const gun = new THREE.Group();
  gun.position.copy(gunPivot);
  turret.add(gun);
  const gunLen = west ? 5.3 : 6.0;
  const gParts: THREE.BufferGeometry[] = [];
  const gDark: THREE.BufferGeometry[] = [];
  const start = west ? 0.55 : 0.3;
  const rBase = west ? 0.115 : 0.12;
  // thermal sleeve sections with clamp bands
  const sections = 4;
  const evac = west ? 0.45 : 0.5; // fume extractor position (fraction of length)
  for (let i = 0; i < sections; i++) {
    const z0 = start + (i / sections) * gunLen * 0.95;
    const z1 = start + ((i + 1) / sections) * gunLen * 0.95 - 0.04;
    const r0 = rBase - i * 0.008;
    const r1 = rBase - (i + 1) * 0.008 + 0.004;
    gParts.push(cyl(r0, r1, z1 - z0, 20, 'z', 0, 0, (z0 + z1) / 2));
    gDark.push(cyl(r0 + 0.012, r0 + 0.012, 0.05, 20, 'z', 0, 0, z1 + 0.02));
  }
  const ez = start + gunLen * evac;
  gParts.push(cyl(rBase + 0.045, rBase + 0.045, 0.7, 22, 'z', 0, 0, ez));
  gParts.push(cyl(rBase - 0.01, rBase + 0.045, 0.1, 22, 'z', 0, 0, ez - 0.4), cyl(rBase + 0.045, rBase - 0.01, 0.1, 22, 'z', 0, 0, ez + 0.4));
  gDark.push(cyl(0.09, 0.09, 0.12, 20, 'z', 0, 0, start + gunLen - 0.02));
  if (!west) gDark.push(box(0.05, 0.05, gunLen * 0.7, 0, rBase + 0.02, start + gunLen * 0.4)); // bore-sight rod
  const gunOffset = turretPivot.clone().add(gunPivot);
  addMesh(gun, gParts, paint, gunOffset);
  addMesh(gun, gDark, dark, gunOffset);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, start + gunLen + 0.05);
  gun.add(muzzle);

  const materials: THREE.Material[] = [paint, dark, rubber, steel, glass, headlightMat, tl.mat, tr.mat];
  const model: TankModel = {
    root, hull, turret, gun, muzzle, sight, turretPivot, gunPivot, uniforms, materials,
    trackMats: [tl.mat, tr.mat], trackTex: [tl.tex, tr.tex], wheels, wheelSpecs: layout.roadWheels,
    sprockets, idlers, trackX: layout.trackX, linkPitch, hullBox, turretBox, gunLength: start + gunLen,
    exhaust, headlights, headlightMat,
  };
  updateWheels(model, 0, 0);
  return model;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _x = new THREE.Vector3(1, 0, 0);

/** Rotates wheels and scrolls the track textures from each side's travelled distance. */
export function updateWheels(m: TankModel, distL: number, distR: number): void {
  const n = m.wheelSpecs.length;
  for (let s = 0; s < 2; s++) {
    const dist = s === 0 ? distL : distR;
    const side = s === 0 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const w = m.wheelSpecs[i]!;
      _q.setFromAxisAngle(_x, dist / w.r);
      _p.set(side * m.trackX, w.y, w.z);
      _m.compose(_p, _q, _s);
      m.wheels.setMatrixAt(s * n + i, _m);
    }
    m.sprockets[s]!.rotation.x = dist / 0.33;
    m.idlers[s]!.rotation.x = dist / 0.3;
    m.trackTex[s]!.offset.y = -dist / m.linkPitch;
  }
  m.wheels.instanceMatrix.needsUpdate = true;
}
