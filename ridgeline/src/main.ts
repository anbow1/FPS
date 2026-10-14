import { Quaternion, Vector3 } from 'three/webgpu';
import { PilotControls } from './app/pilot.ts';
import { HELICOPTERS, PHYSICS, WEAPONS } from './config.ts';
import { Input } from './core/input.ts';
import { FixedLoop } from './core/loop.ts';
import { Atmosphere } from './render/atmosphere.ts';
import { CameraRig } from './render/cameraRig.ts';
import { CLOUD_QUALITY, Clouds } from './render/clouds.ts';
import { CombatView, EMISSIVE_EXPOSURE } from './render/combatView.ts';
import { HeliCockpit } from './render/heliCockpit.ts';
import { HeliView } from './render/heliView.ts';
import { updateContact } from './render/contactShadow.ts';
import { SkyLighting } from './render/lighting.ts';
import { Rain } from './render/rain.ts';
import { canopyFlow, canopyFlowSpeed, canopyRain, canopyTime } from './render/canopyRain.ts';
import { Stage, type StageSettings } from './render/stage.ts';
import { TerrainRenderer } from './render/terrainMesh.ts';
import { TerrainShadow } from './render/terrainShadow.ts';
import { TargetView } from './render/targetView.ts';
import { Forest } from './render/forest.ts';
import { buildGrass } from './render/groundGrass.ts';
import { makeGroundLayers } from './render/groundTextures.ts';
import { buildTerrainTextures } from './render/terrainTextures.ts';
import { bakeCloudData } from './sim/cloudField.ts';
import { Helicopter } from './sim/helicopter.ts';
import { GroundForce, type GroundTarget } from './sim/targets.ts';
import { Armament, clearLine } from './sim/weapons.ts';
import { Vec3 } from './core/vec.ts';
import { bakeTerrain, riverX, sourceCover, TERRAIN } from './sim/terrain.ts';
import { DebugOverlay } from './ui/debugOverlay.ts';
import { Hud, type HudAim } from './ui/hud.ts';
import { chooseOptions, optionsFromParams } from './ui/menu.ts';
import { graphicsSetup, loadControls, saveControls } from './ui/settings.ts';
import { RotorSound } from './ui/sound.ts';
import { TiltSteering } from './ui/tilt.ts';
import { FlightTouchControls } from './ui/touch.ts';

// Ridgeline — an attack helicopter over 20 km of ridges and valleys. The start
// menu picks the mission, the helicopter and the sky; then the world loads:
// terrain, clouds, the forward base. Each fixed step reads the pilot's controls
// into the rotorcraft model and flies the weapons and the ground force; each
// frame draws the helicopter with its rotor blur, the vehicles and the
// weapons' effects, the helicopter HUD with its hover cue and reticles, and
// the flight-data page.

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
  // What the ground shows from a few metres: grass, soil, rock and litter layers (groundTextures.ts).
  const groundLayers = params.has('nogroundtex') ? null : await makeGroundLayers(settings.quality === 'high' ? 512 : 256);
  // The ridges' shadows and the valleys' sky occlusion, baked on the GPU for this sun (again when it moves).
  const terrainShadow = params.has('noterrainshadow') ? null : new TerrainShadow(terrainTextures, { sunM: 6000, skyM: 1200 });
  terrainShadow?.bake(stage.renderer, lighting.sunDir);
  const terrain = new TerrainRenderer(terrainData, terrainTextures, terrainShadow ? terrainShadow.target.texture : null, groundLayers, settings.quality === 'high');
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
  // Grass blades round the camera near the ground, flattened by the rotor's downwash (groundGrass.ts).
  const grass = params.has('nograss') ? null : buildGrass(stage.renderer, terrainTextures, terrainShadow ? terrainShadow.target.texture : null, settings.quality === 'high');
  if (grass) stage.scene.add(grass.field.group);
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
  // Rain below the cloud base (the 'rain' sky), and the water it leaves on the canopy.
  const rain = new Rain(settings.quality === 'high' ? 'high' : 'low');
  stage.scene.add(rain.mesh);
  const rainVel = new Vector3();
  const noWind = new Vector3();
  const bodyInv = new Quaternion();
  const flowLocal = new Vector3();
  const downLocal = new Vector3();
  pilot.invertPitch = controls.invertPitch;

  // ---- weapons and the ground force up the valley
  const arm = new Armament(view.model.hardpoints);
  const coverTmp = { forest: 0, rock: 0, snow: 0, water: 0, river: 0 };
  const forestAt = (x: number, z: number): number => {
    const h = terrainData.heightAt(x, z);
    const grad = Math.hypot(terrainData.heightAt(x + 10, z) - terrainData.heightAt(x - 10, z), terrainData.heightAt(x, z + 10) - terrainData.heightAt(x, z - 10)) / 20;
    // The cover bake's "slope" is 1 − the normal's y.
    return sourceCover(x, z, h, 1 - 1 / Math.hypot(1, grad), coverTmp).forest;
  };
  const force = new GroundForce({ groundAt, riverX, forestAt });
  const combatView = new CombatView(stage.scene, atmosphere);
  const targetView = new TargetView(stage.scene);
  // The stores' weight goes as they are fired (the loaded mass in the config is the full load).
  const syncStores = (): void => {
    heli.storesKg = Math.max(0, cfg.storesKg - (Armament.fullStoresKg() - arm.storesKg));
  };
  const spawn = (): void => {
    arm.rearm();
    syncStores();
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
  // Tilt steering on phones: always listening, used while switched on (the menu or the TILT button).
  const tilt = input.touch ? new TiltSteering() : null;
  if (tilt) tilt.enabled = controls.tilt;
  const setTilt = (on: boolean): void => {
    if (!tilt) return;
    void tilt.setEnabled(on).then((ok) => {
      controls.tilt = ok;
      saveControls(controls);
      say(ok ? 'TILT STEERING — CAL to set hands-off' : on ? 'NO MOTION SENSOR' : 'TILT OFF', 2.5);
    });
  };
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
    // iOS grants the motion sensor only from a tap: ask on the first one if tilt is on.
    if (tilt?.enabled) void tilt.setEnabled(true);
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
        { code: 'Space', label: 'FIRE', col: 2.05, row: 0, mode: 'hold', big: true },
        { code: 'KeyT', label: 'TRIM', col: 0, row: 1.2, mode: 'tap', big: false },
        { code: 'KeyZ', label: 'SAS', col: 1, row: 1.2, mode: 'tap' },
        { code: '', label: 'WPN', col: 2.3, row: 1.55, mode: 'tap', id: 'wpn', action: (): void => cycleTouchWeapon() },
        { code: 'KeyL', label: 'LSR', col: 3.3, row: 1.55, mode: 'tap', id: 'laser' },
        { code: 'KeyC', label: 'CAM', col: 0, row: 2.2, mode: 'tap' },
        { code: 'KeyI', label: 'ENG', col: 1, row: 2.2, mode: 'tap' },
        ...(tilt
          ? [
              { code: '', label: 'TILT', col: 2.3, row: 2.55, mode: 'tap' as const, id: 'tilt', action: (): void => setTilt(!tilt.enabled) },
              { code: '', label: 'CAL', col: 3.3, row: 2.55, mode: 'tap' as const, action: (): void => tilt.calibrate() },
            ]
          : []),
      ],
      { label: 'PWR', reheat: false, detent: true },
    );
    touch.setThrottle(pilot.input.collective);
    touch.onTouch = (): void => {
      if (!input.locked) startFlying();
    };
  }

  // Touch has one weapon button: it steps gun → rockets ×1 → ×4 → ×8 → missiles → gun.
  const cycleTouchWeapon = (): void => {
    if (arm.selected === 'rockets' && arm.ripple < 8) arm.cycleRipple();
    else {
      arm.cycleWeapon();
      if (arm.selected === 'rockets') while (arm.ripple !== 1) arm.cycleRipple();
    }
  };

  // ---- the crew's sight line: from the camera through the centre of the view, to the ground it rests on
  const sightEye = new Vec3();
  const sightLook = new Vec3();
  const sightPoint = new Vec3();
  const camDir = new Vector3();
  // The gun cursor: a point on the screen (−1…1 each way) the mouse or the right thumb moves; the camera stays
  // with the aircraft, and the sight line runs from the camera through the cursor.
  const cursor = { x: 0, y: 0 };
  const moveCursor = (dxPx: number, dyPx: number): void => {
    const k = input.touch ? 1.3 : 1;
    cursor.x = Math.max(-0.92, Math.min(0.92, cursor.x + ((dxPx * 2) / window.innerWidth) * k));
    cursor.y = Math.max(-0.85, Math.min(0.85, cursor.y - ((dyPx * 2) / window.innerHeight) * k));
  };
  const sight = (): void => {
    const cam = stage.camera;
    camDir.set(cursor.x, cursor.y, 0.5).unproject(cam).sub(cam.position).normalize();
    sightEye.set(cam.position.x, cam.position.y, cam.position.z);
    sightLook.set(camDir.x, camDir.y, camDir.z);
    // March out to 8 km in growing steps, then halve back onto the surface.
    let prev = 0;
    let d = 5;
    let hit = -1;
    while (d < 8000) {
      const y = sightEye.y + sightLook.y * d;
      if (y < groundAt(sightEye.x + sightLook.x * d, sightEye.z + sightLook.z * d)) {
        hit = d;
        break;
      }
      prev = d;
      d += Math.max(4, d * 0.03);
    }
    if (hit < 0) {
      sightPoint.copy(sightEye).addScaled(sightLook, 2500);
      return;
    }
    let lo = prev;
    let hi = hit;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (sightEye.y + sightLook.y * mid < groundAt(sightEye.x + sightLook.x * mid, sightEye.z + sightLook.z * mid)) hi = mid;
      else lo = mid;
    }
    sightPoint.copy(sightEye).addScaled(sightLook, hi);
  };
  // Targets the sensor sees (in range, clear line of sight from the helicopter), refreshed a few times a second.
  let seen: GroundTarget[] = [];
  let seenAtS = -1;
  const centre = new Vec3();
  const from = new Vec3();
  const refreshSeen = (): void => {
    from.set(heli.position.x, heli.position.y + 1, heli.position.z);
    seen = force.targets.filter((t) => t.alive && t.position.distanceTo(heli.position) < 6000 && clearLine(from, GroundForce.centre(t, centre), groundAt));
    cockpit.contacts = seen.map((t) => ({ x: t.position.x, z: t.position.z }));
  };
  let lastRoundS = -1;
  const KILL_NAMES = { tank: 'TANK', apc: 'APC', truck: 'TRUCK' } as const;

  let muted = params.has('mute');
  let message = '';
  let messageUntilS = 0;
  const say = (text: string, s: number): void => {
    message = text;
    messageUntilS = clockS + s;
  };
  let clockS = 0;
  let crashedAtS = -1;
  const debugHooks = { heli, stage, frames: 0, input: pilot.input, pilot, tilt, rig, overlay, terrain, atmosphere, clouds, view, arm, force, keys: input };
  (window as unknown as { __ridgeline: typeof debugHooks }).__ridgeline = debugHooks;

  const loop = new FixedLoop(
    {
      step: (dtS) => {
        // The mouse (or the right thumb's drag) looks and aims the gun and the laser; it never flies.
        pilot.update(dtS, heli.airspeedMs);
        if (touch) {
          // With SAS the lever springs back to its middle — hold the height — when the thumb lets go.
          if (pilot.input.sas && !touch.leverHeld && touch.throttle !== 0.5) touch.setThrottle(0.5);
          pilot.setTouch(touch.stick, touch.throttle);
        }
        pilot.setTilt(tilt?.enabled ? tilt.stick : null);
        if (rig.mode === 'orbit') rig.orbit(pilot.delta.dx, pilot.delta.dy);
        else moveCursor(pilot.delta.dx, pilot.delta.dy);
        if (input.pressed('centreView')) cursor.x = cursor.y = 0;
        if (input.pressed('laser')) {
          arm.laser = !arm.laser;
          say(arm.laser ? 'LASER ON' : 'LASER OFF', 1.5);
        }
        if (input.pressed('camera')) rig.next();
        if (input.pressed('debug')) overlay.visible = !overlay.visible;
        if (input.pressed('mute')) muted = !muted;
        if (input.pressed('toneMap')) stage.applySettings({ ...settings, toneMap: (settings.toneMap = settings.toneMap === 'aces' ? 'agx' : 'aces') });
        if (input.pressed('timeOfDay')) {
          lighting.setPreset(lighting.preset.id === 'morning' ? 'noon' : lighting.preset.id === 'noon' ? 'dusk' : lighting.preset.id === 'dusk' ? 'rain' : 'morning');
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

        // ---- weapons
        if (input.pressed('weapon')) arm.cycleWeapon();
        if (input.pressed('ripple')) arm.cycleRipple();
        sight();
        arm.step(dtS, heli, input.locked && input.held('fire'), sightEye, sightLook, sightPoint, force, groundAt);
        force.step(dtS);
        syncStores();
        const ev = arm.events;
        if (ev.rounds > 0) lastRoundS = clockS;
        const ear = stage.camera.position;
        for (const p of ev.launches) sound?.launch(Math.hypot(p.x - ear.x, p.y - ear.y, p.z - ear.z), arm.selected === 'missile');
        for (const b of ev.blasts) sound?.explosion(Math.hypot(b.position.x - ear.x, b.position.y - ear.y, b.position.z - ear.z), b.kind === 'dust' ? 0.15 : b.size);
        for (const k of ev.kills) say(`${KILL_NAMES[k.kind]} DESTROYED — ${force.alive} LEFT`, 2.5);
        if (force.cleared(12)) {
          force.deploy();
          say('NEW TARGETS UP THE VALLEY', 4);
        }
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
        updateContact(view.renderPos, view.renderRot, groundAt(view.renderPos.x, view.renderPos.z));
        // The cannon follows its turret; fired missiles leave the rails.
        view.model.gunYaw.rotation.y = -arm.gunAzRad;
        view.model.gunPitch.rotation.x = arm.gunElRad;
        view.model.missileRounds.forEach((m, i) => (m.visible = i >= arm.missilesFired));
        cockpit.update(heli, frameS, inside);
        rig.update(view.renderPos, view.renderRot, { pilot: cfg.pilotEye, gunner: cfg.gunnerEye }, heli.vibration, cfg.lengthM, frameS, groundAt);
        stage.camera.updateMatrixWorld();
        terrain.update(stage.camera);
        if (grass) {
          const cam = stage.camera.position;
          // Downwash: the column reaches the ground below about two and a half diameters, strongest
          // close in and under load; at flat pitch on the pad it still stirs the grass.
          const D = 2 * cfg.rotor.radiusM;
          const h = heli.radarAltitudeM;
          const load = Math.min(1.2, heli.rotor.thrustN / (heli.massKg * PHYSICS.gravityMs2));
          const reach = Math.max(0, 1 - h / (2.5 * D));
          const strength = Math.min(1, (0.3 + 0.7 * load) * (heli.rpmPct / 100) ** 2 * reach * reach);
          const under = groundAt(cam.x, cam.z);
          grass.update(cam, cam.y - under, under, frameS, clockS, stage.camera.fov, canvas.height, {
            x: view.renderPos.x,
            z: view.renderPos.z,
            radiusM: cfg.rotor.radiusM * (1.7 + h / D),
            strength,
          });
        }
        if (clockS > messageUntilS) message = '';
        if (clockS - seenAtS > 0.3) {
          seenAtS = clockS;
          refreshSeen();
        }
        const lockAt = arm.lock ? GroundForce.centre(arm.lock, new Vec3()) : null;
        const cue = arm.selected === 'rockets' ? arm.rocketImpact(heli, groundAt, new Vec3()) : null;
        const aim: HudAim = {
          weapon: arm.selected,
          gunPoint: new Vector3(sightPoint.x, sightPoint.y, sightPoint.z),
          rocketCue: cue ? new Vector3(cue.x, cue.y, cue.z) : null,
          lock: lockAt ? new Vector3(lockAt.x, lockAt.y, lockAt.z) : null,
          cursor,
          targets: seen.filter((t) => t.alive).map((t) => new Vector3(t.position.x, t.position.y + 1.4, t.position.z)),
          laser: arm.laser,
          laserRangeM: arm.laserRangeM,
          designated: arm.designated ? new Vector3(arm.designated.position.x, arm.designated.position.y + 1.4, arm.designated.position.z) : null,
          warning: arm.selected === 'gun' && arm.overheated ? 'GUN HOT' : (arm.selected === 'gun' && arm.rounds === 0) || (arm.selected === 'rockets' && arm.rockets === 0) || (arm.selected === 'missile' && arm.missiles === 0) ? 'EMPTY' : '',
        };
        const weaponText = arm.selected === 'gun' ? `GUN ${arm.rounds}` : arm.selected === 'rockets' ? `RKT ${arm.rockets} ×${arm.ripple}` : `MSL ${arm.missiles}${arm.lock ? ' LOCK' : ''}`;
        hud.draw(stage.camera, heli, pilot.input, { sensor: `TGT ${seen.length} IN VIEW · ${force.alive} LEFT`, weapon: weaponText, message, aim }, frameS);
        touch?.setLit('tilt', tilt?.enabled ?? false);
        touch?.setLit('laser', arm.laser);
        touch?.setLit('wpn', false, arm.selected === 'gun' ? 'GUN' : arm.selected === 'rockets' ? `RKT${arm.ripple}` : 'MSL');
        EMISSIVE_EXPOSURE.value = lighting.exposure;
        targetView.update(force, groundAt);
        combatView.update(arm, force, clockS, stage.camera.position);
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
          s.gun(clockS - lastRoundS < 0.15, WEAPONS.gun.roundsPerS);
        }
        status.textContent = `FREE FLIGHT · ${cfg.name} · ${heli.regime}`;
        const camY = stage.camera.position.y;
        lighting.setCloudCover(clouds.layer.coverage, camY < clouds.layer.baseM ? 'below' : camY > clouds.layer.topM ? 'above' : 'inside');
        lighting.update(stage.camera, view.renderPos);
        clouds.update(frameS, stage.camera.position, high);
        stage.scene.environment = lighting.environment;
        {
          const wet = (lighting.preset.rain ?? 0) * (camY < clouds.layer.baseM ? 1 : 0);
          rain.rate.value = wet;
          // Under a full deck the drops are lit by the cloud base: ~6000 lux of diffuse sky.
          const sky = (6000 / Math.PI) * lighting.exposure;
          rain.light.value.set(sky * 0.92, sky * 0.96, sky);
          rainVel.set(heli.velocity.x, heli.velocity.y, heli.velocity.z);
          rain.update(clockS, stage.camera.position, rainVel, noWind);
          // On the glass: the air runs aft at the airspeed and gravity pulls down, both in the body frame.
          bodyInv.copy(view.renderRot).invert();
          flowLocal.copy(rainVel).applyQuaternion(bodyInv).multiplyScalar(-0.05);
          downLocal.set(0, -1, 0).applyQuaternion(bodyInv);
          canopyFlow.value.copy(flowLocal.addScaledVector(downLocal, 0.4)).normalize();
          canopyFlowSpeed.value = Math.min(1.6, 0.06 + heli.airspeedMs * 0.02);
          canopyRain.value = wet;
          canopyTime.value = clockS;
        }
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
