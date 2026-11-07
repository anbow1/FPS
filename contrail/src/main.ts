import { loadJetModels } from './render/importedJet.ts';
import { DoubleSide, Mesh, type Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { compileForPass, revealOnePerPipeline } from './render/warmup.ts';
import { Game } from './app/game.ts';
import { PilotControls } from './app/pilot.ts';
import { AIRCRAFT, PHYSICS } from './config.ts';
import { DEFAULT_BINDINGS, Input } from './core/input.ts';
import { FixedLoop } from './core/loop.ts';
import { Rng } from './core/rng.ts';
import { Vec3 } from './core/vec.ts';
import { buildAirbase } from './render/airbase.ts';
import { Atmosphere, SUN_RADIUS_RAD } from './render/atmosphere.ts';
import { CameraRig } from './render/cameraRig.ts';
import { CLOUD_QUALITY, Clouds } from './render/clouds.ts';
import { CombatView } from './render/combatView.ts';
import { ForceArrows } from './render/forceArrows.ts';
import { EMISSIVE_EXPOSURE } from './render/jetModels.ts';
import { JetView } from './render/jetView.ts';
import { SkyLighting } from './render/lighting.ts';
import { addCanopyRain, canopyFlow, canopyFlowSpeed, canopyRain, canopyTime } from './render/canopyRain.ts';
import { canopyScratchMesh, scratchSun, scratchSunDir } from './render/canopyScratches.ts';
import { flareAspect, flareDiscLum, flareDiscRadius, flareOnScreen, flareSun, flareSunUv } from './render/lensFlare.ts';
import { canopyMaterial } from './render/jetMaterials.ts';
import { Stage, type StageSettings } from './render/stage.ts';
import { TerrainRenderer } from './render/terrainMesh.ts';
import { TerrainShadow } from './render/terrainShadow.ts';
import { Forest } from './render/forest.ts';
import { buildTerrainTextures } from './render/terrainTextures.ts';
import { bakeCloudData, lineTransmittance } from './sim/cloudField.ts';
import { type Combatant, createOrders, type WeaponMode } from './sim/combat.ts';
import { emChart, formatEmChart } from './sim/em.ts';
import { greyOut } from './sim/gTolerance.ts';
import { bakeTerrain, TERRAIN } from './sim/terrain.ts';
import { GUN, gunDirection, gunImpact, MISSILES, predictShot } from './sim/weapons.ts';
import { DebugOverlay } from './ui/debugOverlay.ts';
import { type AttackCue, Hud } from './ui/hud.ts';
import { chooseOptions, optionsFromParams } from './ui/menu.ts';
import { SensorDisplays } from './ui/sensors.ts';
import { Cockpit } from './render/cockpit.ts';
import { loadHandMesh } from './render/handMesh.ts';
import { FlightSound } from './ui/sound.ts';
import { Tones } from './ui/tones.ts';
import { graphicsSetup, loadControls } from './ui/settings.ts';
import { TiltSteering } from './ui/tilt.ts';
import { FlightTouchControls } from './ui/touch.ts';
import { menuUrl, PauseMenu } from './ui/pause.ts';

// Contrail — a stealth fighter against a heavy twin in a physical sky. The
// start menu picks the mode, the aircraft on each side, the AI's difficulty
// and the sky; then the world loads: terrain, clouds, airbase, both jets.
// Each fixed step reads the pilot's controls into the same `Orders` the AI
// gives, steps the combat simulation (flight models, radars, warning
// receivers, weapons) and the mode's rules; each frame draws the jets, the
// missiles and smoke, the HUD with its attack symbology, and the radar and
// threat-warning displays.

const params = new URLSearchParams(location.search);

async function main(): Promise<void> {
  const tLoad = performance.now();
  const canvas = document.getElementById('view');
  const ui = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !ui) throw new Error('index.html must contain canvas#view and div#ui');
  const input = new Input(canvas);
  const skipMenu = params.has('autostart') || params.has('spawn');
  const controls = loadControls(params, input.touch);
  const opts = skipMenu ? optionsFromParams(params) : await chooseOptions(ui, optionsFromParams(params), controls, input.touch);
  const tones = new Tones();
  // Browsers allow audio only after a gesture: the menu's FLY click is one (headless runs skip it).
  if (!skipMenu) tones.start();

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Contrail — loading';
  ui.appendChild(loading);

  const settings: StageSettings = { ...graphicsSetup(controls.graphics, input.touch), renderScale: 1, toneMap: params.get('tm') === 'agx' ? 'agx' : 'aces' };
  const stage = new Stage(canvas, settings);
  await stage.init();
  window.addEventListener('resize', () => stage.resize());

  // Physical sky and light (rules §4.1–4.2): the atmosphere's LUTs, the sun in lux, pre-exposure per preset.
  const atmosphere = new Atmosphere(settings.quality);
  stage.scene.add(atmosphere.dome);
  const lighting = new SkyLighting(stage.renderer, atmosphere, opts.time);
  stage.scene.add(lighting.sun, lighting.sun.target);
  // ?noap turns the aerial perspective off for an A/B comparison.
  if (!params.has('noap')) stage.setAerialPerspective((colour, uv, distanceM) => atmosphere.applyAerial(colour, uv, distanceM));
  stage.setExposure(1);
  const t0 = performance.now();
  const terrainData = await bakeTerrain((f) => (loading.textContent = `Contrail — shaping 819 km of terrain ${Math.round(f * 100)} %`));
  loading.textContent = 'Contrail — painting the land';
  const terrainTextures = await buildTerrainTextures(terrainData);
  // The ridges' shadows and the valleys' sky occlusion, baked on the GPU for this sun (again when it moves).
  const terrainShadow = params.has('noterrainshadow') ? null : new TerrainShadow(terrainTextures);
  terrainShadow?.bake(stage.renderer, lighting.sunDir);
  const terrain = new TerrainRenderer(terrainData, terrainTextures, terrainShadow ? terrainShadow.target.texture : null);
  console.log(`terrain baked in ${(performance.now() - t0).toFixed(0)} ms`);
  stage.scene.add(terrain.mesh);
  // Forests of impostor trees, generated on the GPU from the land cover round the camera (forest.ts).
  if (!params.has('noforest')) {
    const high = settings.quality === 'high';
    const rings = high
      ? [
          { n: 256, spacingM: 11, innerM: 0, sizeK: 1.3 },
          { n: 192, spacingM: 34, innerM: 1250, sizeK: 1.9 },
        ]
      : [
          { n: 160, spacingM: 13, innerM: 0, sizeK: 1.35 },
          { n: 128, spacingM: 40, innerM: 900, sizeK: 2 },
        ];
    const forest = new Forest(stage.renderer, terrainTextures, terrainShadow ? terrainShadow.target.texture : null, rings, high ? 192 : 128);
    for (const m of forest.meshes) stage.scene.add(m);
  }
  loading.textContent = 'Contrail — growing the clouds';
  const t1 = performance.now();
  const clouds = new Clouds(await bakeCloudData(), atmosphere, CLOUD_QUALITY[settings.quality]);
  console.log(`clouds baked in ${(performance.now() - t1).toFixed(0)} ms`);
  const applyPresetClouds = (): void => {
    const p = lighting.preset;
    // ?clouds=0…1 overrides the preset's coverage (screenshots, A/B).
    const cov = params.get('clouds');
    clouds.setLayer({ baseM: p.cloudBaseM, topM: p.cloudTopM, coverage: cov === null ? p.coverage : Number(cov) });
  };
  applyPresetClouds();
  if (!params.has('noclouds')) stage.setClouds(clouds);
  stage.scene.add(buildAirbase());
  const groundAt = (x: number, z: number): number => Math.max(TERRAIN.seaLevelM, terrainData.heightAt(x, z));

  // ---- the game and its pictures
  loading.textContent = 'Contrail — rolling out the aircraft';
  const rng = new Rng(Number(params.get('seed') ?? Date.now() % 1_000_000));
  const game = new Game(opts, () => rng.next());
  const player = game.player;
  const aircraft = player.aircraft;
  const views = new Map<number, JetView>();
  // The downloaded models first: building the views picks them up (importedJet.ts).
  await loadJetModels();
  for (const f of game.combat.fighters) views.set(f.id, new JetView(f.kind, stage.scene, atmosphere));
  const playerView = views.get(player.id)!;
  // The office around the pilot's eye, for the cockpit and padlock views (the pilot's hands: handMesh.ts).
  await loadHandMesh();
  const cockpit = new Cockpit(opts.player, playerView.model.eye);
  {
    // The canopy seen from the seat (the outside model is hidden there): the same shell, nearly clear,
    // so the water it picks up in cloud reads from inside.
    const shell = playerView.model.root.getObjectByName('canopy glass');
    if (shell instanceof Mesh) {
      const inner = canopyMaterial(0x39424a, null);
      inner.opacity = 0.06;
      inner.side = DoubleSide;
      addCanopyRain(inner);
      const glassInside = new Mesh(shell.geometry, inner);
      glassInside.renderOrder = 4;
      cockpit.root.add(glassInside);
      // Its scratches, glinting round the sun (render/canopyScratches.ts), over the glass.
      const scratches = canopyScratchMesh(shell.geometry);
      scratches.renderOrder = 5;
      cockpit.root.add(scratches);
    }
  }
  stage.scene.add(cockpit.root);
  const combinerCorners: Vector3[] = [];
  const projected = new Vector3();
  const combatView = new CombatView(stage.scene, atmosphere);
  // Cloud shadows on the ground, the airbase and the aircraft (the sun light only).
  if (!params.has('nocloudshadow')) clouds.shadeReceivers(stage.scene, settings.quality === 'high' ? 4 : 2);
  const arrows = new ForceArrows();
  stage.scene.add(arrows.mesh);

  // ---- controls and displays
  const pilot = new PilotControls(input);
  // Water on the canopy (render/canopyRain.ts).
  let canopyWet = 0;
  // The sun on the canopy's scratches (render/canopyScratches.ts): hidden by cloud, sampled four times a second.
  let sunSeen = 1;
  let sunSeenAgeS = 1;
  const sunNdc = new Vector3();
  const sunView = new Vector3();
  const wetCanopyParam = params.has('wetcanopy');
  const bodyInv = new Quaternion();
  const flowLocal = new Vector3();
  const downLocal = new Vector3();
  pilot.invertPitch = controls.invertPitch;
  // Tilt steering listens only when chosen (the sensor runs at 60 Hz otherwise for nothing).
  const tilt = controls.tilt ? new TiltSteering() : null;
  const rig = new CameraRig(stage.camera);
  rig.compact = input.touch;
  const hudLayer = document.getElementById('hud') ?? ui;
  const hud = new Hud(hudLayer);
  hud.touchLayout = input.touch;
  const sensors = new SensorDisplays(hudLayer);
  const overlay = new DebugOverlay(ui);
  overlay.visible = false;
  const status = document.createElement('div');
  status.className = 'status';
  ui.appendChild(status);
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = input.touch ? 'Tap to fly' : 'Click to fly — Esc frees the mouse';
  ui.appendChild(banner);
  const startFlying = (): void => {
    // However the phone is held when the flight starts is "hands off".
    tilt?.calibrate();
    tones.start();
    input.requestLock();
  };
  canvas.addEventListener('click', startFlying);
  banner.addEventListener('click', startFlying);
  // Once the player has flown, letting go of the controls pauses the flight (ui/pause.ts).
  let flown = false;
  const pause = new PauseMenu(input.touch, { resume: startFlying, menu: () => window.location.assign(menuUrl()) });
  pause.touchButton?.addEventListener('click', () => input.exitLock());
  // Android's Back button (and leaving the app) pauses a flight; outside one, Back leaves the app.
  (window as unknown as { __gamePause?: () => boolean }).__gamePause = () => {
    if (!input.locked) return false;
    input.exitLock();
    return true;
  };
  input.onLockChange = (locked) => {
    if (locked) flown = true;
    banner.style.display = locked || flown ? 'none' : 'block';
    if (locked) pause.hide(true);
    else if (flown) pause.show();
    loop.paused = !locked && flown;
    const ctx = tones.context;
    if (ctx && flown) void (locked ? ctx.resume() : ctx.suspend());
  };
  let touch: FlightTouchControls | null = null;
  if (input.touch) {
    const b = (code: string): string => code;
    touch = new FlightTouchControls(input, [
      { code: b(DEFAULT_BINDINGS.fire[1]!), label: 'FIRE', col: 0, row: 0, mode: 'hold', big: true },
      { code: b(DEFAULT_BINDINGS.weapon[0]!), label: 'WPN', col: 1.5, row: 0, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.flare[0]!), label: 'FLR', col: 2.5, row: 0, mode: 'hold' },
      { code: b(DEFAULT_BINDINGS.chaff[0]!), label: 'CHF', col: 3.5, row: 0, mode: 'hold' },
      { code: b(DEFAULT_BINDINGS.designate[0]!), label: 'LOCK', col: 0, row: 1.5, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.radarMode[0]!), label: 'RDR', col: 1, row: 1.5, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.rangeUp[0]!), label: 'RNG', col: 2, row: 1.5, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.camera[0]!), label: 'CAM', col: 0, row: 2.5, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.gear[0]!), label: 'GEAR', col: 1, row: 2.5, mode: 'tap' },
      { code: b(DEFAULT_BINDINGS.brake[0]!), label: 'BRK', col: 2, row: 2.5, mode: 'hold' },
      ...(tilt ? [{ code: '', label: 'CAL', col: 3, row: 1.5, mode: 'tap' as const, action: (): void => tilt.calibrate() }] : []),
    ]);
    touch.setThrottle(aircraft.gear.weightOnWheels ? 0 : 0.8);
    // The touch layer covers the canvas: its first touch is the "tap to fly".
    touch.onTouch = (): void => {
      if (!input.locked) startFlying();
    };
  }

  console.log(formatEmChart(opts.player, emChart(opts.player, [0, 3000, 6000, 9000, 12_000], [100, 150, 200, 250, 300, 350, 400, 450, 500])));

  // The pilot's eyes for the AI: within 12 km (4 km behind), never through cloud.
  const canSee = (from: Combatant, to: Combatant): boolean => {
    const a = from.aircraft.position;
    const b = to.aircraft.position;
    const d = a.distanceTo(b);
    if (d > 12_000) return false;
    const fwd = from.aircraft.orientation.rotate(new Vec3(0, 0, -1));
    const dir = new Vec3().subVectors(b, a).scale(1 / Math.max(d, 1));
    if (fwd.dot(dir) < -0.5 && d > 4000) return false;
    const w = clouds.windOffset.value;
    return lineTransmittance(clouds.data, clouds.layer, a.x, a.y, a.z, b.x, b.y, b.z, w.x, w.y) > 0.3;
  };

  // ---- the pilot's weapon state
  const orders = createOrders();
  let weapon: WeaponMode = 'gun';
  const RANGE_SCALES_M = [18_520, 37_040, 74_080, 148_160];
  let rangeIndex = 2;
  player.radar.rangeScaleM = RANGE_SCALES_M[rangeIndex]!;
  const sun = new Vec3();
  let inRange = false;
  let envelopeTimerS = 0;
  const pipperTrail: { x: number; y: number; z: number; t: number }[] = [];
  let lastMissile: (typeof game.combat.missiles)[number] | null = null;
  let lastPaintCount = 0;
  // The flight sounds share the tones' audio context, so they exist once a gesture has started it.
  let sound: FlightSound | null = null;
  let muted = params.has('mute');

  const debugHooks = { aircraft, game, stage, frames: 0, input: pilot.input, pilot, tilt, rig, overlay, terrain, atmosphere, clouds };
  (window as unknown as { __contrail: typeof debugHooks }).__contrail = debugHooks;
  let clockS = 0;

  const loop = new FixedLoop(
    {
      step: (dtS) => {
        pilot.update(dtS, rig.mode !== 'orbit');
        if (touch) pilot.setTouch(touch.stick, touch.throttle);
        pilot.setTilt(tilt ? tilt.stick : null);
        if (rig.mode === 'orbit') rig.orbit(pilot.delta.dx, pilot.delta.dy);
        if (input.pressed('camera')) rig.next();
        if (input.pressed('pause') && input.locked) input.exitLock();
        if (input.pressed('debug')) overlay.visible = !overlay.visible;
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
        if (input.pressed('gear')) aircraft.toggleGear();
        // Weapons and sensors.
        if (input.pressed('weapon')) weapon = weapon === 'gun' ? 'srm' : weapon === 'srm' ? 'mrm' : 'gun';
        if (input.pressed('rangeUp')) rangeIndex = (rangeIndex + 1) % RANGE_SCALES_M.length;
        if (input.pressed('rangeDown')) rangeIndex = (rangeIndex + RANGE_SCALES_M.length - 1) % RANGE_SCALES_M.length;
        player.radar.rangeScaleM = RANGE_SCALES_M[rangeIndex]!;
        const radar = player.radar;
        if (input.held('antennaUp')) radar.antennaElRad = Math.min(0.5, radar.antennaElRad + 0.17 * dtS);
        if (input.held('antennaDown')) radar.antennaElRad = Math.max(-0.5, radar.antennaElRad - 0.17 * dtS);
        // With a designated target the antenna follows it.
        const tgt = radar.target;
        if (tgt) {
          const d = new Vec3().subVectors(tgt.position, aircraft.position);
          radar.antennaElRad = Math.atan2(d.y, Math.hypot(d.x, d.z));
        }
        // G-LOC: the pilot is out and the controls go slack.
        Object.assign(orders.flight, aircraft.g.glocS > 0 ? { ...pilot.input, pitch: 0, roll: 0, yaw: 0 } : pilot.input);
        orders.weapon = weapon;
        orders.trigger = weapon === 'gun' && input.held('fire');
        orders.launch = weapon !== 'gun' && input.pressed('fire');
        orders.flare = input.held('flare');
        orders.chaff = input.held('chaff');
        orders.designate = input.pressed('designate');
        orders.cycleRadar = input.pressed('radarMode');
        orders.breakLock = false;
        const s = lighting.sunDir;
        sun.set(s.x, s.y, s.z);
        const events = game.step(dtS, orders, groundAt, sun, canSee);
        if (input.pressed('mute')) muted = !muted;
        if (!sound && tones.context) sound = new FlightSound(tones.context);
        if (sound) {
          const c = stage.camera.position;
          const ear = new Vec3(c.x, c.y, c.z);
          for (const m of events.launches) sound.launch(m.position.distanceTo(ear));
          for (const x of events.explosions) sound.explosion(x.position.distanceTo(ear), x.size);
          if (events.hits.some((h) => h.targetId === player.id)) sound.hit();
        }
        if (events.launches.length) {
          for (const m of events.launches) if (m.ownerId === player.id) lastMissile = m;
        }
        if (!player.alive && player.deadS < 0.1) for (const v of views.values()) v.reset();
        // Weapon envelope twice a second (a fly-out is not free).
        envelopeTimerS -= dtS;
        if (envelopeTimerS <= 0) {
          envelopeTimerS = 0.5;
          inRange = false;
          const t = radar.target ? game.combat.get(radar.target.id) : undefined;
          if (weapon === 'mrm' && radar.locked && t) inRange = predictShot(MISSILES.mrm, aircraft.position, aircraft.velocity, t.body).hit;
          if (weapon === 'srm') {
            const st = game.combat.launchTarget(player, 'srm');
            inRange = !!st && predictShot(MISSILES.srm, aircraft.position, aircraft.velocity, st.body).hit;
          }
          if (weapon === 'gun' && t) inRange = t.aircraft.position.distanceTo(aircraft.position) < 1200;
        }
        input.endStep();
      },
      render: (alpha, frameS) => {
        clockS += frameS;
        const high = settings.quality === 'high';
        EMISSIVE_EXPOSURE.value = lighting.exposure;
        const frame = { alpha, frameS, clockS, eye: stage.camera.position, humidity: lighting.preset.humidity, highQuality: high };
        for (const f of game.combat.fighters) views.get(f.id)!.update(f.aircraft, frame, f === player ? rig.mode !== 'cockpit' && rig.mode !== 'panel' && rig.mode !== 'padlock' : true);
        // Cameras: padlock on the radar's target (or the nearest enemy), missile cam on our last missile.
        const radar = player.radar;
        const tgtFighter = radar.target ? game.combat.get(radar.target.id) : game.combat.fighters.find((f) => f !== player && f.alive);
        const padlock = tgtFighter ? views.get(tgtFighter.id)!.renderPos : null;
        if (lastMissile && !game.combat.missiles.includes(lastMissile)) lastMissile = null;
        const missile = lastMissile ? { position: new Vector3(lastMissile.position.x, lastMissile.position.y, lastMissile.position.z), velocity: new Vector3(lastMissile.velocity.x, lastMissile.velocity.y, lastMissile.velocity.z) } : null;
        rig.update(playerView.renderPos, playerView.renderRot, playerView.model.eye, aircraft.loadFactor, AIRCRAFT[opts.player].lengthM, frameS, { padlock, missile });
        stage.camera.updateMatrixWorld();
        combatView.update(game.combat, clockS, stage.camera.position);
        const inside = (rig.mode === 'cockpit' || rig.mode === 'panel' || rig.mode === 'padlock') && player.alive;
        const nose = aircraft.orientation.rotate(new Vec3(0, 0, -1));
        const wingR = aircraft.orientation.rotate(new Vec3(1, 0, 0));
        const roof = aircraft.orientation.rotate(new Vec3(0, 1, 0));
        const ps = player.stores;
        cockpit.update(playerView.renderPos, playerView.renderRot, inside, frameS, {
          radar: player.radar,
          rwr: player.rwr,
          altitudeM: aircraft.position.y,
          pitchRad: Math.asin(Math.max(-1, Math.min(1, nose.y))),
          rollRad: Math.atan2(-wingR.y, roof.y),
          headingDeg: (Math.atan2(nose.x, -nose.z) * 180) / Math.PI + 360,
          speedMs: aircraft.speedMs,
          mach: aircraft.mach,
          loadFactor: aircraft.loadFactor,
          fuelKg: aircraft.fuelKg,
          weapon,
          gunRounds: ps.gunRounds,
          srm: ps.srm,
          mrm: ps.mrm,
          flares: ps.flares,
          chaff: ps.chaff,
        }, { pitch: pilot.input.pitch, roll: pilot.input.roll, throttle: pilot.input.throttle });
        // The screen-corner radar and threat displays are the cockpit's own screens inside.
        sensors.visible = !inside;
        hud.clipToCombiner = rig.mode === 'cockpit' || rig.mode === 'panel';
        // Head bowed to the panel, a helmet display's symbology would float over the instruments: it stays
        // off until the head comes up. (A combiner's stays on its glass, out of the way.)
        hud.visible = !(rig.mode === 'panel' && !cockpit.combiner);
        hud.combinerOutline = null;
        if (hud.clipToCombiner && cockpit.combinerWorld(combinerCorners)) {
          hud.combinerOutline = combinerCorners.map((c) => {
            projected.copy(c).project(stage.camera);
            return { x: ((projected.x + 1) / 2) * window.innerWidth, y: ((1 - projected.y) / 2) * window.innerHeight };
          });
        }
        const warnings: string[] = [];
        if (aircraft.g.glocS > 0) warnings.push('G-LOC');
        if (aircraft.overstressed) warnings.push('OVER G');
        if (tilt && !tilt.available && clockS > 3) warnings.push('NO TILT SENSOR');
        if (aircraft.coeff.separation > 0.3 && aircraft.speedMs > 20) warnings.push('ALPHA');
        if (pilot.input.limiterRelaxed) warnings.push('LIM OFF');
        if (aircraft.fuelKg < 800) warnings.push('FUEL');
        if (aircraft.gear.position > 0 && aircraft.gear.position < 1) warnings.push('GEAR');
        if (pilot.input.brake) warnings.push('BRAKE');
        if (player.rwr.worst === 'launch') warnings.push('MISSILE');
        terrain.update(stage.camera);
        // Attack symbology.
        const st = player.stores;
        const attack: AttackCue = { target: null, locked: radar.locked, rangeM: 0, closureMs: 0, inRange, pipper: null, pipperTrail: [], seeker: null, seekerTone: false, lockProgress: radar.mode === 'stt' ? radar.lockProgress : 0 };
        const tc = radar.target;
        if (tc && player.alive) {
          const tf = game.combat.get(tc.id);
          const p = tf ? views.get(tf.id)!.renderPos : tc.position;
          attack.target = { x: p.x, y: p.y, z: p.z };
          attack.rangeM = tc.rangeM;
          attack.closureMs = tc.closureMs;
        }
        let seekerState: 'off' | 'search' | 'tone' = 'off';
        if (player.alive && weapon === 'gun') {
          const range = tc && tc.rangeM < 1800 ? tc.rangeM : 700;
          const dir = gunDirection(aircraft.orientation);
          const { point, tofS } = gunImpact(aircraft.position, aircraft.velocity, dir, range);
          // In the shooter's frame: where the stream will be relative to the jet as it flies on.
          const pp = { x: point.x - aircraft.velocity.x * tofS, y: point.y - aircraft.velocity.y * tofS, z: point.z - aircraft.velocity.z * tofS };
          attack.pipper = pp;
          pipperTrail.push({ ...pp, t: clockS });
          while (pipperTrail.length && clockS - pipperTrail[0]!.t > 1) pipperTrail.shift();
          attack.pipperTrail = pipperTrail;
        }
        if (player.alive && weapon === 'srm' && st.srm > 0) {
          const t = game.combat.launchTarget(player, 'srm');
          if (t) {
            const p = views.get(t.id)!.renderPos;
            attack.seeker = { x: p.x, y: p.y, z: p.z };
            attack.seekerTone = true;
            seekerState = 'tone';
          } else {
            const fwd = aircraft.orientation.rotate(new Vec3(0, 0, -2000)).add(aircraft.position);
            attack.seeker = { x: fwd.x, y: fwd.y, z: fwd.z };
            seekerState = 'search';
          }
        }
        const weaponLabel = weapon === 'gun' ? `GUN ${st.gunRounds}` : weapon === 'srm' ? `SRM ${st.srm}` : `MRM ${st.mrm}`;
        hud.draw(stage.camera, aircraft, pilot.input, {
          radarAltitudeM: Math.max(0, aircraft.position.y - aircraft.wheelDropM - groundAt(aircraft.position.x, aircraft.position.z)),
          weaponMode: aircraft.gear.position > 0.99 && weapon === 'gun' ? 'GEAR DN' : weaponLabel,
          stores: `G${st.gunRounds} S${st.srm} M${st.mrm} F${st.flares} C${st.chaff}`,
          warnings,
          attack,
          message: game.message,
        });
        sensors.draw(radar, player.rwr, aircraft.position.y);
        const paints = [...player.rwr.threats.values()].filter((t) => t.level === 'search').reduce((n, t) => n + Math.round(t.lastS * 10), 0);
        tones.muted = muted;
        tones.update(player.rwr.worst, paints !== lastPaintCount, seekerState);
        if (sound) {
          sound.muted = muted;
          const alive = player.alive;
          sound.update({
            core: alive ? aircraft.engine.core : 0,
            burner: alive ? aircraft.engine.burner : 0,
            dynamicPressurePa: alive ? aircraft.dynamicPressurePa : 0,
            speedMs: aircraft.speedMs,
            alphaRad: aircraft.alphaRad,
            gunFiring: alive && orders.trigger && player.stores.gunRounds > 0,
            gunRoundsPerS: GUN.roundsPerS,
            cockpit: rig.mode === 'cockpit' || rig.mode === 'panel' || rig.mode === 'padlock',
            listener: stage.camera.position,
            listenerVelocity: aircraft.velocity,
            others: game.combat.fighters.filter((f) => f !== player).map((f) => ({ position: f.aircraft.position, velocity: f.aircraft.velocity, core: f.aircraft.engine.core, burner: f.aircraft.engine.burner, alive: f.alive })),
          });
        }
        lastPaintCount = paints;
        status.textContent = game.status();
        const camY = stage.camera.position.y;
        lighting.setCloudCover(clouds.layer.coverage, camY < clouds.layer.baseM ? 'below' : camY > clouds.layer.topM ? 'above' : 'inside');
        // In the seat the shadow map follows the eye, a few metres across (lighting.ts).
        lighting.setShadowReach(inside);
        lighting.update(stage.camera, inside ? stage.camera.position : playerView.renderPos);
        clouds.update(frameS, stage.camera.position, high);
        stage.scene.environment = lighting.environment;
        {
          // Water on the canopy: picked up inside cloud, blown off by the airflow once out of it.
          const inCloud = camY >= clouds.layer.baseM && camY <= clouds.layer.topM && clouds.layer.coverage > 0.3;
          canopyWet = Math.max(0, Math.min(1, canopyWet + frameS * (inCloud ? 0.6 : -0.12)));
          if (wetCanopyParam) canopyWet = 1; // ?wetcanopy: screenshot and test hook
          canopyRain.value = canopyWet;
          bodyInv.copy(playerView.renderRot).invert();
          flowLocal.set(aircraft.velocity.x, aircraft.velocity.y, aircraft.velocity.z).applyQuaternion(bodyInv).multiplyScalar(-0.05);
          downLocal.set(0, -1, 0).applyQuaternion(bodyInv);
          canopyFlow.value.copy(flowLocal.addScaledVector(downLocal, 0.4)).normalize();
          const tas = Math.hypot(aircraft.velocity.x, aircraft.velocity.y, aircraft.velocity.z);
          canopyFlowSpeed.value = Math.min(1.6, 0.06 + tas * 0.02);
          canopyTime.value += frameS;
          sunSeenAgeS += frameS;
          if (sunSeenAgeS > 0.25) {
            sunSeenAgeS = 0;
            const c = stage.camera.position;
            const w = clouds.windOffset.value;
            const sd = lighting.sunDir;
            sunSeen = sd.y < -0.02 ? 0 : lineTransmittance(clouds.data, clouds.layer, c.x, c.y, c.z, c.x + sd.x * 20_000, c.y + sd.y * 20_000, c.z + sd.z * 20_000, w.x, w.y);
          }
          scratchSunDir.value.copy(lighting.sunDir);
          // The lens flare: the sun on screen (the GPU measures how much of it shows) and its light at the lens.
          const cam = stage.camera;
          cam.updateMatrixWorld();
          sunNdc.copy(cam.position).addScaledVector(lighting.sunDir, 1000).project(cam);
          const ahead = sunView.copy(lighting.sunDir).transformDirection(cam.matrixWorldInverse).z < 0;
          const edge = Math.min(1 - Math.abs(sunNdc.x), 1 - Math.abs(sunNdc.y));
          flareOnScreen.value = ahead && lighting.sunDir.y > -0.02 ? Math.min(1, Math.max(0, edge / 0.04)) : 0;
          flareSunUv.value.set(sunNdc.x * 0.5 + 0.5, 0.5 - sunNdc.y * 0.5);
          flareAspect.value = cam.aspect;
          flareDiscRadius.value = Math.tan(SUN_RADIUS_RAD) / (2 * Math.tan((cam.fov * Math.PI) / 360));
          flareDiscLum.value = Math.max(lighting.sunDiscLuminance, 1e-6);
          flareSun.value.set(lighting.sun.color.r, lighting.sun.color.g, lighting.sun.color.b).multiplyScalar(lighting.sun.intensity);
          const sunI = lighting.sun.intensity * sunSeen;
          scratchSun.value.set(lighting.sun.color.r * sunI, lighting.sun.color.g * sunI, lighting.sun.color.b * sunI);
        }
        stage.greyOut.value = greyOut(aircraft.g);
        stage.redOut.value = aircraft.g.redOut;
        arrows.update(playerView.renderPos, aircraft.forces, aircraft.velocity, overlay.visible && rig.mode !== 'cockpit' && rig.mode !== 'panel');
        overlay.update(aircraft, pilot.input, `${stage.backendName} · ${settings.quality} · ${settings.toneMap} · ${lighting.preset.label} · camera ${rig.mode} · terrain ${terrain.nodesDrawn} patches · radar ${radar.mode} · AI ${game.ais.map((a) => a.state).join('/')}`);
        if (frameS > 0 && !document.hidden) stage.governor.update(frameS);
        stage.render();
        debugHooks.frames++;
        if (debugHooks.frames === 2) console.log(`[load] first frames drawn at ${((performance.now() - tLoad) / 1000).toFixed(2)} s`);
      },
    },
    PHYSICS.maxStepsPerFrame,
  );
  stage.camera.position.set(0, 200, 0);
  stage.camera.updateMatrixWorld();
  lighting.update(stage.camera, stage.camera.position);
  await lighting.prepare(stage.camera);
  lighting.update(stage.camera, stage.camera.position);
  // Every shader the first frames need, built behind the loading text for the scene pass the game draws in,
  // all at once (render/warmup.ts): without it the first frame built them one after another, synchronously,
  // the window frozen. The shadow and post passes still build in that frame.
  loading.textContent = 'Contrail — compiling shaders';
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  const shown: Object3D[] = [];
  const restore = revealOnePerPipeline(stage.scene, shown);
  const tc = performance.now();
  try {
    if (!new URLSearchParams(location.search).has('noprecompile')) await compileForPass(stage.renderer, stage.scene, stage.camera, stage.scenePass, shown, 19000);
  } finally {
    restore();
  }
  console.log(`[load] ${shown.length} shader builds pre-compiled in ${((performance.now() - tc) / 1000).toFixed(2)} s; loading ${((performance.now() - tLoad) / 1000).toFixed(2)} s`);
  loading.remove();
  loop.start();
}

main().catch((err: unknown) => {
  console.error(err);
  const ui = document.getElementById('ui');
  if (ui) ui.textContent = `Contrail failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
