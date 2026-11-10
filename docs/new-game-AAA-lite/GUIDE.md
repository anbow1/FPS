# New game close to AAA — the lite guide

The one file you read in full. Everything else is opened **only when a step
names it, and only the named section** (`grep -n '^## 6s' docs/graphics-playbook.md`,
then read that range). Never read `docs/graphics-playbook.md` whole: it is
~50 k tokens.

Target: three.js r186, WebGPU + TSL, browser and Android APK. The user's game is
in `games/new-game/DESCRIPTION.md`, photos in `games/new-game/references/`.

## 1. Working rules

- **Stack, fixed:** `WebGPURenderer` (own WebGL2 fallback, one code path; never
  `WebGLRenderer`); all shaders in TSL node materials (no `ShaderMaterial`,
  `onBeforeCompile`, `EffectComposer`); one `RenderPipeline`; strict TS, no
  `any`; Vite; game logic without three.js, fixed 60 Hz step, tested in Node.
- **Read before you write**; smallest diff; no TODO stubs; units in names
  (`speedMs`, `sunIlluminanceLux`); comments say why; tunables in one typed
  config with units and a source.
- **Evidence, not opinion:** screenshots before/after at fixed views, numbers
  from `tools/measure/`. "Should work" is not a result. Never claim what you
  did not run.
- **Budget is a contract:** no change raises frame time, loading or memory
  without numbers before/after and the user's consent. Over budget → fix with
  content, not a setting.
- **Licences:** CC0 / CC BY only, a line in `CREDITS.md`. NC or unclear → tell
  the user, do not use. Real logos, markings, brands painted out
  (`tools/assets/vehicles/scrub_marks.py`). Invented factions, no gore, no real
  weapon engineering detail.
- Downloads are untrusted: each in its own empty folder, Python with `-I`.
- Copy `shared-src/` **unchanged** (warm-up, instancing, perf, bench recorder,
  WebGPU compat, noise).
- Ask only when a wrong guess is expensive (units, deleting work, licence).
- Windows user: give PowerShell forms of commands.
- After each stage: report (§6) and **stop** until approved.

## 2. Realism rules R1–R12

1. **Asset where the eye knows the shape** (trees, buildings, vehicles, people,
   weapons, rocks, props); **code for fields** (terrain, sky, water, weather,
   scatter, grass, particles).
2. **Indirect light baked** (light maps for static, probe grid for moving).
3. **Occlusion** baked in vertex colours always; screen-space AO High only and
   after a screenshot check (r186 GTAO + reversed depth blackens faces).
4. **Motion** (mocap characters, smoke, dust, reacting plants and water) —
   judged on a real device.
5. **Detail near the eye** (from 0.45 m): edge wear, cavity dirt. Screen
   effects last.
6. **KTX2 textures**, mips at encode; normal/ORM UASTC linear, far colour
   ETC1S; `KTX2Loader.detectSupport(renderer)`, transcoder in the build.
7. **LOD:** 3 levels + impostor beyond 100 m, dithered hand-over, Meshopt.
8. **Few shader variants:** one material per kind of surface, switches as
   uniforms; static instanced meshes via `markStaticInstances`; extra cameras
   draw into a twin of the scene pass's target. State pipeline count on every
   change adding a material, instanced mesh or camera.
9. **Bake what every start computes** if profile shows > 1 s (file or worker).
10. **Pilot first** (100 × 100 m slice), then replicate.
11. **Phone is the judge**; software GPU numbers only rank runs.
12. **Honest ceiling:** good console game of a few years ago on desktop, a
    simpler consistent version on phone. Say plainly what cannot be done.

## 3. Stages (each ends with its Check, a report, a stop)

**0. Brief, bar, budget — no code.** Write `games/new-game/BRIEF.md` (features
each with an acceptance criterion, hard rules, budgets, build order, stated
assumptions); `target-look/README.md` (6–10 real photos, one line each on what
is taken; no game/film stills); `ASSETS.md` table: Category | What | Source |
Licence | Tris LOD0/1/2 | Textures | Script. At least 3 tree species, a
building module kit, 4–8 scanned ground materials. Budget table:

| Budget | High (desktop) | Low (phone) |
|---|---|---|
| Frame | 60 fps, GPU ≤ 14 ms | 60 fps with governor |
| Draw calls / triangles | ≤ 2500 / ≤ 12 M | ≤ 700 / ≤ 2 M |
| Unique materials | ≤ 120 | ≤ 80 |
| Pipelines after load | ≤ 150 target | same |
| Loading (gpu idle) | ≤ 10 s target | ≤ 20 s target |
| Build size | ≤ 80 MB | same |
| Texture memory | set after slice | set on phone |

*Check:* every feature has a criterion, every asset row a source and licence,
user approved.

**1. Skeleton and measurement.** Vite + strict TS; copy `shared-src/`.
Renderer, physical units, EV100 exposure with pre-exposure, post chain
(playbook §1): grey cube under 100 000 lx sun correctly exposed. Debug contract
(`tools/measure/README.md`): `?autostart`, `&q=high|low`, `window.__ready`,
`window.__debug.place/spot`, `[load] <stage>: <s> s` lines + total in pause
menu. Fixed bench views, Benchmark button + `?bench`, F3 overlay, frame
governor. Touch controls; APK from the first playable build (one rolling
release, not an artifact per run).
*Check:* `shots.mjs` and `load.mjs --game generic` run; tsc and tests clean;
APK starts on phone.

**2. Asset pipeline (R6–R9).** KTX2 on one texture first, measure memory and
upload vs PNG, write it down, then the rest. GLB + Meshopt, 3 LODs + impostor,
prepared only with `tools/assets/` scripts. Material library (ground layers in
a `DataArrayTexture`, ≤ 16 sampled textures per stage). Manifest + background
streaming, progress from real bytes, nothing compiles in play. One tree, one
building, one prop end to end.
*Check:* `load.mjs` before/after the three assets; no upload > 50 ms; first
phone measurement sets memory and loading budgets.

**3. Light and atmosphere (R2, R3).** Playbook §1, §4, §12.4. Sun in lux, CSM
fitted to play distance; physical sky; fog and aerial perspective on everything;
env probe from the same sky function with ground bounce. Indirect light by
time of day: fixed → Blender Cycles bake; presets → bake per preset; cycle →
probe grid updated a few probes per frame or 2–4 key bakes blended. Probe grid
as 2-D atlas of slices (3-D texture in `rtt` fails in r186 WebGPU). Contact
shadows under small objects.
*Check:* grey card at the preset's EV; undersides readable; horizon, fog and
reflections one hue at sunset; no new pipelines when time changes.

**4. Vertical slice, 100 × 100 m at final quality (R1, R5, R10).** Where the
player spends minute one. Terrain from one height function; scanned ground,
height-blended, detail < 10 m, macro variation, paths, ruts, wet bands. One of
every asset category at final quality. Look from 0.45 m and 1.7 m: nothing
showroom clean. Water if any (playbook §7). Low preset: simpler, not different.
*Check:* slice beside look-board photos, fix the 5 largest differences; budgets
met on both presets and phone; extrapolate to the full map, change plan or map
size now if it does not fit. **Stop. Nothing more is built before approval.**

**5. Whole world.** Scatter from data (cover map, slope, distance rules); one
`InstancedMesh` per kind, streamed by grid cell; buildings merged by material
per block; full → light → impostor with complementary dithering (playbook
§5.5); game objects placed via the same cover function.
*Check:* draw calls flat while moving; no frame > 50 ms across the map; no new
pipelines.

**6. Gameplay and motion (R4).** Rules as fixed-step logic with unit tests
(at least one outside reference value). Characters: skeleton, skinning with
motion vectors, mocap clips (`tools/assets/mocap`, playbook §6s), no foot
slide. Layered effects (flash, fire, smoke, dust, debris that stays), soft lit
particles, surface marks. World reacts (grass, water, branches). Positional
sound with speed of sound.
*Check:* frames seconds apart for moving things; no TRAA smear; feedback
readable < 200 ms.

**7. Phone (R11).** Low preset, 2× device pixels with TRAA, governor lowers
render scale before effects. Bench at every view + 3 min play; "Loaded in X s"
in the report.

**8. Critic loop.** Shots at fixed views at noon, golden hour, overcast beside
the look board → list differences by how fast they give the game away, with
cause and cost → fix top 5 with before/after. End when an outsider is unsure
at a 2-second glance, or the next step needs a technique outside the platform.

**Done:** every feature meets its criterion; §5 checklist on both presets;
budgets met, loading and memory measured on phone; 0 new pipelines after load,
no frame > 50 ms after second one; `CREDITS.md` complete; final report incl.
what this platform cannot do.

## 4. Engineering musts (condensed)

- **Units:** SI, 1 unit = 1 m; g 9.81, air 1.225 kg/m³, sound 343 m/s. Lights
  in lux / candela, colour from kelvin. Physical value and feel factor kept
  apart.
- **Exposure:** `exposure = 1 / (1.2 · 2^EV100)` applied to every light,
  emissive, sky. Auto exposure from GPU histogram read back async every ~6th
  frame; bright→dark ~2 s, dark→bright ~0.5 s. Tone map once (ACES, A/B vs
  AgX, record choice). Never fix dark with ambient.
- **Sky:** one sky function for dome, probe, fog, water. Flying game: Hillaire
  LUT atmosphere. Re-bake probe into the same target only when sun/weather
  changes.
- **Shadows:** one sun, `CSMShadowNode` 3–4 cascades High / 2 Low, `fade`;
  only nearby things cast. Never toggle `castShadow` or add lights in play.
- **Post chain order:** HDR pass + MRT velocity → GTAO (High, full res, before
  TAA) → TRAA → sun shafts (High) → bloom → exposure, tone map, sRGB → sharpen
  ~0.3 → HUD unbloomed. Every toggle is a uniform, never a graph change.
- **Reversed depth** when near < 0.5 m or far > 2 km; read with
  `perspectiveDepthToViewZ`.
- **Physics:** fixed step, interpolate visuals, cap steps; one approach
  (Rapier or hand integrator); real mass and inertia; projectiles integrated
  with G7 drag; aim cues use the same integrator; seeded RNG; input through a
  rebindable action layer.
- **Materials:** Standard by default, Physical only for clearcoat /
  transmission / sheen. Non-metal linear luminance 0.021–0.92; metal base =
  F0, ≥ ~#b4b4b4; paint, rust, rubber are metal 0. Wet = same material driven
  by a mask. ORM = R AO, G rough, B metal, linear. Foliage: coverage-preserving
  alpha mips; no `alphaToCoverage` without MSAA; restore `alphaTest` after
  cloning a node material.
- **Texel density:** FP weapon 20–40 px/cm, near props ~10, terrain ~5 + detail.
- **Smoothness:** build every pipeline behind the loading screen by rendering
  it (reveal one object per material/layout/instancing key, render one real
  frame, each in its own animation frame). **Never `compileAsync`.** Fill
  instanced meshes before warm-up; warm up every extra camera. Everything that
  may appear later exists from load (intensity 0). No allocation, material,
  canvas texture or light creation in play. Pipeline tracer must show 0 new.
- **Loading:** canvases drawn once use `getContext('2d', {willReadFrequently:
  true})`; static instanced meshes sized past the uniform-buffer limit so
  they share shaders (`shared-src/render/instancing.ts`); no trig in per-sample
  loops; heavy bakes on worker or GPU.
- **Governor:** drops AO, shafts, reflections, then render scale 100 → 58 %
  (42 % on phones at 2×); down fast, up slow; never recompiles.
- **Presets:** High: TRAA, GTAO, sharpen 0.3, 3–4 × 2048–4096 cascades, shafts
  24–40, translucency, impostors from ~200 m, grass ~40 m. Low: TRAA, no GTAO,
  sharpen 0.25, 2 × 1024, no shafts, impostors from ~125 m, grass ~24 m.
- **HUD:** title-safe 90 %; centre zone 30 % width, symbols only; 21:9 anchors
  to centred 16:9; feedback is shape + sound, < 200 ms; cull symbols by
  view-space `z > −0.5`.
- **Controls:** keys never invert; mouse/right thumb aims, never flies; flight
  computer on by default; every control behaviour unit-tested.
- **Audio:** positional, speed of sound, layered weapons, engines by RPM and
  load; delayed one-shots start with `gain.value = 0`.

## 5. Verification and acceptance

Run and report: `tsc --noEmit`; tests; production build served by
`tools/measure/serve.mjs` (not the dev server); headless Chromium on WebGL2
(`--use-angle=swiftshader --enable-unsafe-swiftshader`) and software WebGPU
(`--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader
--use-webgpu-adapter=swiftshader --disable-vulkan-surface`), zero console
errors; screenshots via `tools/measure/shots.mjs`; `load.mjs` before/after
anything touching materials, instancing, textures or cameras; on the phone:
bench on Low + 3 min play. Software GPU is slow: run long commands in the
background, never three browsers at once. Debug with false colour, not by eye.

Acceptance per scene and preset: photo-like exposure at noon / golden /
overcast; distance reads through atmosphere, no milky wall; shadows sharp near,
soft far, no seams or acne; no tiling, LOD pops, density rings, floating
objects; no sparkle or crawling edges; budgets met; 0 new pipelines, no hitch >
50 ms; High and Low look like one world; WebGPU and WebGL2 both run.

## 6. Report after each stage

1. *Done* — feature IDs: done / partial / missing.
2. *What changed* — files, one line each.
3. *How to run* — exact commands (dev, test, build, bench, APK).
4. *Numbers* — bench table at every view on High and Low (fps, p95 ms, CPU
   ms, draws, tris, GPU ms per pass), pipelines, gpu idle.
5. *Checks run* — which, how, screenshots.
6. *Not done / known issues* — and why.

## 7. Top traps (r186)

| Symptom | Fix |
|---|---|
| Phone stuck at "compiling"; ground vanishes on WebGPU | > 16 textures in a shader → texture arrays |
| Hitch walking through vegetation | one `InstancedMesh` per kind, not per chunk |
| Objects compile on first use / load waits a timeout | no `compileAsync`; reveal + real warm-up frames |
| Seconds per texture at first frame | `willReadFrequently: true` canvases |
| Hundreds of shader builds | static instanced meshes past uniform-buffer limit |
| Scope freezes on first use | its target cloned from the scene pass, warmed at load |
| Plants only in shadows | fill instances before warm-up |
| Scene recompiles at dusk | fixed light set, fade intensities |
| Foliage draws solid quads | restore `alphaTest` after clone; no A2C without MSAA |
| `reading 'If'` of null | `If`/`Loop`/`toVar` only inside a TSL `Fn` |
| WGSL non-uniform sampling error | explicit `.level()` computed outside the branch |
| Loop var wrong inside `If` | copy it into a `const` first |
| Signed data garbage in float target | write via `fragmentNode`, `NoBlending` |
| Line + grain on High | GTAO full res, before TAA, temporal filter |
| Depth copy format error | own `DepthTexture` with `FloatType` |
| Impostor trees upside down | `v = species + (1 − corner.y)` |
| GPU forest in rows | sin–fract hash, not TSL `hash()` on negatives |
| MRT bake fails on WebGL | name target textures like MRT outputs |
| Grass shimmer | blades ≥ 1.3 px, per-tile shift |
| Headless OK, phone fails | test WebGPU too, then the phone |
| Blurry on phones | 2× pixel ratio, TRAA + sharpen on every preset |
| CI APK upload fails | one rolling release |

## 8. Where to look (open only the section you need)

- `NUMBERS.md` — light, PBR, scale, ballistics, HUD, budget values. The PNG
  sheets in `reference-sheets/` show the same; open one only if you need the
  picture.
- `tools/measure/README.md` — debug contract and scripts.
- `tools/assets/*/README.md` — Blender scripts for vehicles, guns, people, mocap.
- `docs/graphics-playbook.md` sections (paths there point at reference games
  not in this folder; the techniques and numbers stand): §0b new game · §1
  renderer, units, post · §2 procedural textures · §3 terrain · §4 sky, sun,
  shadows · §5 vegetation (§5.5 distance/impostors, §5.6 grass) · §6 rocks ·
  §6b first person · §6c hard surface, characters · §6d–6e city night/day ·
  §6f explosions · §6g ground up close · §6h animals, enemies · §6j used
  machines · §6m–6n reference comparison, detail density · §6o scanned
  textures · §6q scanned models · §6q2 downloaded vehicles · §6r HDRI · §6s
  skinning, mocap · §6t hands · §6u guns · §6v volumetric clouds · §6w decals ·
  §6y cockpit · §6z street, breaches · §6z2 town · §6aa cheap fixes · §7 water
  (7.1 surface … 7.13 wake) · §8 phones, presets, stutter, loading (§8.4) · §9
  verification, governor, pipeline tracer · §10 coastline checklist · §11
  r186 pitfalls · §12 large worlds, flight · §13 cockpits, HUD · §14 controls,
  flight computers.
- Stronger-model work (new rendering technique, three.js internals, first
  KTX2/baked light, disputed looks after two tries) vs routine replication:
  the user decides who does what.
