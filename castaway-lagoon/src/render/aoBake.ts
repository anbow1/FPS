import { attribute, materialColor, mix, smoothstep, vec3 } from 'three/tsl';
import { BufferAttribute, type Group, Matrix3, Matrix4, Mesh, MeshStandardNodeMaterial, type Node, Vector3 } from 'three/webgpu';

// Ported from Ridgeline for the jeep and the skiff (playbook §6j, §6n).
//
// Ambient occlusion baked once per airframe at load: every opaque surface is
// rasterised into a voxel grid of the model (8 cm cells), then each vertex
// casts a fan of rays over its hemisphere through the grid (a 3-D DDA, up to
// 1.6 m) and keeps the share that escapes, cosine-weighted. The result is a
// per-vertex `ao` attribute fed to the materials' `aoNode`, which dims only the
// indirect (sky and probe) light — direct sun keeps its own shadow map.
//
// The same on every backend and free per frame; GTAO in three r186 unprojects
// depth with the WebGL convention, which is wrong for a reversed depth buffer
// on the WebGL2 fallback (see LOOK.md). Static parts only: a deflected flap
// keeps the occlusion of its neutral position, which is invisible in practice.

const CELL_M = 0.08;
// Fewer, shorter rays than the aircraft's: the jeep and the skiff are baked at load on phones too,
// and the corners that read (wheel arches, under the seats, round the outboard) are within a metre.
const RANGE_M = 1.2;
const RAYS = 12;
/** Materials already wired to `ao`: a material shared by several baked models gets the grime once, not once per bake. */
const wired = new WeakSet<MeshStandardNodeMaterial>();

/** Directions over the +z hemisphere: a Fibonacci spiral, cosine-distributed. */
function hemisphere(n: number): Vector3[] {
  const out: Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const phi = i * golden;
    out.push(new Vector3(Math.cos(phi) * r, Math.sin(phi) * r, Math.sqrt(1 - r * r)));
  }
  return out;
}

/** Bakes and applies `ao` to every opaque mesh under `root` (in root's own frame). */
export function bakeAmbientOcclusion(root: Group): void {
  root.updateMatrixWorld(true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const meshes: { mesh: Mesh; toRoot: Matrix4 }[] = [];
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m.transparent)) return;
    meshes.push({ mesh: o, toRoot: new Matrix4().multiplyMatrices(inv, o.matrixWorld) });
  });
  // Bounds in root space.
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const v = new Vector3();
  for (const { mesh, toRoot } of meshes) {
    const p = mesh.geometry.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(toRoot);
      min.min(v);
      max.max(v);
    }
  }
  min.subScalar(RANGE_M);
  max.addScalar(RANGE_M);
  const nx = Math.ceil((max.x - min.x) / CELL_M);
  const ny = Math.ceil((max.y - min.y) / CELL_M);
  const nz = Math.ceil((max.z - min.z) / CELL_M);
  const grid = new Uint8Array(nx * ny * nz);
  const cellOf = (x: number, y: number, z: number): number => {
    const i = Math.floor((x - min.x) / CELL_M);
    const j = Math.floor((y - min.y) / CELL_M);
    const k = Math.floor((z - min.z) / CELL_M);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -1;
    return (k * ny + j) * nx + i;
  };
  // Rasterise triangles: sample each at a spacing finer than a cell.
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const { mesh, toRoot } of meshes) {
    const g = mesh.geometry;
    const p = g.getAttribute('position');
    const index = g.getIndex();
    const tri = index ? index.count / 3 : p.count / 3;
    for (let t = 0; t < tri; t++) {
      const ia = index ? index.getX(t * 3) : t * 3;
      const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(p, ia).applyMatrix4(toRoot);
      b.fromBufferAttribute(p, ib).applyMatrix4(toRoot);
      c.fromBufferAttribute(p, ic).applyMatrix4(toRoot);
      const steps = Math.max(1, Math.ceil(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) / (CELL_M * 0.5)));
      for (let s = 0; s <= steps; s++) {
        for (let r = 0; r <= steps - s; r++) {
          const u = s / steps;
          const w = r / steps;
          const x = a.x + (b.x - a.x) * u + (c.x - a.x) * w;
          const y = a.y + (b.y - a.y) * u + (c.y - a.y) * w;
          const z = a.z + (b.z - a.z) * u + (c.z - a.z) * w;
          const cell = cellOf(x, y, z);
          if (cell >= 0) grid[cell] = 1;
        }
      }
    }
  }
  // Rays from every vertex over its normal's hemisphere.
  const dirs = hemisphere(RAYS);
  const n = new Vector3();
  const tangent = new Vector3();
  const bitangent = new Vector3();
  const dir = new Vector3();
  const normalMatrix = new Matrix3();
  // Rays leave from a point lifted off the surface along its normal: started on the surface, the grazing
  // ones (most of a cosine fan's outer ring) ran inside the surface's own voxels and counted it as cover,
  // so an open flat plate baked to ~0.4 instead of ~1 and a vehicle in shade went black.
  const normalLift = CELL_M * 1.5;
  const startOffset = CELL_M * 0.5;
  const stepM = CELL_M * 0.7;
  for (const { mesh, toRoot } of meshes) {
    const g = mesh.geometry;
    if (g.getAttribute('ao')) continue;
    const p = g.getAttribute('position');
    const normals = g.getAttribute('normal');
    if (!normals) continue;
    normalMatrix.getNormalMatrix(toRoot);
    const ao = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(toRoot);
      n.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      if (n.lengthSq() < 0.5) {
        ao[i] = 1;
        continue;
      }
      tangent.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
      bitangent.crossVectors(n, tangent);
      const ox = v.x + n.x * normalLift;
      const oy = v.y + n.y * normalLift;
      const oz = v.z + n.z * normalLift;
      let open = 0;
      for (const d of dirs) {
        dir.copy(tangent).multiplyScalar(d.x).addScaledVector(bitangent, d.y).addScaledVector(n, d.z);
        let hit = false;
        for (let t = startOffset; t < RANGE_M; t += stepM) {
          const cell = cellOf(ox + dir.x * t, oy + dir.y * t, oz + dir.z * t);
          if (cell >= 0 && grid[cell]) {
            hit = true;
            break;
          }
        }
        if (!hit) open++;
      }
      ao[i] = open / RAYS;
    }
    g.setAttribute('ao', new BufferAttribute(ao, 1));
  }
  // Feed it to the indirect light of every baked material, and to its colour: grime and exhaust
  // film collect where the airflow, the rain and the ground crew's rags do not reach (seams,
  // corners, under fittings). That darkening of the albedo itself, not of the light, is what
  // makes a model read as a used machine instead of a clean toy.
  for (const { mesh } of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!(m instanceof MeshStandardNodeMaterial) || wired.has(m)) continue;
      const ao = attribute('ao', 'float');
      // Remap so open skin stays at 1 and only real cavities darken.
      m.aoNode = ao.mul(1.15).clamp(0, 1);
      const grime = mix(vec3(0.6, 0.57, 0.52), vec3(1, 1, 1), smoothstep(0.3, 0.85, ao));
      m.colorNode = ((m.colorNode ?? materialColor) as Node<'vec3'>).mul(grime);
      wired.add(m);
    }
  }
}
