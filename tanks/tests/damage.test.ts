import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALLY_IFV, AMMO, ENEMY_IFV, ENEMY_TANK, PLAYER_TANK } from '../src/config';
import { resolveArmour, segmentBox } from '../src/game/damage';

describe('armour', () => {
  const front = new THREE.Vector3(0, 0, 1);
  it('APFSDS defeats the side but not the turret front at 2 km', () => {
    const dirIntoSide = new THREE.Vector3(-1, 0, 0);
    const side = resolveArmour(AMMO.APFSDS, ENEMY_TANK, 'hull', new THREE.Vector3(1, 0, 0), dirIntoSide, 2000, 0.5);
    expect(side.outcome).toBe('pen');
    const tf = resolveArmour(AMMO.APFSDS, ENEMY_TANK, 'turret', front, new THREE.Vector3(0, 0, -1), 2000, 0.5);
    expect(tf.outcome).toBe('nopen');
  });

  it('glancing hits ricochet', () => {
    const d = new THREE.Vector3(-Math.sin(1.45), 0, -Math.cos(1.45));
    expect(resolveArmour(AMMO.HEAT, ENEMY_TANK, 'hull', front, d, 500, 0.5).outcome).toBe('ricochet');
  });

  it('angle increases effective thickness', () => {
    const d45 = new THREE.Vector3(-Math.SQRT1_2, 0, -Math.SQRT1_2);
    const r = resolveArmour(AMMO.APFSDS, ENEMY_TANK, 'hull', front, d45, 0, 0.5);
    expect(r.effective).toBeCloseTo(ENEMY_TANK.armour.hullFront * Math.SQRT2, 0);
  });
});

describe('IFVs', () => {
  const intoFront = new THREE.Vector3(0, 0, -1);
  const front = new THREE.Vector3(0, 0, 1);
  const side = new THREE.Vector3(1, 0, 0);
  const intoSide = new THREE.Vector3(-1, 0, 0);
  const ap30 = ENEMY_IFV.rounds?.APFSDS;

  it('fire their own 30 mm rounds, smaller in effect than a tank gun', () => {
    expect(ap30?.label).toContain('30 mm');
    expect(ap30?.scale).toBeLessThan(0.5);
  });

  it('a tank round goes through an IFV from the front at 2 km', () => {
    expect(resolveArmour(AMMO.APFSDS, ENEMY_IFV, 'hull', front, intoFront, 2000, 0.5).outcome).toBe('pen');
    expect(resolveArmour(AMMO.HEAT, ALLY_IFV, 'turret', front, intoFront, 1000, 0.5).outcome).toBe('pen');
  });

  it("30 mm goes through the other side's IFV but not a tank's front or side", () => {
    if (!ap30) throw new Error('no 30 mm round');
    expect(resolveArmour(ap30, ALLY_IFV, 'hull', side, intoSide, 1000, 0.5).outcome).toBe('pen');
    expect(resolveArmour(ap30, ENEMY_IFV, 'hull', front, intoFront, 1000, 0.5).outcome).toBe('pen');
    expect(resolveArmour(ap30, PLAYER_TANK, 'hull', front, intoFront, 300, 0.5).outcome).not.toBe('pen');
    expect(resolveArmour(ap30, PLAYER_TANK, 'turret', side, intoSide, 300, 0.5).outcome).not.toBe('pen');
  });

  it("30 mm goes through a tank's rear at fighting range", () => {
    if (!ap30) throw new Error('no 30 mm round');
    const rear = new THREE.Vector3(0, 0, -1);
    expect(resolveArmour(ap30, PLAYER_TANK, 'hull', rear, new THREE.Vector3(0, 0, 1), 800, 0.5).outcome).toBe('pen');
  });
});

describe('segmentBox', () => {
  it('finds the entry face', () => {
    const n = new THREE.Vector3();
    const t = segmentBox(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -10), new THREE.Vector3(), new THREE.Vector3(1, 1, 2), n);
    expect(t).toBeCloseTo(0.4);
    expect(n.z).toBe(1);
  });
  it('misses', () => {
    const n = new THREE.Vector3();
    expect(segmentBox(new THREE.Vector3(5, 0, 10), new THREE.Vector3(5, 0, -10), new THREE.Vector3(), new THREE.Vector3(1, 1, 2), n)).toBe(-1);
  });
});
