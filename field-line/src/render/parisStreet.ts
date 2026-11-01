import { Group } from 'three/webgpu';
import { boulevardPlan, PARIS_SHIFT_Z } from '../maps/boulevard.ts';
import { buildBuildings } from '../paris/city/buildings.ts';
import { buildStreet } from '../paris/city/street.ts';
import { buildTrees } from '../paris/city/trees.ts';
import { SCENE } from '../paris/render/nodes.ts';
import { loadPhotos } from '../paris/render/photo.ts';
import type { LightingPreset } from '../config.ts';

// The boulevard map's look: the Paris scene's own street and Haussmann façades (paris/), in
// its frame shifted onto the map's. The map's colliders (maps/boulevard.ts) stand behind them.

export async function buildParisStreet(): Promise<Group> {
  await loadPhotos();
  const group = new Group();
  group.name = 'paris';
  const plan = boulevardPlan();
  // The plane trees too (their trunks are the map's colliders, maps/boulevard.ts).
  group.add(buildStreet(), buildBuildings(plan), buildTrees(plan.trees));
  group.position.z = PARIS_SHIFT_Z;
  group.updateMatrixWorld(true);
  return group;
}

/**
 * The Paris materials' light levels (pre-exposed, as the Paris scene's lighting sets them): rooms seen
 * through the windows, lit shops, lanterns. Rooms are lit only when the day is dim enough to need it.
 */
export function syncParisLight(preset: LightingPreset, preExposure: number): void {
  const daylight = preset.skyIlluminanceLux + preset.sunIlluminanceLux * 0.2;
  SCENE.interiorLux.value = daylight * 0.025 * preExposure;
  SCENE.roomLampNits.value = (daylight < 2000 ? 60 : 0) * preExposure;
  SCENE.shopNits.value = 260 * preExposure;
  SCENE.lanternNits.value = 3500 * preExposure;
  SCENE.leafSunNits.value = (preset.sunIlluminanceLux * 0.2 * preExposure) / Math.PI;
  const ce = Math.cos(preset.sunElevationRad);
  // As render/lighting.ts places the sun.
  SCENE.sunDir.value.set(ce * Math.sin(preset.sunAzimuthRad), Math.sin(preset.sunElevationRad), ce * Math.cos(preset.sunAzimuthRad));
}

/** The breeze in the plane trees' crowns runs on the game's clock. */
export function tickParis(timeSeconds: number): void {
  SCENE.time.value = timeSeconds;
}
