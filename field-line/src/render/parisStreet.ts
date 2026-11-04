import { vec3 } from 'three/tsl';
import { Group, type Material, Mesh, MeshStandardNodeMaterial, type Node, type Object3D, Vector3 } from 'three/webgpu';
import { boulevardPlan, PARIS_SHIFT_Z } from '../maps/boulevard.ts';
import { buildBuildings } from '../paris/city/buildings.ts';
import { buildFurniture } from '../paris/city/furniture.ts';
import { buildStreet } from '../paris/city/street.ts';
import { buildTrees } from '../paris/city/trees.ts';
import { SCENE } from '../paris/render/nodes.ts';
import { loadPhotos } from '../paris/render/photo.ts';
import { CITY_LIGHTS, type LightingPreset } from '../config.ts';
import { STREET } from '../paris/config.ts';
import type { LampSet } from './cityLights.ts';
import { presetSunDir } from './lighting.ts';
import { lampLit } from './materials.ts';

// The boulevard map's look: the Paris scene's own street and Haussmann façades (paris/), in
// its frame shifted onto the map's. The map's colliders (maps/boulevard.ts) stand behind them.

export async function buildParisStreet(): Promise<Group> {
  await loadPhotos();
  const group = new Group();
  group.name = 'paris';
  const plan = boulevardPlan();
  // The plane trees too (their trunks are the map's colliders, maps/boulevard.ts).
  group.add(buildStreet(), buildBuildings(plan), buildTrees(plan.trees), buildFurniture(plan));
  group.position.z = PARIS_SHIFT_Z;
  group.updateMatrixWorld(true);
  litByLamps(group);
  return group;
}

/**
 * The street lamps' baked light (render/cityLights.ts) on the Paris materials too, as Field Line's own
 * materials take it (materials.ts lampLit): albedo × E / π added to what they emit. Only materials whose
 * albedo is a node (all of the Paris street's) can take it.
 */
function litByLamps(root: Object3D): void {
  const done = new Set<Material>();
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (done.has(m) || !(m instanceof MeshStandardNodeMaterial) || !m.colorNode) continue;
      done.add(m);
      // Albedo as rgb, whether the node is a colour, a vec3 or a vec4 (vec3() takes the first three).
      const lit = lampLit(vec3(m.colorNode as Node<'vec4'>));
      if (lit) m.emissiveNode = m.emissiveNode ? (m.emissiveNode as Node<'vec3'>).add(lit) : lit;
    }
  });
}

/** The boulevard's lamps for the night (render/cityLights.ts): the candelabra's lanterns. */
export function parisLamps(halfSizeM: number): LampSet {
  const heads = boulevardPlan()
    .lamps.map((l) => new Vector3(l.x, STREET.kerbM + LANTERN_Y_M, l.z + PARIS_SHIFT_Z))
    .filter((h) => Math.abs(h.z) < halfSizeM + 20);
  return { heads, cd: LANTERN_CD, kelvin: 2700 };
}

/** The lantern's centre above the kerb (paris/city/furniture.ts lampGeometry). */
const LANTERN_Y_M = 4.16;
/**
 * A lantern's light down onto the street: an LED retrofit of ~3000 lm in a four-sided glass lantern spreads
 * it over the lower hemisphere, ~500–600 cd toward the ground: 35–40 lux under a lamp, a Paris street's
 * 20–30 on average between them (where City's cut-off luminaires give 2500 cd from 6 m).
 */
const LANTERN_CD = 600;

/**
 * The Paris materials' light levels (pre-exposed, as the Paris scene's lighting sets them): rooms seen
 * through the windows, lit shops, lanterns. Rooms are lit only when the day is dim enough to need it.
 */
export function syncParisLight(preset: LightingPreset, preExposure: number): void {
  const daylight = preset.skyIlluminanceLux + preset.sunIlluminanceLux * 0.2;
  SCENE.interiorLux.value = daylight * 0.025 * preExposure;
  // By night the windows and shops shine at Field Line's night sheet (CITY_LIGHTS, as City's do): the
  // Paris scene's 60 and 260 cd/m² were set for its golden hour, and against a night exposure they
  // blew out every front and filled the street's haze with their bloom.
  const night = daylight < 50;
  SCENE.roomLampNits.value = (night ? CITY_LIGHTS.windowLuminance : daylight < 2000 ? 60 : 0) * preExposure;
  SCENE.shopNits.value = (night ? CITY_LIGHTS.shopLuminance : 260) * preExposure;
  // The candelabra's lanterns are lit from dusk to dawn (sun below ~12°: golden hour and night).
  SCENE.lanternNits.value = (preset.sunElevationRad < 0.21 ? 3500 : 0) * preExposure;
  SCENE.leafSunNits.value = (preset.sunIlluminanceLux * 0.2 * preExposure) / Math.PI;
  presetSunDir(preset, SCENE.sunDir.value);
}

/** The breeze in the plane trees' crowns runs on the game's clock. */
export function tickParis(timeSeconds: number): void {
  SCENE.time.value = timeSeconds;
}
