import { PilotControls } from './app/pilot.ts';
import { HELICOPTERS, PHYSICS } from './config.ts';
import { Input } from './core/input.ts';
import { FixedLoop } from './core/loop.ts';
import { Atmosphere } from './render/atmosphere.ts';
import { CameraRig } from './render/cameraRig.ts';
import { CLOUD_QUALITY, Clouds } from './render/clouds.ts';
import { HeliCockpit } from './render/heliCockpit.ts';
import { HeliView } from './render/heliView.ts';
import { SkyLighting } from './render/lighting.ts';
import { Stage, type StageSettings } from './render/stage.ts';
import { TerrainRenderer } from './render/terrainMesh.ts';
import { TerrainShadow } from './render/terrainShadow.ts';
import { Forest } from './render/forest.ts';
import { buildTerrainTextures } from './render/terrainTextures.ts';
import { bakeCloudData } from './sim/cloudField.ts';
import { Helicopter } from './sim/helicopter.ts';
import { bakeTerrain, riverX, TERRAIN } from './sim/terrain.ts';
import { DebugOverlay } from './ui/debugOverlay.ts';
import { Hud } from './ui/hud.ts';
import { chooseOptions, optionsFromParams } from './ui/menu.ts';
import { graphicsSetup, loadControls } from './ui/settings.ts';
import { RotorSound } from './ui/sound.ts';
import { TiltSteering } from './ui/tilt.ts';
import { FlightTouchControls } from './ui/touch.ts';

// Ridgeline — an attack helicopter over 20 km of ridges and valleys. The start
// menu picks the mission, the helicopter and the sky; then the world loads:
// terrain, clouds, the forward base. Each fixed step reads the pilot's controls
// into the rotorcraft model; each frame draws the helicopter with its rotor
// blur, the helicopter HUD with its hover cue, and the flight-data page.

const params = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('index.html must contain canvas#view and div#ui');
  const input = new Input(canvas);
  const skipMenu = params.has('autostart') || params.has('spawn');
  const controls = loadControls(params, input.touch);
  const opts = skipMenu ? optionsFromParams(params) : await chooseOptions(ui, optionsFromParams(params), controls, input.touch);
  // Browsers allow audio only after a gesture: the menu's FLY click (or the first tap) is one.
  let audio: AudioContext | null = null;
  let sound: RotorSound | null = null;
  const startAudio = (): void => {
    if (!audio) {
      try {
        audio = new AudioContext();
        sound = new RotorSound(audio);
      } catch {
        audio = null;
      }
    } else void audio.resume();
  };
  if (!skipMenu) startAudio();

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Ridgeline — loading';
  ui.appendChild(loading);

  const settings: StageSettings = { ...graphicsSetup(controls.graphics, input.touch), renderScale: 1, toneMap: params.get('tm') === 'agx' ? 'agx' : 'aces' };
  const stage = new Stage(canvas, settings);
  await stage.init();
  window.addEventListener('resize', () => stage.resize());

  // Physical sky and light: the atmosphere's LUTs, the sun in lux, pre-exposure per preset.
  const atmosphere = new Atmosphere(settings.quality);
  stage.scene.add(atmosphere.dome);
  const lighting = new SkyLighting(stage.renderer, atmosphere, opts.time);
  stage.scene.add(lighting.sun, lighting.sun.target);
  if (!params.has('noap')) stage.setAerialPerspective((colour, uv, distanceM) => atmosphere.applyAerial(colour, uv, distanceM));
  stage.setExposure(1);
  const t0 = performance.now();
  const terrainData = await bakeTerrain((f) => (loading.textContent = `Ridgeline — raising the ridges ${Math.round(f * 100)} %`));
  loading.textContent = 'Ridgeline — painting the land';
  const terrainTextures = await buildTerrainTextures(terrainData);
  // The ridges' shadows and the valleys' sky occlusion, baked on the GPU for this sun (again when it moves).
  const terrainShadow = params.has('noterrainshadow') ? null : new TerrainShadow(terrainTextures, { sunM: 6000, skyM: 1200 });
  terrainShadow?.bake(stage.renderer, lighting.sunDir);
  const terrain = new TerrainRenderer(terrainData, terrainTextures, terrainShadow ? terrainShadow.target.texture : null);
  console.log(`terrain baked in ${(performance.now() - t0).toFixed(0)} ms`);
  stage.scene.add(terrain.mesh);
  // Forests of impostor trees, generated on the GPU from the land cover round the camera (forest.ts).
  if (!params.has('noforest')) {
    const high = settings.quality === 'high';
    const rings = high
      ? [
          { n: 256, spacingM: 7, innerM: 0, sizeK: 1 },
          { n: 192, spacingM: 22, innerM: 800, sizeK: 1.45 },
        ]
      : [
          { n: 176, spacingM: 8, innerM: 0, sizeK: 1.05 },
          { n: 128, spacingM: 26, innerM: 620, sizeK: 1.5 },
        ];
    // Bigger frames than the jet game's: the helicopter flies past the trees at tens of metres.
    const forest = new Forest(stage.renderer, terrainTextures, terrainShadow ? terrainShadow.target.texture : null, rings, high ? 320 : 192);
    for (const f of forest.meshes) stage.scene.add(f);
  }
  loading.textContent = 'Ridgeline — growing the clouds';
  const clouds = new Clouds(await bakeCloudData(), atmosphere, CLOUD_QUALITY[settings.quality]);
  const applyPresetClouds = (): void => {
    const p = lighting.preset;
    const cov = params.get('clouds');
    clouds.setLayer({ baseM: p.cloudBaseM, topM: p.cloudTopM, coverage: cov === null ? p.coverage : Number(cov) });
  };
  applyPresetClouds();
  if (!params.has('noclouds')) stage.setClouds(clouds);
  const groundAt = (x: number, z: number): number => Math.max(TERRAIN.seaLevelM, terrainData.heightAt(x, z));

  // ---- the helicopter
  loading.textContent = 'Ridgeline — rolling out the helicopter';
  const cfg = HELICOPTERS[opts.heli];
  const heli = new Helicopter(cfg);
  const view = new HeliView(opts.heli, stage.scene);
  // The pilot's station inside the model (seen from the rear seat), with its live displays.
  const cockpit = new HeliCockpit(cfg, { sizeM: TERRAIN.nearSizeM, heightAt: groundAt, riverX, base: { x: 300, z: 0 } });
  view.model.root.add(cockpit.root);
  if (!params.has('nocloudshadow')) clouds.shadeReceivers(stage.scene, settings.quality === 'high' ? 4 : 2);
  const pilot = new PilotControls(input);
  pilot.invertPitch = controls.invertPitch;
  const spawn = (): void => {
    // On the forward base pad, facing north up the valley; or in a hover above it.
    const x = 300;
    const z = 0;
    if (opts.airStartM !== null) {
      heli.placeInFlight(x, groundAt(x, z) + opts.airStartM, z, 0, 0);
      pilot.resetTrim(0.55);
    } else {
      heli.placeOnGround(x, z, 0, groundAt(x, z));
      pilot.resetTrim(0);
    }
  };
  spawn();

  // ---- controls and displays
  const tilt = controls.tilt ? new TiltSteering() : null;
  const rig = new CameraRig(stage.camera);
  const hudLayer = document.getElementById('hud') ?? ui;
  const hud = new Hud(hudLayer);
  hud.touchLayout = input.touch;
  const overlay = new DebugOverlay(ui);
  overlay.visible = params.has('debug');
  const status = document.createElement('div');
  status.className = 'status';
  ui.appendChild(status);
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = input.touch ? 'Tap to fly' : 'Click to fly — Esc frees the mouse';
  ui.appendChild(banner);
  const startFlying = (): void => {
    tilt?.calibrate();
    startAudio();
    input.requestLock();
  };
  canvas.addEventListener('click', startFlying);
  banner.addEventListener('click', startFlying);
  input.onLockChange = (locked) => (banner.style.display = locked ? 'none' : 'block');
  let touch: FlightTouchControls | null = null;
  if (input.touch) {
    touch = new FlightTouchControls(
      input,
      [
        { code: 'KeyQ', label: '◀', col: 1, row: 0, mode: 'hold' },
        { code: 'KeyE', label: '▶', col: 0, row: 0, mode: 'hold' },
        { code: 'KeyT', label: 'TRIM', col: 0, row: 1.2, mode: 'tap', big: false },
        { code: 'KeyZ', label: 'SAS', col: 1, row: 1.2, mode: 'tap' },
        { code: 'KeyC', label: 'CAM', col: 0, row: 2.2, mode: 'tap' },
        { code: 'KeyI', label: 'ENG', col: 1, row: 2.2, mode: 'tap' },
        ...(tilt ? [{ code: '', label: 'CAL', col: 2, row: 2.2, mode: 'tap' as const, action: (): void => tilt.calibrate() }] : []),
      ],
      { label: 'COLL', reheat: false },
    );
    touch.setThrottle(pilot.input.collective);
    touch.onTouch = (): void => {
      if (!input.locked) startFlying();
    };
  }

  let muted = params.has('mute');
  let message = '';
  let messageUntilS = 0;
  const say = (text: string, s: number): void => {
    message = text;
    messageUntilS = clockS + s;
  };
  let clockS = 0;
  let crashedAtS = -1;
  const debugHooks = { heli, stage, frames: 0, input: pilot.input, pilot, tilt, rig, overlay, terrain, atmosphere, clouds, view };
  (window as unknown as { __ridgeline: typeof debugHooks }).__ridgeline = debugHooks;

  const loop = new FixedLoop(
    {
      step: (dtS) => {
        pilot.update(dtS, rig.mode !== 'orbit');
        if (touch) pilot.setTouch(touch.stick, touch.throttle);
        pilot.setTilt(tilt ? tilt.stick : null);
        if (rig.mode === 'orbit') rig.orbit(pilot.delta.dx, pilot.delta.dy);
        if (input.pressed('camera')) rig.next();
        if (input.pressed('debug')) overlay.visible = !overlay.visible;
        if (input.pressed('mute')) muted = !muted;
        if (input.pressed('toneMap')) stage.applySettings({ ...settings, toneMap: (settings.toneMap = settings.toneMap === 'aces' ? 'agx' : 'aces') });
        if (input.pressed('timeOfDay')) {
          lighting.setPreset(lighting.preset.id === 'morning' ? 'noon' : lighting.preset.id === 'noon' ? 'dusk' : 'morning');
          terrainShadow?.bake(stage.renderer, lighting.sunDir);
          applyPresetClouds();
        }
        if (input.pressed('quality')) {
          settings.quality = settings.quality === 'high' ? 'low' : 'high';
          clouds.quality = CLOUD_QUALITY[settings.quality];
          stage.applySettings({ ...settings });
        }
        if (input.pressed('sas')) say(pilot.input.sas ? 'SAS ON' : 'SAS OFF', 2);
        if (input.pressed('engines')) say(pilot.input.engines ? 'ENGINES ON' : 'ENGINES CUT — AUTOROTATE', 3);
        heli.step(pilot.input, groundAt, dtS);
        if (heli.crashed && crashedAtS < 0) {
          crashedAtS = clockS;
          say(heli.touchdownSinkMs > 6 ? 'CRASHED — TOO HARD' : 'CRASHED', 4);
        }
        if (crashedAtS >= 0 && clockS - crashedAtS > 4) {
          crashedAtS = -1;
          spawn();
          touch?.setThrottle(pilot.input.collective);
        }
        input.endStep();
      },
      render: (alpha, frameS) => {
        clockS += frameS;
        const high = settings.quality === 'high';
        const inside = rig.mode === 'cockpit' || rig.mode === 'gunner';
        view.setSeat(rig.mode === 'cockpit' ? 'pilot' : rig.mode === 'gunner' ? 'gunner' : null);
        view.update(heli, alpha, frameS, true);
        cockpit.update(heli, frameS, inside);
        rig.update(view.renderPos, view.renderRot, { pilot: cfg.pilotEye, gunner: cfg.gunnerEye }, heli.vibration, cfg.lengthM, frameS, groundAt);
        stage.camera.updateMatrixWorld();
        terrain.update(stage.camera);
        if (clockS > messageUntilS) message = '';
        hud.draw(stage.camera, heli, pilot.input, { sensor: 'NAV', weapon: 'NO WEAPONS', message }, frameS);
        if (sound) {
          const s = sound as RotorSound;
          s.muted = muted;
          const weight = heli.massKg * PHYSICS.gravityMs2;
          // Blade slap: descending slowly into the own wake, the ring, the stall, and hard manoeuvres.
          const descentSlap = Math.max(0, Math.min(1, -heli.verticalSpeedMs / 6)) * (1 - Math.min(1, heli.airspeedMs / 40));
          s.update({
            omegaRadS: heli.rotor.omegaRadS,
            blades: cfg.rotor.blades,
            rpmFraction: heli.rpmPct / 100,
            load: heli.rotor.thrustN / weight,
            slap: Math.min(1, Math.max(descentSlap, heli.rotor.vortexRing, heli.rotor.bladeStall, Math.max(0, heli.rotor.thrustN / weight - 1.3))),
            power: heli.engine.powerW / (cfg.engines * cfg.enginePowerW),
            enginesRunning: heli.engine.running,
            airspeedMs: heli.airspeedMs,
            cockpit: inside,
            lowRotor: heli.rpmPct < 92 && !heli.onGround && !heli.crashed,
          });
        }
        status.textContent = `FREE FLIGHT · ${cfg.name} · ${heli.regime}`;
        const camY = stage.camera.position.y;
        lighting.setCloudCover(clouds.layer.coverage, camY < clouds.layer.baseM ? 'below' : camY > clouds.layer.topM ? 'above' : 'inside');
        lighting.update(stage.camera, view.renderPos);
        clouds.update(frameS, stage.camera.position, high);
        stage.scene.environment = lighting.environment;
        overlay.update(heli, pilot.input, `${stage.backendName} · ${settings.quality} · ${lighting.preset.label} · camera ${rig.mode} · terrain ${terrain.nodesDrawn} patches · ${stage.governorLabel}`);
        if (frameS > 0 && !document.hidden) stage.governor.update(frameS);
        stage.render();
        debugHooks.frames++;
      },
    },
    PHYSICS.maxStepsPerFrame,
  );
  stage.camera.position.set(heli.position.x, heli.position.y + 30, heli.position.z + 30);
  stage.camera.updateMatrixWorld();
  lighting.update(stage.camera, stage.camera.position);
  await lighting.prepare(stage.camera);
  lighting.update(stage.camera, stage.camera.position);
  loading.remove();
  loop.start();
}

main().catch((err: unknown) => {
  console.error(err);
  const ui = document.getElementById('ui');
  if (ui) ui.textContent = `Ridgeline failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
