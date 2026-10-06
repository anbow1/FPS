# Jet fighter — grading guide

For the person evaluating a model's build. Do not give this file to the model:
it would build to the test. The model gets
[BRIEF.md](../../../dla-modelu/games/jet-fighter/BRIEF.md), the rules and
`dla-modelu/reference-sheets/`. There is no `target-look/` for this game: judge
the graphics against `dla-modelu/rules/graphics-quality.md`. See
[../../README.md](../../README.md) for the protocol.

## 7. Verification procedure

1. `npm ci && npm run build && npm test` on a clean checkout.
2. Static checks: no `any`; no `ShaderMaterial`, `onBeforeCompile` or
   `EffectComposer`; the flight model has no three.js import and its own tests;
   no lights created after load.
3. Load on WebGPU and on the WebGL2 fallback: page or shader errors, or a load
   that never finishes, are automatic fails.
4. **Flight model.** In free flight with the debug overlay on:
   - full afterburner climb from the runway to 12 km: the turn rate and the
     controls must visibly go soft above ~11 km;
   - a sustained 9 G turn at 0.9 Mach at 3 km for 20 s: grey-out builds, tunnel
     vision, then recovery after unloading; a −3 G push shows red-out;
   - slow flight with the limiter off: a stall break and post-stall behaviour,
     recoverable; with the limiter on the AoA and G limits hold;
   - fuel burn: weigh the aircraft at take-off and after 10 minutes (overlay).
5. **Energy-manoeuvrability chart**: ask for the debug chart, compare the two
   aircraft — the large twin must out-turn at low speed (thrust vectoring), the
   stealth fighter must hold energy better at its corner speed or fight better
   in the vertical. Neither may dominate everywhere.
6. **HUD**: in a slipping, climbing turn put the flight-path marker on a ground
   feature you are flying towards; it must sit on it. Check the pitch ladder
   against the horizon in a 60° bank; heading tape against a known runway
   heading; radar altitude appears under 500 m.
7. **Radar and RWR**: sweep timing (a contact appears only when the sweep
   passes); lock and break lock by turning out of the scan volume; notch a
   pursuer at low altitude and see the contact drop; frontal detection range of
   the stealth aircraft clearly shorter than from the side; RWR tones for
   search, track and launch.
8. **Weapons**: guns with the lead pipper against a turning target; a short-
   range missile decoyed by flares and confused by the sun; a medium-range
   missile at maximum range against a manoeuvring target misses most of 5 shots
   and hits at half range; chaff defeats the radar missile, not the heat
   seeker; missile camera follows each launch.
9. **AI**: 5 duels on medium difficulty from a head-on BVR start: the AI
   manages energy, notches, uses terrain, disengages when low; it never flies
   faster or turns harder than the chart allows.
10. **Sky and terrain**: screenshots at 0, 3, 8 and 12 km altitude at morning,
    noon (broken cloud) and dusk above overcast; look all round at 12 km for a
    map edge; fly into a cloud and check the AI loses visual contact.
11. **Landing challenge**: three landings; the score reflects rate of descent,
    centreline and touchdown point; a hard landing collapses the gear or is
    scored as a crash.
12. Benchmark on High at 1440p and on Low; 5 minutes of a duel for hitches;
    first missile launch, first explosion, first flare, first afterburner must
    not hitch.
13. APK on a mid-range phone with touch controls: take off, fly, fire, land.

## 8. Scoring rubric (100 points)

**Automatic fail:** does not build; page or shader error; never reaches flight;
runtime downloads of assets; the aircraft is moved by tweens or a rigid-body
vehicle helper instead of forces.

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests
- 3 no error flood in 10 minutes of combat
- 3 every mode can be played to a result without a reload

### 8.2 Architecture and code — 10
- 3 stack rules (WebGPURenderer, TSL, one post chain, strict TS)
- 3 fixed-step flight model without three.js, typed config with units and sources
- 2 fixed light count; shaders precompiled (no hitch on first launch, flare,
  explosion, afterburner)
- 2 readability: comments say why

### 8.3 Flight model and gameplay — 25
- 8 flight model: lift curve with stall, Mach drag rise, thrust lapse with
  altitude and Mach, afterburner spool, density falloff felt above 12 km,
  dynamic-pressure-scaled controls, fuel burn changing the feel
- 4 fly-by-wire limiter and its switch; the two aircraft feel different
  (TVC at low speed on the twin)
- 3 G-effects with a tolerance pool (grey-out, tunnel vision, red-out)
- 4 radar and RWR as specified (sweep, modes, notching, stealth asymmetry)
- 4 weapons and countermeasures as specified (pipper, missile energy, decoys)
- 2 AI flies the same model and fights with energy and masking

### 8.4 Graphics — 25
- 7 LUT atmosphere valid to 15 km; aerial perspective on terrain, clouds and
  aircraft; horizon with no map edge from 12 km
- 6 volumetric clouds with parallax, lighting and shadows (billboards on Low)
- 4 terrain colour, scale and relief; runway and airbase with PBR concrete,
  paint and tyre marks
- 4 aircraft: silhouettes to the scale sheet, PBR paint and canopy, afterburner
  colour temperature, contrails, wingtip vapour, heat shimmer
- 4 cockpit modelled and lit, MFD rendering the radar picture, HUD collimated
  and crisp, no bloom on the HUD

### 8.5 Performance and budgets — 15
- 5 60 fps at 1440p High with clouds; clouds within the 2 ms slot (GPU timer)
- 4 draw calls and triangles under the ceilings at every benchmark view
- 3 no hitch > 50 ms after the first second
- 3 benchmark, F3 overlay and governor work

### 8.6 Tests and tooling — 10
- 4 unit tests: atmosphere against standard values, lift and drag curves,
  thrust lapse, sustained turn rate against the E-M chart, missile kinematics
- 3 E-M chart printed for both aircraft at several altitudes
- 3 reports accurate against what you measured

### 8.7 Phone build and touch — 5
- 3 APK on Low with touch: stick, throttle, fire, cameras
- 2 ≥ 30 fps over the airbase

## 9. Report the model must hand back

1. Every brief item with done / partial / missing.
2. How to run, test, benchmark, package.
3. Benchmark table at every view, both presets, the device.
4. The energy-manoeuvrability tables (turn rate against speed at 0, 3, 6, 9,
   12 km) for both aircraft, and the tone-map choice with its reason.
5. Screenshots at four altitudes and three presets, plus the HUD in a slipping
   turn.
6. Known issues and anything skipped, with reasons.
