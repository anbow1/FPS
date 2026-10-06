import { Quaternion, Vector3 } from 'three/webgpu';
import { PilotControls } from './app/pilot.ts';
import { AIRCRAFT, type AircraftId, PHYSICS } from './config.ts';
import { Input } from './core/input.ts';
import { FixedLoop } from './core/loop.ts';
import { CameraRig } from './render/cameraRig.ts';
import { ForceArrows } from './render/forceArrows.ts';
import { buildGreyWorld, NOON } from './render/greyWorld.ts';
import { buildJet, poseGear, poseSurfaces } from './render/jetModels.ts';
import { buildAirbase, RUNWAY, THRESHOLD_36_Z } from './render/airbase.ts';
import { Stage, type StageSettings } from './render/stage.ts';
import { Aircraft } from './sim/aircraft.ts';
import { greyOut } from './sim/gTolerance.ts';
import { DebugOverlay } from './ui/debugOverlay.ts';
import { Hud } from './ui/hud.ts';
import { emChart, formatEmChart } from './sim/em.ts';
import { bakeTerrain, TERRAIN } from './sim/terrain.ts';
import { buildTerrainTextures } from './render/terrainTextures.ts';
import { TerrainRenderer } from './render/terrainMesh.ts';

// Contrail — milestone 1: the flight model in a grey sky with a debug overlay
// of every force (brief, build order step 1). Free flight; the aircraft is
// chosen with ?ac=wraith|talon. Controls: mouse or W/S A/D stick, Q/E pedals,
// Shift/Ctrl throttle (press again at 100 % for afterburner), L limiter,
// C camera, H overlay, O quality, T tone map.

const params = new URLSearchParams(location.search);
const aircraftId: AircraftId = params.get('ac') === 'talon' ? 'talon' : 'wraith';

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('index.html must contain canvas#view and div#ui');
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Contrail — loading';
  ui.appendChild(loading);

  const settings: StageSettings = { quality: params.get('q') === 'low' ? 'low' : 'high', renderScale: 1, toneMap: 'aces' };
  const stage = new Stage(canvas, settings);
  await stage.init();
  window.addEventListener('resize', () => stage.resize());

  // Pre-exposure from the preset's EV100 (rules §4.1); lights and sky are authored in lux.
  const exposure = 1 / (1.2 * Math.pow(2, NOON.ev100));
  const world = buildGreyWorld(stage.scene, exposure);
  stage.setExposure(1);
  const t0 = performance.now();
  const terrainData = await bakeTerrain((f) => (loading.textContent = `Contrail — shaping 819 km of terrain ${Math.round(f * 100)} %`));
  loading.textContent = 'Contrail — painting the land';
  const terrain = new TerrainRenderer(terrainData, await buildTerrainTextures(terrainData));
  console.log(`terrain baked in ${(performance.now() - t0).toFixed(0)} ms`);
  stage.scene.add(terrain.mesh);
  world.ground.visible = false;
  stage.scene.add(buildAirbase());
  // The sun's shadow follows the aircraft: self-shadowing and a shadow on the runway (cascades over
  // the land come with the atmosphere milestone).
  world.sun.castShadow = true;
  world.sun.shadow.mapSize.set(2048, 2048);
  const sc = world.sun.shadow.camera;
  sc.left = -45;
  sc.right = 45;
  sc.top = 45;
  sc.bottom = -45;
  sc.near = 1;
  sc.far = 2000;
  world.sun.shadow.bias = -0.0004;
  world.sun.shadow.normalBias = 0.05;
  const sunDir = world.sun.position.clone().normalize();
  const groundAt = (x: number, z: number): number => Math.max(TERRAIN.seaLevelM, terrainData.heightAt(x, z));

  const aircraft = new Aircraft(aircraftId);
  const spawn = (): void => {
    if (params.get('spawn') === 'air') aircraft.placeInFlight(0, 1500, 12_000, 0, 200);
    else {
      aircraft.placeOnGround(0, THRESHOLD_36_Z - 120, 0, RUNWAY.elevationM);
      pilot.input.throttle = 0;
    }
  };
  const model = buildJet(aircraftId);
  stage.scene.add(model.root);
  const arrows = new ForceArrows();
  stage.scene.add(arrows.mesh);

  const input = new Input(canvas);
  const pilot = new PilotControls(input);
  spawn();
  const rig = new CameraRig(stage.camera);
  const hudLayer = document.getElementById('hud') ?? ui;
  const hud = new Hud(hudLayer);
  const overlay = new DebugOverlay(ui);
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = 'Click to fly — mouse or W/S A/D stick · Q/E pedals and nose wheel · Shift/Ctrl throttle (again at 100 % = afterburner) · B brakes · G gear · L limiter · C camera · H data';
  ui.appendChild(banner);
  canvas.addEventListener('click', () => input.requestLock());
  input.onLockChange = (locked) => (banner.style.display = locked ? 'none' : 'block');

  console.log(formatEmChart(aircraftId, emChart(aircraftId, [0, 3000, 6000, 9000, 12_000], [100, 150, 200, 250, 300, 350, 400, 450, 500])));

  let crashTimerS = 0;
  const renderPos = new Vector3();
  const renderRot = new Quaternion();
  const prevRot = new Quaternion();
  const currRot = new Quaternion();
  const debugHooks = { aircraft, stage, frames: 0, input: pilot.input, pilot, rig, overlay, terrain };
  (window as unknown as { __contrail: typeof debugHooks }).__contrail = debugHooks;

  const loop = new FixedLoop({
    step: (dtS) => {
      pilot.update(dtS, rig.mode !== 'orbit');
      if (rig.mode === 'orbit') rig.orbit(pilot.delta.dx, pilot.delta.dy);
      if (input.pressed('camera')) rig.next();
      if (input.pressed('debug')) overlay.visible = !overlay.visible;
      if (input.pressed('toneMap')) stage.applySettings({ ...settings, toneMap: (settings.toneMap = settings.toneMap === 'aces' ? 'agx' : 'aces') });
      if (input.pressed('quality')) stage.applySettings({ ...settings, quality: (settings.quality = settings.quality === 'high' ? 'low' : 'high') });
      // G-LOC: the pilot is out and the controls go slack.
      const controls = aircraft.g.glocS > 0 ? { ...pilot.input, pitch: 0, roll: 0, yaw: 0 } : pilot.input;
      if (input.pressed('gear')) aircraft.toggleGear();
      aircraft.step(controls, dtS, groundAt);
      if (aircraft.crashed) {
        crashTimerS += dtS;
        if (crashTimerS > 2) {
          spawn();
          crashTimerS = 0;
        }
      }
      input.endStep();
    },
    render: (alpha, frameS) => {
      renderPos.set(
        aircraft.prevPosition.x + (aircraft.position.x - aircraft.prevPosition.x) * alpha,
        aircraft.prevPosition.y + (aircraft.position.y - aircraft.prevPosition.y) * alpha,
        aircraft.prevPosition.z + (aircraft.position.z - aircraft.prevPosition.z) * alpha,
      );
      const po = aircraft.prevOrientation;
      const co = aircraft.orientation;
      prevRot.set(po.x, po.y, po.z, po.w);
      currRot.set(co.x, co.y, co.z, co.w);
      renderRot.slerpQuaternions(prevRot, currRot, alpha);
      model.root.position.copy(renderPos);
      model.root.quaternion.copy(renderRot);
      model.root.visible = rig.mode !== 'cockpit';
      const authority = (m: number, a: number): number => (a > 0 ? m / a : 0);
      const qS = aircraft.dynamicPressurePa * aircraft.cfg.aero.wingAreaM2;
      poseSurfaces(model, authority(aircraft.controls.pitch, qS * aircraft.cfg.aero.chordM * aircraft.cfg.aero.cmControl + 1), authority(aircraft.controls.roll, qS * aircraft.cfg.aero.spanM * aircraft.cfg.aero.clControl + 1));
      model.burner.value = aircraft.engine.burner;
      poseGear(model, aircraft.gear.position, aircraft.gear.compression);
      world.sun.position.copy(renderPos).addScaledVector(sunDir, 800);
      world.sun.target.position.copy(renderPos);
      rig.update(renderPos, renderRot, model.eye, aircraft.loadFactor, AIRCRAFT[aircraftId].lengthM, frameS);
      stage.camera.updateMatrixWorld();
      hud.clipToCombiner = rig.mode === 'cockpit';
      const warnings: string[] = [];
      if (aircraft.g.glocS > 0) warnings.push('G-LOC');
      if (aircraft.overstressed) warnings.push('OVER G');
      if (aircraft.coeff.separation > 0.3 && aircraft.speedMs > 20) warnings.push('ALPHA');
      if (pilot.input.limiterRelaxed) warnings.push('LIM OFF');
      if (aircraft.fuelKg < 800) warnings.push('FUEL');
      if (aircraft.gear.position > 0 && aircraft.gear.position < 1) warnings.push('GEAR');
      if (pilot.input.brake) warnings.push('BRAKE');
      terrain.update(stage.camera);
      hud.draw(stage.camera, aircraft, pilot.input, { radarAltitudeM: Math.max(0, aircraft.position.y - aircraft.wheelDropM - groundAt(aircraft.position.x, aircraft.position.z)), weaponMode: aircraft.gear.position > 0.99 ? 'GEAR DN' : 'GUN', stores: aircraftId === 'wraith' ? 'GUN 180 SRM 2 MRM 4' : 'GUN 150 SRM 4 MRM 4', warnings });
      world.sky.position.copy(stage.camera.position);
      world.ground.position.set(Math.round(stage.camera.position.x / 1000) * 1000, 0, Math.round(stage.camera.position.z / 1000) * 1000);
      stage.greyOut.value = greyOut(aircraft.g);
      stage.redOut.value = aircraft.g.redOut;
      arrows.update(renderPos, aircraft.forces, aircraft.velocity, overlay.visible && rig.mode !== 'cockpit');
      overlay.update(aircraft, pilot.input, `${stage.backendName} · ${settings.quality} · ${settings.toneMap} · camera ${rig.mode} · terrain ${terrain.nodesDrawn} patches${aircraft.crashed ? ' · CRASHED' : ''}`);
      if (frameS > 0 && !document.hidden) stage.governor.update(frameS);
      stage.render();
      debugHooks.frames++;
    },
  }, PHYSICS.maxStepsPerFrame);
  loading.remove();
  loop.start();
}

main().catch((err: unknown) => {
  console.error(err);
  const ui = document.getElementById('ui');
  if (ui) ui.textContent = `Contrail failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
