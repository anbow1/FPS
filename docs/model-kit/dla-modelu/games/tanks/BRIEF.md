# Tanks — brief

This is the task. Build the game described below. The images it refers to are in
`target-look/` (next to this file) and the binding reference sheets in
`../../reference-sheets/`.

## 1. What to build

A tank game in **TypeScript + three.js**. The player commands one main battle
tank on a 2 km × 2 km map of rolling farmland and forest (play area about
1.7 km across): meadows, dirt roads with ruts, spruce and birch woods, a
village of brick and plaster houses, upland lakes. Waves of enemy tanks,
infantry ambush teams with RPGs and a scout drone of your own make the fight.

Third-person chase camera, a **gunner's sight** with 3×/8×/12× zoom, a
**thermal channel**, a laser range finder with a lead marker, a minimap.
Everything is generated in code: terrain, buildings, trees, tanks, textures,
sounds. No downloaded models, textures or audio files.

The images in `target-look/` show the quality bar. The sheets in
`../../reference-sheets/` are binding: lighting (lux, EV100), PBR materials, scale,
ballistics (APFSDS flight times), HUD zones (the tank panel) and the
performance budget.

## 2. Platform and hard rules

1. TypeScript strict, Vite, no `any`; SI units in names; comments say *why*.
2. three.js **`WebGPURenderer`** with its WebGL2 fallback; all shaders in
   **TSL** node materials; no `ShaderMaterial`, `onBeforeCompile`, or
   `EffectComposer`.
3. One post chain: HDR scene pass (velocity MRT) → TRAA (High) → GTAO (High) →
   sun shafts → bloom → exposure + ACES + sRGB → thermal grade → sharpen (High)
   / FXAA (Low).
4. Physical light and exposure per `lighting-reference.png`; pre-exposure on all
   lights; height fog with Mie scattering toward the sun as `scene.fogNode`;
   drifting cumulus whose shadows move over ground and water.
5. Fixed 60 Hz physics with render interpolation; logic separate from
   rendering.
6. Fixed light count from load; every shader (effects, tracers, drone,
   thermal, water) compiled behind the loading screen; changing the time of
   day compiles nothing.
7. Sight lines to 3 km must hold up: terrain LOD in chunks, trees as
   **impostors** at distance with **dithered** hand-over, one draw per tree
   species, cascaded shadows only where they matter.
8. Low and High presets, a frame governor (AO first, then shafts, then render
   scale down to ~58 %), a benchmark at fixed named views; Android APK with
   touch controls.

## 3. Required features and acceptance criteria

### Vehicle and gunnery
- **V-01** Player tank about 57 t, top speed ~19 m/s forward, ~8 m/s reverse,
  power- and traction-limited drive, slope resistance, brakes, neutral turn;
  spring-damper suspension (dives under braking, rocks on firing); animated
  road wheels and tracks; track marks; dust on dry ground.
- **V-02** Turret and gun traverse at real rates (turret ~40°/s, gun ~7°/s,
  −9° … +20°); the turret lags the mouse. A hull/turret indicator.
- **V-03** Three rounds on 1/2/3: APFSDS (v0 ≈ 1575 m/s), HEAT-FS, HE-FRAG,
  each with drag, a reload of ~6 s, a coaxial machine gun with tracers.
- **V-04** One integrator for shells and the fire-control computer. *Accept:*
  APFSDS time of flight 0.32 s at 500 m, 0.64 s at 1000 m, 1.30 s at 2000 m,
  2.0 s at 3000 m (±5 %); the sight zeroed at 1000 m with the sheet's
  holdovers.
- **V-05** Armour: line-of-sight thickness `t / cos θ`, ricochets at grazing
  angles, penetration falling with range, ±8 % spread. Modules: engine,
  tracks, gun, turret drive, ammunition, fuel — knocked out individually;
  fires, ammunition cook-off that throws the turret, field repairs.
- **V-06** Trees break under the hull; wading slows the tank and deep water
  stops it.
- **V-07** Laser range finder (distance + lead mark on a locked tank); thermal
  view (white-hot) in the sight and the drone.

### Opponents and support
- **E-01** Enemy tanks: line of sight over terrain, hear shots, lead the target
  with the same solver, fire from a short halt, angle the hull, shoot-and-move.
- **E-02** Infantry ambush teams (RPG gunner + riflemen) hidden in woods and by
  buildings; the RPG aims 2–3 s with lead, the rocket has its own ballistics
  and a HEAT warhead; infantry flees the tank and dies to the MG, HE and tracks.
- **E-03** A scout drone launched from the tank: battery ~160 s, link range
  ~1.7 km, ceiling ~220 m, avoids tree crowns; everything its camera sees is
  marked on the minimap and on screen for 25 s; enemies can shoot it down.

### World and graphics (compare with `target-look/`)
- **G-01** Terrain: layers blended by slope and height (meadow, soil, rock on
  slopes triplanar, wet mud by the water), dirt roads with ruts, stochastic
  tiling of close-up textures, macro variation; LOD in 128 m chunks.
- **G-02** Forest: spruces from branch whorls on alpha-clip cards, birches with
  leaf clumps and pale bark, outward-bent normals, translucency against the
  sun, wind; **impostors** beyond the near range with **dithered** hand-over.
- **G-03** **Real grass blades** near the tank, sized for a camera several
  metres up (wider blades, never reading as stripes), pushed down by the
  hulls.
- **G-04** Village: brick with mortar, plaster flaking off in patches, mossy
  roof tiles, boards, rusty corrugated iron; damp at the base and rain streaks;
  window frames, sills, gutters, chimneys — all procedural.
- **G-05** Lakes: **FFT wind waves** (Tessendorf) for the normals, exact
  Fresnel, Beckmann sun glints widened by slope variance from the mip chain,
  the refracted bed traced through the real terrain with Beer–Lambert
  absorption and in-scattering, caustics from wave lensing, shore foam, a
  lapping wet band on the banks, **ripples** from hulls and shells.
- **G-06** Vehicles: NATO green camouflage, dust low and on flat surfaces, soot
  and rust on wrecks; a burning wreck as a flickering light (~12 000 cd) with a
  shadow.
- **G-07** Effects as instanced sprites: muzzle blast, dust, smoke, fire,
  sparks, tracers; craters and scorch decals.
- **G-08** Times of day from the sheet (clear noon to cloudy night), cloud
  shadows, headlights (~15 000 cd).

### UI and audio
- **U-01** HUD per the tank panel of `hud-layout-reference.png`: turret/hull
  indicator top-left; range, ammunition and reload top-right; reticle and lead
  mark centre; minimap with turret cone, drone and spotted infantry
  bottom-left; hull damage by module bottom-right. 16:9 safe zone kept on
  ultrawide screens.
- **U-02** F3 overlay: draw calls and triangles against the budget, backend,
  GPU time per pass where available, governor level.
- **U-03** Audio: engine by load and speed, gun blast, shell crack, impacts by
  material, the MG, the drone rotor, explosions with distance delay.

## 4. Reference images

Target look (`target-look/`, captured from the reference implementation at
960 × 540, High preset, software renderer):

| File | What it shows | Match this |
|---|---|---|
| `01_road.png` | The tank on a dirt road at the spawn: meadow, spruces and a birch, cumulus | chase-camera framing, road ruts, grass blades sized for the camera height, sky |
| `02_village.png` | Towards the village across fields, a spruce close by | spruce crown detail and shadow, houses and hills fading with distance |
| `03_lake.png` | Above a lake among wooded hills | water seen through the trees, layered hills, distant forest as impostors |
| `04_gunner_sight.png` | The gunner's sight on a wooded slope | a true magnified second view inside the sight's round field, the dark surround |
| `05_thermal.png` | The same view in the thermal channel | cold sky, sun-warmed ground lighter than the trees, sensor noise — vehicles and people would be the brightest things |
| `contact-sheet.png` | All of the above with captions | — |

## 5. Budgets and presets

| | High (desktop) | Low (phone) |
|---|---|---|
| Draw calls at any benchmark view | ≤ 2500 | ≤ 1500 |
| Triangles | ≤ 12 M | ≤ 4 M |
| Shadow cascades | 3 × 2048 | 2 × 1024 |
| Frame rate | 60 fps desktop mid-range GPU | ≥ 30 fps mid-range phone |
| Gunner sight + thermal | inside the 2 ms game slot | |
| Hitches | none > 50 ms after the first second | |

Benchmark views: spawn, spawn looking back, village, lake, road.

## 6. Build order (stop and report after each)

1. Renderer, exposure, sky, fog, a heightfield with LOD, a box that drives.
2. The tank: drive, suspension, turret and gun, chase camera.
3. Ballistics and the gunner's sight; report the APFSDS flight times against
   the sheet.
4. Armour and modules on a target tank; damage feedback.
5. Enemy tank AI; waves.
6. Terrain materials, roads, forest with impostors, grass blades.
7. Village, lakes (FFT water, ripples, banks).
8. Infantry ambush teams, the drone, thermal view, range finder.
9. Effects, wrecks, audio pass, HUD and minimap.
10. Performance pass (benchmark, governor), settings, Android build with touch.

Each report: what works, how to run it, the benchmark table, screenshots of
what changed, what is not done.
