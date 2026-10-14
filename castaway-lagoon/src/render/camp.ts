import { float, mx_noise_float, positionLocal, vec3 } from 'three/tsl';
import { BoxGeometry, BufferAttribute, type BufferGeometry, CylinderGeometry, DodecahedronGeometry, Group, Mesh, MeshBasicNodeMaterial, PlaneGeometry, PointLight } from 'three/webgpu';
import type { P3 } from '../game/events.ts';
import { CAMP_CRATES } from '../game/guerrillas.ts';
import { heightAt } from '../game/terrain.ts';
import { lightColour } from './colour.ts';
import { merge } from './meshkit.ts';
import { markDry } from './outpost.ts';
import { propMaterials } from './propMaterials.ts';
import { U } from './uniforms.ts';

// The guerrillas' camp in the jungle (game/guerrillas.ts places it): a lean-to
// of olive canvas on cut poles over two sleeping mats, ammunition and supply
// crates, a ring of stones round a fire that has burnt down to a bed of
// glowing embers (a dim orange light after dark), and a pot on a stone.
// Built from the shelter's own prop materials so the two camps belong to the
// same island. The camp's crates are solid in the logic (game/guerrillas.ts).

/** Embers' luminance (cd/m²) and the fire bed's light (lm). */
const EMBER_NITS = 1200;
const EMBER_FLUX_LM = 400;

export interface CampView {
  group: Group;
  update(night: number, preExposure: number, timeS: number): void;
}

export function buildCamp(at: P3): CampView {
  const M = propMaterials();
  const group = new Group();
  group.name = 'guerrilla camp';
  const ground = (x: number, z: number): number => heightAt(at.x + x, at.z + z) - at.y;
  const add = (g: BufferGeometry, m: Mesh['material'], dry = 0): void => {
    markDry(g, dry);
    const mesh = new Mesh(g, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  // Lean-to: two forked uprights, a ridge pole, the canvas sloping back to the ground, staked.
  const poles: BufferGeometry[] = [];
  for (const x of [-1.6, 1.6]) poles.push(new CylinderGeometry(0.04, 0.05, 1.7, 7).translate(x, ground(x, -3) + 0.85, -3));
  poles.push(new CylinderGeometry(0.035, 0.035, 3.6, 7).rotateZ(Math.PI / 2).translate(0, ground(0, -3) + 1.65, -3));
  add(merge(poles, 'camp poles'), M.logBark);
  const tarp = new PlaneGeometry(3.6, 2.4, 6, 4).rotateX(-Math.PI / 2 + 0.75).translate(0, ground(0, -4) + 0.85, -3.85);
  const flap = new Float32Array(tarp.getAttribute('position').count);
  const tp = tarp.getAttribute('position');
  for (let i = 0; i < flap.length; i++) flap[i] = Math.min(1, Math.abs(tp.getX(i)) / 1.8) * 0.5 + 0.2;
  tarp.setAttribute('flap', new BufferAttribute(flap, 1));
  add(tarp, M.tarp);
  // Sleeping mats under it.
  for (const x of [-0.8, 0.8]) add(new BoxGeometry(0.7, 0.03, 1.9).translate(x, ground(x, -3.7) + 0.02, -3.7).rotateY(0), M.blanket, 1);
  // Crates: ammunition boxes and a supply crate.
  for (const c of CAMP_CRATES) {
    const g = new BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2).rotateY(c.yawRad).translate(c.x, ground(c.x, c.z) + c.hy, c.z);
    add(g, c.hx > 0.4 ? M.darkWood : M.olivePaint);
  }
  // Fire ring: stones round a bed of charred wood.
  const stones: BufferGeometry[] = [];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const x = Math.cos(a) * 0.55;
    const z = Math.sin(a) * 0.55;
    stones.push(new DodecahedronGeometry(0.11 + (k % 3) * 0.02, 0).scale(1, 0.7, 1.1).rotateY(k).translate(x, ground(x, z) + 0.05, z));
  }
  add(merge(stones, 'camp stones'), M.charcoal);
  const logs: BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) logs.push(new CylinderGeometry(0.05, 0.06, 0.6, 7).rotateZ(Math.PI / 2).rotateY((k / 4) * Math.PI + 0.3).translate(0, ground(0, 0) + 0.06, 0));
  add(merge(logs, 'camp logs'), M.charcoal);
  // A blackened pot on a flat stone by the fire.
  add(new CylinderGeometry(0.12, 0.1, 0.18, 12).translate(0.85, ground(0.85, 0.2) + 0.12, 0.2), M.charcoal);
  // Embers: a glowing bed, flickering in a slow noise.
  const emberMat = new MeshBasicNodeMaterial({ name: 'camp embers' });
  const ec = lightColour(1300);
  const flick = mx_noise_float(positionLocal.mul(9).add(vec3(U.time.mul(0.8), 0, 0))).mul(0.5).add(0.5);
  emberMat.colorNode = vec3(ec.r, ec.g, ec.b).mul(U.preExposure.mul(EMBER_NITS)).mul(flick.mul(flick).mul(1.4).add(float(0.1)));
  const embers = new Mesh(new CylinderGeometry(0.32, 0.36, 0.04, 14).translate(0, ground(0, 0) + 0.02, 0), emberMat);
  group.add(embers);
  const light = new PointLight(0xff7a30, 0, 9, 2);
  const lc = lightColour(1500);
  light.color.setRGB(lc.r, lc.g, lc.b);
  light.position.set(0, ground(0, 0) + 0.4, 0);
  group.add(light);
  group.position.set(at.x, at.y, at.z);
  return {
    group,
    update(night: number, preExposure: number, timeS: number): void {
      const flicker = 0.85 + 0.1 * Math.sin(timeS * 7.3) + 0.05 * Math.sin(timeS * 17.1);
      light.intensity = (EMBER_FLUX_LM / (4 * Math.PI)) * preExposure * flicker * Math.max(0.15, night);
    },
  };
}
