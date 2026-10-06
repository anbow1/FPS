# Attack helicopter — grading guide

For the person evaluating a model's build. Do not give this file to the model:
it would build to the test. The model gets
[BRIEF.md](../../../dla-modelu/games/attack-helicopter/BRIEF.md), the rules and
`dla-modelu/reference-sheets/`. There is no `target-look/` for this game: judge
the graphics against `dla-modelu/rules/graphics-quality.md`. See
[../../README.md](../../README.md) for the protocol.

## 7. Verification procedure

1. `npm ci && npm run build && npm test` on a clean checkout.
2. Static checks: no `any`; no `ShaderMaterial`, `onBeforeCompile` or
   `EffectComposer`; the rotor model has no three.js import and its own tests;
   no lights created after load.
3. Load on WebGPU and on the WebGL2 fallback: page or shader errors, or a load
   that never finishes, are automatic fails.
4. **Flight model**, debug overlay on:
   - hover at 5 m and at 50 m: the low hover needs less collective (ground
     effect); with stability augmentation off a hover is genuinely hard;
   - raise collective sharply in a hover: the nose yaws until pedals correct it;
   - accelerate out of a hover: a clear lift surge passing ~15 m/s;
   - dash to maximum speed: vibration warning, then retreating-blade stall;
   - descend vertically at low speed with power: vortex ring warning (shake),
     loss of lift, recovery with **forward cyclic** (more collective must not
     recover it);
   - cut the engine at 300 m and 40 m/s: autorotate to a field with a flare —
     survivable when flown right, fatal when not.
5. **Weight and balance**: fire all missiles and rockets, burn fuel — the trim
   point and the hover collective change.
6. **HUD**: the velocity-vector ball shows drift clearly in a hover over a
   landing pad; torque, rotor RPM, radar altitude and warnings (shape and voice)
   for low RPM, torque exceeded, incoming launch, vortex ring.
7. **Sensor turret**: daylight, white-hot, black-hot, zoom; slaved to nose, to
   the pilot's look and geo-locked on a ground point while manoeuvring; the
   designator needs time to settle and loses the shot when the line of sight
   breaks; found targets appear on the map.
8. **Weapons**: cannon dispersion and dust line, overheating; rocket ripples of
   1/4/8 with the ballistic cue accounting for drift; the laser-riding missile
   misses when the laser leaves the target; fire-and-forget needs a lock; armour
   facing (top or rear hit works, frontal often fails); weight and drag change
   with stores.
9. **Enemies**: shoulder-launched missile with a launch flash and time to react;
   the anti-air vehicle kills you reliably above the ridgeline and cannot see
   you behind it; the enemy helicopter pops up, shoots and hides, disengages
   when losing — it does not joust.
10. **Missions**: the landing school scores hover boxes, a confined-area landing
    and the autorotation; the armour hunt needs masking; close support fails on
    friendly fire.
11. **Environment**: downwash over dust, water, grass and snow (colour from the
    surface, grass bending in a ring); brownout on a desert landing hides the
    ground; night mission on thermal and night vision; rotor disc and blade
    shadow at full RPM with no ghosting; the rotor shadow sweeps the cockpit.
12. Benchmark on High at 1440p (downwash and thermal active) and on Low;
    5 minutes of combat for hitches; first rocket ripple, first missile, first
    thermal, first brownout must not hitch.
13. APK on a mid-range phone with touch controls: hover, land, fire.

## 8. Scoring rubric (100 points)

**Automatic fail:** does not build; page or shader error; never reaches flight;
runtime downloads of assets; the helicopter flies like a plane with vertical
thrust (no rotor model).

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests
- 3 no error flood in 10 minutes of combat
- 3 every mission can be played to a result without a reload

### 8.2 Architecture and code — 10
- 3 stack rules (WebGPURenderer, TSL, one post chain, strict TS)
- 3 fixed-step rotor model without three.js, typed config with units and sources
- 2 fixed light count; shaders precompiled (no hitch on first weapon, thermal,
  downwash)
- 2 readability: comments say why

### 8.3 Flight model and gameplay — 25
- 10 rotor model: collective thrust with density and RPM, cyclic disc tilt with
  flapping lag, torque and tail rotor coupling, translational lift, ground
  effect, retreating-blade stall, vortex ring state, autorotation, SAS switch
- 4 acceptance: cannot hover on the first try, can after ten minutes (ask a
  tester), autorotation from 300 m possible
- 4 sensor turret, designator and map flow
- 4 weapons as specified, armour facing, stores changing weight and drag
- 3 enemies: anti-air forces masking; the enemy helicopter fights by masking

### 8.4 Graphics — 25
- 6 terrain with real relief at 20 × 20 km (ridges, valleys, river, roads,
  village, forest) that makes masking a real tactic
- 6 downwash, dust, spray, grass ring and brownout, coloured by the surface
- 4 rotor disc with blade shadow, no ghosting; rotor shadow in the cockpit
- 4 cockpit and MFDs with real content; monocle symbology aligned to the look
- 5 lighting presets to the sheet; night on thermal and night vision with the
  correct look and blooming point lights

### 8.5 Performance and budgets — 15
- 5 60 fps at 1440p High with downwash and thermal; sensor + MFDs + downwash in
  the 2 ms slot
- 4 draw calls and triangles under the ceilings at every benchmark view
- 3 no hitch > 50 ms after the first second
- 3 benchmark, F3 overlay and governor work

### 8.6 Tests and tooling — 10
- 4 unit tests: rotor thrust and induced velocity in a hover against momentum
  theory, ground-effect ratio, translational lift, vortex ring onset, rocket
  and cannon ballistics
- 3 debug overlay as specified, kept behind a key in the shipped build
- 3 reports accurate against what you measured

### 8.7 Phone build and touch — 5
- 3 APK on Low with touch: cyclic, collective, pedals, fire, sensor
- 2 ≥ 30 fps over the village

## 9. Report the model must hand back

1. Every brief item with done / partial / missing.
2. How to run, test, benchmark, package.
3. Benchmark table at every view, both presets, the device.
4. Flight-model state at each milestone: hover collective in and out of ground
   effect, translational-lift speed, vortex ring onset, autorotation RPM.
5. Screenshots: hover over dust, brownout, rotor disc exterior, cockpit with
   MFDs, thermal and night vision.
6. Known issues and anything skipped, with reasons.
