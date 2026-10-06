# ‹Game› — grading guide (template)

Copy this for a new brief. Keep the structure and the point weights so results
compare across games; replace every ‹…›. Do not give the finished guide to the
model.

## 7. Verification procedure

1. `npm ci && npm run build && npm test` on a clean checkout.
2. Static checks: no `any`; no `ShaderMaterial`, `onBeforeCompile` or
   `EffectComposer`; game logic has no three.js import; no lights created after
   load; ‹game-specific static check, e.g. one draw per tree species›.
3. Load on WebGPU and on the WebGL2 fallback: page or shader errors, or a load
   that never finishes, are automatic fails.
4. Fixed views at 1920 × 1080 High for the blind comparison: ‹the benchmark
   views + the signature views of this game›.
5. ‹The core mechanic, exercised against numbers from the sheets or the brief.›
6. ‹Opponents / AI behaviour, each claim of the brief tried once.›
7. ‹The signature graphics feature: what to look at, at which times of day.›
8. Benchmark on High and Low; 3–5 minutes of play for hitches; the first use of
   every effect must not hitch.
9. APK on a mid-range phone with touch controls: ‹the core actions›.

## 8. Scoring rubric (100 points)

**Automatic fail:** does not build; page or shader error; never reaches play;
runtime downloads of assets; ‹the one thing that would make it a different
game›.

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests
- 3 no error flood in 5–10 minutes of play
- 3 every mode can be played to a result without a reload

### 8.2 Architecture and code — 10
- 3 stack rules (WebGPURenderer, TSL, one post chain, strict TS)
- 3 fixed-step logic without three.js; typed config with units and sources
- 2 fixed light count; every shader precompiled
- 2 readability: comments say why

### 8.3 Gameplay features — 25
- ‹split 25 points over the brief's feature groups; give the core mechanic
  the largest share and tie points to measurable acceptance criteria›

### 8.4 Graphics — 25
- ‹split ~19 points over the graphics-quality areas this game stresses›
- ‹~6 points for a blind ranking against `target-look/` if it exists›

### 8.5 Performance and budgets — 15
- 5 60 fps on the desktop at High (or held by the governor); the signature
  feature inside the 2 ms slot
- 4 draw calls and triangles under the ceilings at every benchmark view
- 3 no hitch > 50 ms after the first second
- 3 benchmark, F3 overlay and governor work

### 8.6 Tests and tooling — 10
- 4 unit tests for the core models with outside known-good values
- 3 debug overlays and tables the brief asks for
- 3 reports accurate against what you measured

### 8.7 Phone build and touch — 5
- 3 APK on Low with touch controls for every core action
- 2 ≥ 30 fps at the heaviest view

## 9. Report the model must hand back

1. Every brief item with done / partial / missing.
2. How to run, test, benchmark, package.
3. Benchmark table at every view, both presets, the device.
4. ‹The model-specific numbers: ballistics, flight, rotor, ...›
5. Screenshots at the fixed views.
6. Known issues and anything skipped, with reasons.
