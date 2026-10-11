import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  BufferAttribute,
  type BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';
import { fbm2 } from '../core/noise.ts';
import type { MapProp, PropKind } from '../maps/types.ts';
import type { MaterialLibrary } from './materials.ts';

// Props: one InstancedMesh per (kind, material part), sized from real objects
// (scale sheet: light 4x4 4.60 m, a hatchback 4.2 m; ISO container 6.06 m).
// Colliders for the same props are added by the map builder (maps/builder.ts).

// Car paint palette: sheet car paint #6E2A24 plus common factory colours, all
// inside the non-metal luminance range.
const CAR_COLOURS = [0x6e2a24, 0x2e3a4a, 0x8f8b85, 0x3c3c3e, 0xb4b0a8, 0x4b5340];

interface Part {
  geometry: BufferGeometry;
  material: Material;
  tinted?: boolean;
  castShadow?: boolean;
}

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(sx, sy, sz).translate(x, y, z);
}

function merge(list: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(list, false);
  if (!g) throw new Error('prop geometry merge failed: parts have mismatched attributes');
  return g;
}

function wheel(x: number, z: number, r: number, w: number): BufferGeometry {
  return new CylinderGeometry(r, r, w, 14).rotateZ(Math.PI / 2).translate(x, r, z);
}

function partsFor(kind: PropKind, lib: MaterialLibrary): Part[] {
  switch (kind) {
    case 'car': {
      const body = merge([box(1.8, 0.62, 4.2, 0, 0.62, 0), box(1.62, 0.1, 2.3, 0, 0.98, 0.25)]);
      const cabin = merge([box(1.56, 0.44, 2.1, 0, 1.25, 0.25)]);
      const tyres = merge([wheel(-0.82, -1.35, 0.31, 0.2), wheel(0.82, -1.35, 0.31, 0.2), wheel(-0.82, 1.35, 0.31, 0.2), wheel(0.82, 1.35, 0.31, 0.2), box(1.84, 0.18, 0.12, 0, 0.42, -2.1), box(1.84, 0.18, 0.12, 0, 0.42, 2.1)]);
      return [
        { geometry: body, material: lib.get('carPaint'), tinted: true },
        { geometry: cabin, material: lib.get('darkGlass') },
        { geometry: tyres, material: lib.get('tyre') },
      ];
    }
    case 'carWreck': {
      const shell = merge([box(1.8, 0.55, 4.2, 0, 0.55, 0), box(1.5, 0.34, 2.0, 0, 1.0, 0.2)]);
      const rims = merge([wheel(-0.82, -1.35, 0.24, 0.16), wheel(0.82, 1.35, 0.24, 0.16), box(1.7, 0.35, 0.4, 0, 0.3, -2.0)]);
      return [
        { geometry: shell, material: lib.get('carWreck') },
        { geometry: rims, material: lib.get('steel') },
      ];
    }
    case 'container':
      return [{ geometry: containerGeometry(), material: lib.get('containerPaint') }];
    case 'barrier': {
      // Jersey barrier: wide foot, sloped face, narrow top (0.81 m tall).
      const g = merge([box(0.6, 0.08, 3.0, 0, 0.04, 0), box(0.48, 0.25, 3.0, 0, 0.2, 0), box(0.28, 0.5, 3.0, 0, 0.56, 0)]);
      return [{ geometry: g, material: lib.look('concrete').material }];
    }
    case 'lampPost': {
      const g = merge([new CylinderGeometry(0.06, 0.09, 6.5, 8).translate(0, 3.25, 0), box(0.08, 0.08, 1.4, 0, 6.4, 0.65), box(0.3, 0.12, 0.55, 0, 6.3, 1.3)]);
      // The diffuser under the head: the lamp's light source at night (render/cityLights.ts).
      const lens = box(0.24, 0.02, 0.48, 0, 6.235, 1.3);
      return [
        { geometry: g, material: lib.look('metalDark').material },
        { geometry: lens, material: lib.get('lampLens'), castShadow: false },
      ];
    }
    case 'streetTree': {
      const trunk = new CylinderGeometry(0.1, 0.16, 3.2, 8).translate(0, 1.6, 0);
      const crown = merge([new IcosahedronGeometry(1.9, 1).translate(0, 4.4, 0), new IcosahedronGeometry(1.4, 1).translate(0.6, 5.4, 0.3)]);
      return [
        { geometry: trunk, material: lib.get('bark') },
        { geometry: crown, material: lib.get('leaves') },
      ];
    }
    case 'bench': {
      const wood = merge([box(1.8, 0.05, 0.45, 0, 0.45, 0), box(1.8, 0.35, 0.05, 0, 0.7, 0.22)]);
      const legs = merge([box(0.06, 0.45, 0.45, -0.8, 0.22, 0), box(0.06, 0.45, 0.45, 0.8, 0.22, 0)]);
      return [
        { geometry: wood, material: lib.look('wood').material },
        { geometry: legs, material: lib.look('metalDark').material },
      ];
    }
    case 'trashBin':
      return [{ geometry: new CylinderGeometry(0.3, 0.27, 1.0, 12).translate(0, 0.5, 0), material: lib.look('metalDark').material }];
    case 'rock':
      return [{ geometry: rockGeometry(), material: lib.get('boulder') }];
    case 'hayBale':
      return [{ geometry: new CylinderGeometry(0.6, 0.6, 1.8, 14).rotateX(Math.PI / 2).translate(0, 0.6, 0), material: lib.get('hay') }];
    case 'beam':
      return [{ geometry: box(0.25, 0.25, 4.0, 0, 0.125, 0), material: lib.look('wood').material }];
    case 'crate':
      return [{ geometry: box(1, 1, 1, 0, 0.5, 0), material: lib.look('wood').material }];
    case 'rangeSign':
    case 'dummy':
      return []; // signs are built one by one (each has its own label); dummies are soldiers
  }
}

/** ISO 20 ft container, 6.06 × 2.44 × 2.59 m, with corrugated sides. */
function containerGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [box(2.44, 2.59, 6.06, 0, 1.295, 0)];
  for (let z = -2.8; z <= 2.8; z += 0.28) {
    parts.push(box(2.48, 2.3, 0.1, 0, 1.3, z));
  }
  return merge(parts);
}

/**
 * A weathered boulder: a finely subdivided sphere pushed out by layered noise
 * with a flat facet or two, sunk flat where it sits in the ground. Welded
 * before the normals are computed so it shades smoothly, not as facets.
 */
function rockGeometry(): BufferGeometry {
  const seed = 5;
  const g = new IcosahedronGeometry(1, 5);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const welded = mergeVertices(g);
  const pos = welded.getAttribute('position');
  const v = new Vector3();
  const facetDir = new Vector3(Math.sin(seed), 0.4, Math.cos(seed)).normalize();
  const uvs = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const a = fbm2(v.x * 1.6 + seed, v.z * 1.6 + v.y * 0.7, 5, seed);
    const b = fbm2(v.y * 2.3 + seed * 0.3, v.x * 2.3 - v.z, 4, seed + 7);
    let r = 1 + a * 0.28 + b * 0.12;
    const facet = v.dot(facetDir);
    if (facet > 0.55) r -= (facet - 0.55) * 0.9;
    const y = v.y * r;
    pos.setXYZ(i, v.x * r * 1.15, (y < -0.25 ? -0.25 + (y + 0.25) * 0.3 : y) * 0.8, v.z * r);
    uvs[i * 2] = v.x;
    uvs[i * 2 + 1] = v.z;
  }
  welded.setAttribute('uv', new BufferAttribute(uvs, 2));
  welded.computeVertexNormals();
  return welded.translate(0, 0.3, 0);
}

export function buildProps(props: readonly MapProp[], lib: MaterialLibrary): Group {
  const group = new Group();
  group.name = 'props';
  const byKind = new Map<PropKind, MapProp[]>();
  for (const p of props) {
    let list = byKind.get(p.kind);
    if (!list) {
      list = [];
      byKind.set(p.kind, list);
    }
    list.push(p);
  }
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const colour = new Color();
  for (const [kind, list] of byKind) {
    if (kind === 'rangeSign') {
      for (const p of list) group.add(rangeSign(p, lib));
      continue;
    }
    for (const part of partsFor(kind, lib)) {
      const mesh = new InstancedMesh(part.geometry, part.material, list.length);
      mesh.name = `prop-${kind}`;
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = true;
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.yawRad);
        m.compose(new Vector3(p.pos.x, p.pos.y, p.pos.z), q, new Vector3(p.scale, p.scale, p.scale));
        mesh.setMatrixAt(i, m);
        if (part.tinted) mesh.setColorAt(i, colour.setHex(CAR_COLOURS[(p.colourIndex ?? 0) % CAR_COLOURS.length] ?? 0x6e2a24));
      });
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  return group;
}

/** Range distance board: a painted board on a post, the distance in metres on it. */
function rangeSign(p: MapProp, lib: MaterialLibrary): Group {
  const g = new Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable for range sign labels');
  ctx.fillStyle = '#d6d6d0'; // sheet road paint: never pure white
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#2b2b2c'; // sheet soot: never pure black
  ctx.font = 'bold 92px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.label ?? '', 128, 68);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const board = new Mesh(new BoxGeometry(1.2, 0.6, 0.04), new MeshStandardNodeMaterial({ map: tex, roughness: 0.6 }));
  board.position.set(0, 1.3, 0);
  const post = new Mesh(new BoxGeometry(0.08, 1.1, 0.08), lib.look('wood').material);
  post.position.set(0, 0.55, 0.03);
  board.castShadow = post.castShadow = true;
  g.add(board, post);
  g.position.set(p.pos.x, p.pos.y, p.pos.z);
  g.rotation.y = p.yawRad;
  return g;
}
