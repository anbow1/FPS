# Field Line — grading guide

For the person evaluating a model's build. Do not give this file to the model:
it would build to the test. The model gets [BRIEF.md](../../../dla-modelu/games/field-line/BRIEF.md), `target-look/`
and `dla-modelu/reference-sheets/`. Feature IDs and section numbers (§1–§6) below refer
to the brief. See [../../README.md](../../README.md) for the protocol.

## 7. Verification procedure

1. **Build and tests.** `npm ci && npm run build && npm test` must pass on a
   clean checkout. Note test count and what they cover.
2. **Static checks.** Search the source for `any`, `onBeforeCompile`,
   `ShaderMaterial`, `EffectComposer`, imports of `three` inside the logic
   folder, and lights created after load (each hit costs points in §8.2).
3. **WebGPU and WebGL2.** Load each map in desktop Chromium with WebGPU, and
   once with WebGPU disabled. Any shader compile error or page error is an
   automatic fail.
4. **Fixed views.** Use the model's benchmark (or place the camera by hand) at:
   range lane looking downrange; scope at 10× on the 600 m target; forest
   meadow at the spawn; the lake from its bank; a city square at noon; a city
   interior from the doorway. Screenshot each at 1920 × 1080 High. These go
   into the blind comparison with `target-look/`.
5. **Benchmark numbers.** At each view record draw calls, triangles, frame
   time (and GPU ms if exposed) on High and Low.
6. **Scripted acceptance.** On the range: zero at 300 m, hit the 600 m plate
   with the sheet's holdover. Stand still in Skirmish and time the first flank
   (≤ 15 s). Throw smoke between you and a squad and confirm they lose you.
   Walk from a noon street into an interior and watch exposure adapt (~2 s, no
   black or blown frames). Wade into the lake and check ripples spread and stop
   at the bank. Fire into the water near the shore.
7. **Stutter.** Play 3 minutes: first shot of each weapon, first grenade of
   each type, first look at each map area. Any frame > 50 ms after the first
   second is a deduction.
8. **Phone.** Install the APK on a mid-range Android phone. It starts on Low
   with touch controls; play 2 minutes on the forest map.

## 8. Scoring rubric (100 points)

**Automatic fail (score 0, note the reason):** does not build; page error or
shader error on load on either backend; never reaches gameplay; downloads
assets from the internet at runtime.

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests on a fresh checkout
- 3 no console errors or warnings flood in 5 minutes of play
- 3 all three maps and modes load and can be finished

### 8.2 Architecture and code — 10
- 3 rules §2.1–2.3 followed (TS strict, WebGPURenderer + TSL, one post chain)
- 3 headless deterministic logic at 60 Hz, render interpolates, no three.js in logic
- 2 fixed light count, shaders precompiled, simple collision shapes
- 2 readable code: config in one place with units and sources, comments say why

### 8.3 Gameplay features — 25
- 4 P-01…P-04 movement (speeds measured)
- 6 W-01…W-09 weapons; **W-05 ballistics within 5 % is worth 3 of these**
- 4 D-01…D-03 damage, items, feedback
- 6 A-01…A-03 AI (perception, states, flank in ≤ 15 s, smoke blocks sight)
- 3 modes: Range, Skirmish, Extraction work end to end
- 2 U-03 audio (distance delay, crack, surface footsteps)

### 8.4 Graphics vs target look — 25
- 5 light and atmosphere: presets, exposure, fog and haze, shadows (G-01…G-03)
- 6 vegetation: species instancing, translucency, wind, impostors, dithered
  LOD, grass blades (G-04, G-05, G-07)
- 4 water: lake optics, shore, caustics, ripples (G-08)
- 3 ground and city materials (G-06, G-09)
- 2 scope as a true second view (W-04 visuals) and red dot at infinity (W-02)
- 5 blind ranking against `target-look/` at the fixed views (5 = as good or
  better, 3 = clearly lower but coherent, 1 = placeholder look)

### 8.5 Performance and budgets — 15
- 5 draw calls and triangles under the ceilings at every view (High and Low)
- 4 60 fps on the desktop test GPU at High (or the governor holds it)
- 3 no hitch > 50 ms after the first second
- 3 a benchmark and a frame governor exist and work

### 8.6 Tests and tooling — 10
- 4 unit tests for ballistics, movement, damage, AI decisions
- 3 the benchmark prints a table at named views; F3-style overlay
- 3 the model's reports were accurate (claims match what you measured)

### 8.7 Phone build and touch — 5
- 3 APK installs and runs on Low with touch controls
- 2 playable at ≥ 30 fps on the forest map

### Tie-breakers
Fewer human nudges; earlier milestones working; honesty of reports.

## 9. Report the model must hand back

At the end (and in short at each milestone):

1. What was built, mapped to the feature IDs (done / partial / missing).
2. How to run, test, benchmark and package it.
3. The benchmark table (draw calls, triangles, frame time) at every view, both
   presets, and the device it was measured on.
4. Ballistics check: measured drop and time of flight at 300/500/800 m next to
   the sheet.
5. Known issues and anything it chose not to do, with the reason.
