import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CastRig } from '../src/render/castRig.ts';
import type { Joints } from '../src/render/mpfbCast.ts';

// Every MPFB character in the assets: his measurements are sane, and posed in the procedural bind pose
// (each segment upright, facing −Z, at its joint) his skin matrices are finite and keep the pelvis in place (shorter casts stand lower: 0.7 m and up).
// Read through Vite's glob (the project's types are the browser's, not Node's).
const JSONS = import.meta.glob<{ joints: Joints }>('../src/assets/people/*_far.json', { eager: true, import: 'default' });
const files = Object.keys(JSONS).map((path) => path.slice(path.lastIndexOf('/') + 1));

describe('castRig', () => {
  it('finds the band', () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    it(`retargets ${f}`, () => {
      const entry = Object.entries(JSONS).find(([path]) => path.endsWith(`/${f}`));
      if (!entry) throw new Error(`no ${f}`);
      const joints = entry[1].joints;
      const rig = new CastRig(joints);
      const d = rig.dims;
      for (const v of [d.thigh, d.shin, d.upperArm, d.forearm, d.ankleY, d.standHip, d.legScale]) expect(Number.isFinite(v)).toBe(true);
      expect(d.thigh).toBeGreaterThan(0.3);
      expect(d.standHip).toBeGreaterThan(0.7);
      expect(d.standHip).toBeLessThan(1.15);
      const seg = Array.from({ length: 15 }, () => new Matrix4().makeTranslation(0, 0.95, 0));
      const out: Matrix4[] = [];
      rig.skin(seg, (_b, m) => out.push(m.clone()));
      expect(out.length).toBe(21);
      for (const m of out) for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
      const p = new Vector3();
      out[0]?.decompose(p, new Quaternion(), new Vector3());
      expect(p.length()).toBeLessThan(3);
    });
  }
});
