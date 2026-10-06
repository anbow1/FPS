# Castaway Lagoon — grading guide

For the person evaluating a model's build. Do not give this file to the model:
it would build to the test. The model gets [BRIEF.md](../../../dla-modelu/games/castaway-lagoon/BRIEF.md), `target-look/`
and `dla-modelu/reference-sheets/`. Feature IDs and section numbers (§1–§6) below refer
to the brief. See [../../README.md](../../README.md) for the protocol.

## 7. Verification procedure

1. `npm ci && npm run build && npm test` on a clean checkout.
2. Static checks as for Field Line (no `any`, no shader patching, no three.js in
   logic, no lights created after load).
3. Load on WebGPU and on the WebGL2 fallback: any page or shader error is an
   automatic fail. Loading must finish (a hang at "compiling shaders" is a
   fail).
4. Fixed views at 1920 × 1080 High for the blind comparison: the spawn at noon;
   the same at golden hour; the outpost in a storm; the waterline looking down;
   underwater looking level and looking up; the fire at night; the boat under
   way; the jeep by day and at night with headlights.
5. Interaction script, one pass: pick up a stone and skip it (count skips);
   take the rifle and empty a magazine into the water and the sand; harvest a
   plant with the knife; open the crate; take the backpack and the lamp, walk
   and turn (the lamp swings), press L; sleep at night (wake in the morning);
   let the fire run low, throw a log in, then put one on by hand; walk into the
   lagoon until you swim, dive until out of air; swim to the border and feel the
   current; board the boat, motor out and beach it, leave it; drive the jeep to
   the waterline and try to go in; open the bonnet; headlights at night.
6. Water checks: wade and watch the wake; throw a stone and watch the rings stop
   at the shore; look from the surface at a boat's wake; confirm no water inside
   the hull; confirm the swimmer's eye rides the same chop that is drawn.
7. Benchmark table on High and Low; 3 minutes of play for hitches.
8. APK on a mid-range phone: Low preset, touch controls (dive and wood buttons
   present), 2 minutes at the beach and in the boat.

## 8. Scoring rubric (100 points)

**Automatic fail:** does not build; page or shader error; loading never
finishes; runtime downloads of assets.

### 8.1 Builds, runs, stays up — 10
- 4 clean build and tests
- 3 no error flood in 5 minutes; every interaction above works without a reload
- 3 all times of day and weathers reachable and stable

### 8.2 Architecture and code — 10
- 3 rules §2.1–2.3
- 3 deterministic headless logic; CPU wave height shared with the shader (§2.7)
- 2 fixed light count; shaders precompiled (no hitch on first fire, first
  splash, first dive, first boat ride)
- 2 readability: config with units and sources, comments say why

### 8.3 Gameplay features — 25
- 3 P-01, P-03 movement and border
- 4 P-02 swimming, diving, air (eye on the drawn chop)
- 3 P-04 stones with skipping
- 3 P-05, P-06 rifle and knife with per-surface impacts
- 3 P-07…P-11 pick-ups, inventory, crate, examine, cans, backpack
- 3 P-12…P-14 lamp, sleep, camp fire with fuel and thrown logs
- 4 P-15, P-16 boat and jeep (buoyancy, grounding, wade limit)
- 2 U-03 audio

### 8.4 Graphics vs target look — 25
- 7 water: optics, shore waves, swash and lace, caustics, FFT, ripples
  (G-02…G-07)
- 4 sky, time of day, weather, night (G-01, G-12)
- 5 vegetation, grass blades, rocks (G-08…G-10)
- 3 underwater and Snell's window (G-11)
- 6 blind ranking against `target-look/` at the fixed views

### 8.5 Performance and budgets — 15
- 5 draw calls and triangles under the ceilings at every view
- 4 60 fps desktop at High (or held by the governor)
- 3 no hitch > 50 ms after the first second
- 3 benchmark and governor work

### 8.6 Tests and tooling — 10
- 4 unit tests: terrain, inventory, stones and skipping, swimming and air,
  fire fuel, boat floating and grounding, jeep driving
- 3 a test that every interactable has a render model (a missing one must
  fail a test, not hang the game on load)
- 3 reports accurate against what you measured

### 8.7 Phone build and touch — 5
- 3 APK runs on Low with touch controls covering every action
- 2 ≥ 30 fps at the beach

## 9. Report the model must hand back

1. Feature IDs with done / partial / missing.
2. How to run, test, benchmark, package.
3. Benchmark table at every view, both presets, the device.
4. Screenshots at the fixed views of §7.4.
5. Known issues and anything skipped, with reasons.
