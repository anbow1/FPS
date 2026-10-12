import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three/webgpu';
import { solveTwoBone } from '../src/render/actors.ts';

describe('two-bone IK for the soldiers’ arms and legs', () => {
  const root = new Vector3(0, 0.93, 0);
  const mid = new Vector3();
  const end = new Vector3();

  it('keeps both bone lengths and reaches a target within range', () => {
    const target = new Vector3(0.05, 0.12, -0.2);
    solveTwoBone(root, target, 0.43, 0.43, new Vector3(0, 0, -1), mid, end);
    expect(mid.distanceTo(root)).toBeCloseTo(0.43, 5);
    expect(end.distanceTo(mid)).toBeCloseTo(0.43, 5);
    expect(end.distanceTo(target)).toBeLessThan(1e-5);
  });

  it('bends the joint toward the pole (a knee forward)', () => {
    solveTwoBone(root, new Vector3(0, 0.2, 0), 0.43, 0.43, new Vector3(0, 0, -1), mid, end);
    expect(mid.z).toBeLessThan(-0.05);
  });

  it('straightens toward a target out of reach instead of breaking a bone', () => {
    const target = new Vector3(0, -2, 0);
    solveTwoBone(root, target, 0.43, 0.43, new Vector3(0, 0, -1), mid, end);
    expect(end.distanceTo(root)).toBeCloseTo(0.86, 3);
    expect(end.y).toBeLessThan(root.y);
    expect(mid.distanceTo(root)).toBeCloseTo(0.43, 5);
  });
});
