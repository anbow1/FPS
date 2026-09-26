import { Vector3 } from 'three/webgpu';
import { buildMap } from './maps/index.ts';
import { sampleHeight } from './maps/terrain.ts';
import type { MapId } from './maps/types.ts';
import { AutoExposure } from './render/exposure.ts';
import { buildFoliage } from './render/foliage.ts';
import { buildFarRing, buildTerrainMesh } from './render/ground.ts';
import { Lighting } from './render/lighting.ts';
import { MaterialLibrary } from './render/materials.ts';
import { buildProps } from './render/props.ts';
import { Stage } from './render/stage.ts';
import { buildStaticWorld } from './render/worldMesh.ts';
import type { LightingPresetId } from './config.ts';

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const mapId = (params.get('map') ?? 'range') as MapId;
  const preset = (params.get('light') ?? 'noon') as LightingPresetId;
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const quality = params.get('q') === 'low' ? 'low' : 'high';
  const stage = new Stage(canvas, { quality, renderScale: 1, toneMap: 'aces' });
  await stage.init();
  const map = buildMap(mapId);
  const lib = new MaterialLibrary();
  stage.scene.add(buildTerrainMesh(map, lib), buildFarRing(map), buildStaticWorld(map, lib).group, buildProps(map.props, lib), buildFoliage(map.trees, map.bushes, lib));
  const lighting = new Lighting(stage.renderer, stage.scene, quality);
  await lighting.apply(preset, map.playerSpawn.pos.y);
  if (params.get('sun') === '0') lighting.sun.intensity = 0;
  if (params.get('env') === '0') stage.scene.environmentIntensity = 0;
  const exposure = new AutoExposure(stage.renderer, lighting.preset.ev100);
  const p = map.playerSpawn.pos;
  const cam = params.get('cam')?.split(',').map(Number);
  const cx = cam?.[0] ?? p.x;
  const cz = cam?.[2] ?? p.z;
  stage.camera.position.set(cx, cam ? sampleHeight(map.terrain, cx, cz) + (cam[1] ?? 1.7) : p.y + 1.7, cz);
  stage.camera.rotation.set(Number(params.get('pitch') ?? 0), Number(params.get('yaw') ?? map.playerSpawn.yawRad), 0);
  let last = performance.now();
  const loop = (): void => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    lighting.update(stage.camera);
    stage.render();
    exposure.update(stage.hdrTexture, lighting.preExposure, lighting.preset.ev100, dt);
    stage.setExposure(Lighting.exposureMultiplier(lighting.preset.ev100, exposure.adaptedEv));
    (window as unknown as { __ev: number }).__ev = exposure.adaptedEv;
    requestAnimationFrame(loop);
  };
  loop();
  (window as unknown as { __ready: boolean }).__ready = true;
  void Vector3;
}

boot().catch((err: unknown) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:0;left:0">${String(err)}</pre>`);
});
