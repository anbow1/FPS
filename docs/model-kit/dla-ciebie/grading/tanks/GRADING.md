# Tanks — grading guide

For the person evaluating a model's build. Do not give this file to the model:
it would build to the test. The model gets [BRIEF.md](../../../dla-modelu/games/tanks/BRIEF.md), `target-look/`
and `dla-modelu/reference-sheets/`. Feature IDs and section numbers (§1–§6) below refer
to the brief. See [../../README.md](../../README.md) for the protocol.

## 7. Verification procedure

1. `npm ci && npm run build && npm test` on a clean checkout.
2. Static checks: no `any`, no shader patching, no lights created after load,
   one draw per tree species (count draws with the forest in view).
3. Load on WebGPU and on the WebGL2 fallback: page or shader errors, or a load
   that never finishes, are automatic fails.
4. Fixed views at 1920 × 1080 High for the blind comparison: the benchmark
   views (spawn road, village, lake), the gunner's sight at 8× on a tank at ~1500 m, the thermal channel
   on the same view, a lake bank, a burning wreck at dusk.
5. Gunnery: fire APFSDS at targets at 500/1000/2000 m, compare flight time and
   impact with the sheet; hit a tank's side at a grazing angle (ricochet) and
   square-on (penetration); knock out a track.
6. Fight a wave: watch enemy tanks halt to fire and lead a moving target;
   drive past a wood and get ambushed by infantry; launch the drone, spot
   infantry, see them marked; let the drone be shot at.
7. Water and trees: drive through a lake margin (bow wave, ripples, slowing),
   fire into a lake, drive through a wood (trees break and fall).
8. Benchmark on High and Low; 3 minutes of play for hitches; first shot of
   each round type and first drone launch must not hitch.
9. APK on a mid-range phone with touch controls: drive, aim, fire, sight,
   thermal.

## 8. Scoring rubric (100 points)

**Automatic fail:** does not build; page or shader error; never reaches play;
runtime downloads of assets.

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests
- 3 no error flood in 5 minutes of combat
- 3 several waves can be fought to a result (win or loss) without a reload

### 8.2 Architecture and code — 10
- 3 rules §2.1–2.3
- 3 fixed-step physics, one ballistic integrator for shells, AI and the sight
- 2 fixed light count; shaders precompiled (no hitch on first shot, first
  explosion, first thermal, first drone)
- 2 readability: config with units and sources, comments say why

### 8.3 Gameplay features — 25
- 5 V-01, V-02, V-06 vehicle feel and traverse rates
- 5 V-03, V-04 rounds and ballistics; **flight times within 5 % are worth 3**
- 5 V-05 armour, ricochets, modules, fires, cook-off
- 5 E-01, E-02 enemy tanks and infantry behave as specified
- 3 E-03, V-07 drone, range finder, thermal
- 2 U-03 audio

### 8.4 Graphics vs target look — 25
- 5 terrain, roads, grass (G-01, G-03)
- 5 forest with impostors and dithered LOD at long range (G-02)
- 4 water (G-05)
- 3 village and vehicles (G-04, G-06)
- 2 effects, light and weather (G-07, G-08)
- 6 blind ranking against `target-look/` at the fixed views

### 8.5 Performance and budgets — 15
- 5 draw calls and triangles under the ceilings at every view
- 4 60 fps desktop at High (or held by the governor)
- 3 no hitch > 50 ms after the first second
- 3 benchmark and governor work

### 8.6 Tests and tooling — 10
- 4 unit tests: ballistics against the sheet, armour (angle, ricochet,
  range), vehicle drive, AI lead solution
- 3 F3 overlay and a benchmark table at named views
- 3 reports accurate against what you measured

### 8.7 Phone build and touch — 5
- 3 APK runs on Low with touch: drive stick, drag to aim, fire, sight, thermal
- 2 ≥ 30 fps on the road view

## 9. Report the model must hand back

1. Feature IDs with done / partial / missing.
2. How to run, test, benchmark, package.
3. Benchmark table at every view, both presets, the device.
4. Ballistics table: APFSDS flight time and drop at 500/1000/2000/3000 m next
   to the sheet.
5. Screenshots at the fixed views of §7.4.
6. Known issues and anything skipped, with reasons.
