import { BoxGeometry, Matrix4, MeshBasicMaterial, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng.ts';
import { InstanceStream } from '../src/render/instanceStream.ts';

// The streamed plant meshes (render/instanceStream.ts): a refill must never be
// clipped by the fixed capacity, and the near and far sets of one placement
// list must together draw every tree exactly once, wherever the camera is.

function placements(n: number, halfM: number): { matrix: Matrix4 }[] {
  const rng = new Rng(3);
  return Array.from({ length: n }, () => ({ matrix: new Matrix4().makeTranslation(rng.range(-halfM, halfM), 0, rng.range(-halfM, halfM)) }));
}

describe('instance stream', () => {
  const geo = new BoxGeometry();
  const mat = new MeshBasicMaterial();

  it('holds every instance within the radius of the camera, wherever it stands', () => {
    const list = placements(3000, 200);
    const stream = new InstanceStream(geo, mat, list, { cellM: 16, radiusM: 40, castShadow: false });
    const rng = new Rng(9);
    const p = new Vector3();
    for (let k = 0; k < 40; k++) {
      const cam = new Vector3(rng.range(-230, 230), 0, rng.range(-230, 230));
      stream.update(cam);
      const inRange = list.filter((l) => p.setFromMatrixPosition(l.matrix).setY(0).distanceTo(cam) < 40).length;
      expect(stream.mesh.count).toBeGreaterThanOrEqual(inRange);
      expect(stream.mesh.count).toBeLessThanOrEqual(stream.mesh.instanceMatrix.count);
      // Every instance within the radius is among those drawn.
      const drawn = new Set<string>();
      const arr = stream.mesh.instanceMatrix.array;
      for (let i = 0; i < stream.mesh.count; i++) drawn.add(`${arr[i * 16 + 12]?.toFixed(3)},${arr[i * 16 + 14]?.toFixed(3)}`);
      for (const l of list) {
        p.setFromMatrixPosition(l.matrix);
        if (p.distanceTo(cam) < 40) expect(drawn.has(`${Math.fround(p.x).toFixed(3)},${Math.fround(p.z).toFixed(3)}`)).toBe(true); // the buffer holds float32
      }
    }
  });

  it('splits one list into near and far sets that draw each instance once', () => {
    const list = placements(2000, 300);
    const near = new InstanceStream(geo, mat, list, { cellM: 32, radiusM: 110, castShadow: false });
    const far = new InstanceStream(geo, mat, list, { cellM: 32, radiusM: 110, outside: true, castShadow: false });
    for (const cam of [new Vector3(0, 0, 0), new Vector3(250, 0, -120), new Vector3(-290, 0, 290)]) {
      near.update(cam);
      far.update(cam);
      expect(near.mesh.count + far.mesh.count).toBe(list.length);
    }
  });
});
