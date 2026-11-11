# A new game close to AAA — guidelines and step-by-step instructions

The user describes **the kind of game, its rules and its surroundings**. A model
working from this set of guidelines builds the game as close to AAA quality as
the platform allows (three.js r186, WebGPU + TSL, a browser and an Android APK),
and measures it at every step.

The document has two parts: the user fills in **A** (five minutes), the model
carries out **B**. The technical rules are in `AGENT.md`,
`rules/games-ts-threejs.md` and `rules/graphics-quality.md`; how each technique
was built is in `docs/graphics-playbook.md`. This file says **in what order and
to what bar**, and overrides the others only where it speaks about the order of
work.

Start: copy the whole `docs/new-game-AAA/` folder into an empty project folder —
it holds everything needed (its `README.md` leads through three steps). Fill in
`games/new-game/DESCRIPTION.md`, add photographs to
`games/new-game/references/`, paste `FIRST-MESSAGE.md` to the model. The
guidelines assume no particular model: any model that can read files, run
commands and look at screenshots can follow them.

---

## Rules for realism

What a screenshot tour of five reference games and their loading measurements
showed. Each rule has its reason; the stages below refer to them by number
(R1–R12).

**What brings realism — in this order**

- **R1. An asset where the eye knows the shape; generation where there is a
  field, a phenomenon or a distribution.** Trees, buildings, vehicles, people,
  weapons, rocks and props from models and scans; terrain, sky, water, weather,
  scatter, grass and particles from code. The widest gap in the reference games
  was whatever code still generated: tree crowns, flat repeating façades,
  uniform ground, smooth cockpits.
- **R2. Indirect light.** One environment probe for the whole world gives black
  undersides and flat interiors. Bounced light is baked to files (light maps
  for static architecture, a grid of probes for moving objects): no cost per
  frame, but it needs a fixed time of day or several bakes (presets, key frames
  of a day cycle).
- **R3. Occlusion and contact shadows.** Occlusion baked into the model (vertex
  colours) always. Screen-space occlusion and contact shadows cost frame time:
  on the High preset only, and only after a screenshot check (three r186's GTAO
  with a reversed depth buffer blackens faces turned toward the camera — the
  reference games run without it).
- **R4. Motion.** A screenshot forgives more than play does: characters animated
  from real movement, smoke, dust, destruction, plants and water that react.
  Judged on a real device, never on a software GPU.
- **R5. Density of detail near the eye**: the ground from 0.45 m up, wear on
  edges, dirt in cavities. Screen effects come last.

**What must come first — the pipeline (otherwise every asset lengthens the start)**

- **R6. Compressed textures (KTX2).** Every texture file in KTX2, mipmaps made
  at encode time; normal and ORM maps in UASTC as linear data, far colour maps
  in ETC1S; foliage mipmaps keeping their alpha coverage. Decoding JPEG or PNG
  to RGBA8 takes about four times the memory and upload of a block format.
  Loader: `KTX2Loader().detectSupport(renderer)` after `renderer.init()`, no
  transcoder path (three ships its own into the build; the APK works offline).
  Measured in the reference games: ETC1S where it holds ≥ 40 dB PSNR (≥ 45 for
  first-person), else UASTC; normal maps always UASTC. UASTC is 8 bits a texel
  and packs only ~1.5×, so a detailed model grows 4–5× on disk: keep KTX2 where
  it saves ≥ 10 MB of GPU memory per MB of file (`tools/assets/ktx2_glb.mjs`,
  `bake_atlases.mjs`; playbook §8.4).
- **R7. Levels of detail.** Three levels plus an impostor for everything seen
  from more than 100 m; switched by size on screen, handed over with
  complementary dithering; meshes compressed (Meshopt), each further level's
  textures half the size. **Shadow cascades draw every caster again**, once
  per cascade — measured 60–80 % of a frame's triangles in a city, a forest and
  a bay: the coarsest level casts the shadow from a layer only the shadow
  cameras see (no draw call added; `tools/assets/shadow_mesh.mjs` for opaque
  scans). Many small meshes or terrain chunks cost draw calls, not triangles:
  merge per material after the bake, far chunks per small region (`tools/measure/passes.mjs`
  shows where calls and triangles go).
- **R8. Fewer shader variants.** One material per *kind* of surface with its
  switches as uniforms and attributes, not a material per prop; static
  `InstancedMesh` objects marked with `markStaticInstances`; extra cameras
  (scope, mirror) drawing into a twin of the scene pass's target. The pipeline
  count is stated with every change that adds a material, an instanced mesh or
  a camera.
- **R9. Bake what every start computes.** Height grids, scatter, procedural
  textures: if the profile (`tools/measure/profile.mjs`) shows more than a
  second — into a file, or onto a worker thread.

**How to work**

- **R10. A pilot first, then replication.** One map (or a 100 × 100 m slice)
  taken to the end and measured; only the pilot's numbers say how many assets
  fit the loading and memory budgets.
- **R11. The budget is a contract, the phone is the judge.** No change raises
  frame time, loading time or memory without a number before and after and the
  user's consent. Numbers from a software GPU rank runs on one machine; the
  real ones come from the benchmark and the "Loaded in X s" line on the phone.
- **R12. An honest ceiling.** Full AAA in a browser on a phone will not happen:
  the memory is not there, nor techniques such as virtualised geometry and ray
  tracing. The reachable target: the look of a good console game of a few years
  ago on a desktop, and a simpler, consistent version of it on the phone. What
  cannot be done is said plainly.

**The quality bar — what gives a picture away** (screenshot tours of five
games; check at the fixed views of Stages 4 and 8, High and Low). First find
the pixel's owner (hide one system at a time, meter exposure): half of the
causes guessed from screenshots were wrong.

| Look for | Usual cause → fix |
|---|---|
| Burnt-out sunflecks, pumping brightness | eye opening too far in shade → outdoors ≤ 2.5 stops under the preset |
| Black undersides of roofs, eaves | one dark material on every face → the underside's own material, never ambient |
| Origami trees, half-metre leaves | leaf texture at card scale → several small sprays per card, leaves 5–15 cm |
| Pale dots in far forests | impostors mirroring the sky → impostors matte (`specularIntensity: 0`) |
| Violet ground under clouds | only blue sky in the shade → cloud shadow keeps ~15 % of the sun |
| Water meets grass on a line | no bank → wet silt band, lighter shallows |
| Lilac or grey zenith | haze tinting the whole sky → zenith Rayleigh, haze toward the horizon |
| Flat asphalt, walls, ground | one tone → wear at two scales (~25 m, ~3 m) and roughness with it; photo sets |
| Grass in rows, a colour step at its edge | grid, own colour → jitter, tint from the ground, blades ≥ 1.3 px |
| Grey clay cockpits, interiors | an imported model's bare inside → texture or replace it |
| People like robots or dolls | capsules → real bodies (MPFB), no two alike, mocap |
| Everything clean and new | → edge wear, cavity dirt, decals, debris that stays (R5) |

---

## Part A — what the user writes

Paste and fill in. Keep it short; the model asks only where a wrong guess would
be expensive.

```markdown
# Game description

## 1. Kind of game
Genre and camera (FPS / third person / vehicle / flight / isometric): …
One session lasts: … min. The player: alone / with bots.

## 2. Rules
What the player does for thirty seconds (the game loop): …
Goal, and how the game is won or lost: …
Opponents or obstacles: …
What must NOT be in it (e.g. blood, real brands): …

## 3. Surroundings
Place (e.g. a fishing port on a fjord, in winter): …
Size of the world (m × m, or "a small arena"): …
Time of day and weather: fixed … / a cycle … / presets …
Three things that should impress: …

## 4. Devices
Desktop (GPU): …   Phone (model): …   Controls: keyboard + mouse / touch / gamepad

## 5. References and materials
Photographs of the place or the mood (my own, or licensed): files in `references/` beside this description …
Models or textures I supply (with their licence): …
May the model download CC0 / CC BY assets itself: yes / no

## 6. Priority when a choice must be made
[ ] looks  [ ] smoothness on the phone  [ ] short loading  [ ] size of the world
(number them 1–4)
```

---

## Part B — what the model does

### Working rules (for the whole project)

1. The stack is not up for discussion: `WebGPURenderer` (one code path, its own
   WebGL2 fallback), every shader in TSL, one `RenderPipeline`, strict
   TypeScript without `any`, Vite, game logic free of three.js at a fixed step,
   an APK through a WebView.
2. **Budget before content.** The budget table of Stage 0 is a contract: going
   over it is a defect to fix with content (less, simpler, a nearer level of
   detail), not with a setting.
3. **Evidence, not opinion**: a screenshot at the fixed views before and after,
   numbers from `tools/measure/` and from the benchmark. "It should work" is
   not a result.
4. **Licences**: CC0 and CC BY only, a line in `CREDITS.md` going in with the
   file. Report an NC or unclear licence to the user and do not use the asset.
   Paint out real marks, logos, numbers and insignia (`scrub_marks.py`).
5. Downloaded files are untrusted: each into its own empty folder, Python run
   with `-I`.
6. After each stage, a report in the format of `START.md`, and **stop** — the
   next stage starts on approval, or when every "Check" of the stage passes.
7. Ask only where a wrong guess is expensive (a unit convention, deleting work,
   a licence). Otherwise choose sensibly and write the choice in a comment.

### Stage 0. Brief, bar and budget (no code)

**Do**

1. Read `AGENT.md` and both rules files; look at the sheets in
   `reference-sheets/` and at everything the user put in
   `games/<name>/references/`.
2. From the user's description write `games/<name>/BRIEF.md`: what is being
   built, the hard rules, **a list of features each with its acceptance
   criterion**, the budgets, the build order. Whatever the description does not
   say goes in as a stated assumption.
3. **A look board** (`games/<name>/target-look/README.md`): six to ten
   reference photographs of real places (the user's, or CC0), each with one
   sentence on what is taken from it: light, scale, density, palette. This is
   the bar for the critic loop of Stage 8. No stills from games or films.
4. **The budget table** — fill it in and paste it into the brief. Starting
   values (change them with a reason):

   | Budget | High (desktop) | Low (phone) |
   |---|---|---|
   | Frame | 60 fps, GPU ≤ 14 ms | 60 fps with the governor |
   | Draw calls / triangles | ≤ 2500 / ≤ 12 M | ≤ 700 / ≤ 2 M |
   | Materials (unique) | ≤ 120 | ≤ 80 |
   | Pipelines after loading | target ≤ 150, measured | the same |
   | Texture memory on the GPU | set after measuring the slice | set after measuring on the phone |
   | Loading ("gpu idle") | target ≤ 10 s | target ≤ 20 s |
   | Build size | target ≤ 80 MB | the same build |

   The loading and memory targets are starting proposals: the reference games
   have no firm phone numbers yet. The first measurement on the phone (Stage 2)
   turns a target into a budget.
5. **An asset plan** (`games/<name>/ASSETS.md`) — a table *before* any code:

   | Category | What | Source | Licence | Triangles LOD0/1/2 | Textures | Script |
   |---|---|---|---|---|---|---|

   The split (R1): **asset** — trees and shrubs (at least three species, two or
   three variants each), buildings (a kit of modules: wall, window, door,
   corner, roof, details), vehicles, weapons, people, rocks, hero props, four
   to eight ground materials from scans; **generated** — terrain, sky, clouds,
   water, weather, scatter, grass from blades, particles, sound.

**Check:** the brief has an acceptance criterion for every feature; every row of
the asset plan has a source and a licence; the user has approved the brief, the
look board and the budget. **Write no code before that approval.**

### Stage 1. Skeleton and measurement (before anything looks good)

**Do**

1. A Vite + strict TypeScript project; copy the files in `shared-src/`
   **unchanged** (pipeline warm-up, shared shaders for instances, measurement,
   noise).
2. Renderer, physical units, exposure from EV100 with pre-exposure, the post
   chain (playbook §1). A grey cube on a grey plane under a 100 000 lx sun must
   come out correctly exposed.
3. **The debug contract** (`tools/measure/README.md`): `?autostart`,
   `&q=high|low`, `window.__ready`, `window.__debug.place/spot`,
   `[load] <stage>: <s> s` lines and their total in the pause menu.
4. Fixed benchmark views (`app/bench.ts`), a Benchmark button, the F3 overlay,
   the frame governor.
5. Touch controls and **an APK from the first playable build** (the workflow
   publishes one rolling release, not an artifact per run).

**Check:** `shots.mjs --game generic` and `load.mjs --game generic` run;
`tsc --noEmit` and the tests are clean; the APK installs and starts on the phone.

### Stage 2. The asset pipeline (before the first model goes in) — R6, R7, R8, R9

**Do**

1. **Compressed textures (KTX2)** with mipmaps made at encode time; normal and
   ORM maps in UASTC as linear data, far colour in ETC1S (rules §3.5). Loader:
   `KTX2Loader` with `detectSupport(renderer)`, the Basis transcoder in the
   build (offline in the APK). *The reference games do not have this yet: build
   it on one texture, measure memory and upload time against PNG/JPEG, write
   the result down — only then run the rest through.*
2. **Models**: glTF/GLB, Meshopt compression, **three levels of detail plus an
   impostor** for everything seen from more than 100 m; prepared only with the
   scripts in `tools/assets/` (scale in metres, axes, moving parts, occlusion,
   texture size, marks painted out).
3. **A material library**: one material per *kind* of surface with its switches
   as uniforms and attributes, not a material per prop; ground layers in a
   `DataArrayTexture`; at most 16 sampled textures per shader stage.
4. **A manifest and streaming**: a list of files with size, priority and
   radius; a progress bar from real bytes; what is far loads in the background
   without a hitch (nothing new compiles in play — the pipeline variant exists
   from the start).
5. Take one tree, one building and one prop through the whole pipeline as a
   test.

**Check:** the `load.mjs` report (pipelines, uploads, gpu idle) before and after
adding the three test assets; no upload over 50 ms; texture memory written
down; **the first measurement on the phone** — set the memory and loading
budgets from it.

### Stage 3. Light and atmosphere — R2, R3

**Do** (playbook §1, §4, §12.4)

1. The sun in lux with shadow cascades fitted to the real play distance; a
   physical sky; fog and aerial perspective on every object; an environment
   probe from the same sky function, with ground bounce.
2. **Indirect light — choose by the brief's time of day:**
   - *a fixed time of day*: a bake in Blender (Cycles) into light maps for
     static architecture and into a probe grid for moving objects; no cost per
     frame;
   - *presets of time of day*: a bake per preset, switched by a uniform;
   - *a smooth cycle*: a probe grid recomputed in the background (a few probes
     per frame), or two to four key bakes blended over time — never everything
     rebuilt in one frame.
   Keep the probe grid as a 2-D atlas of slices (a 3-D texture in an `rtt`
   pass fails in r186 on WebGPU — playbook §11).
3. **Occlusion**: baked into models (vertex colours) always; screen-space
   occlusion on High only, and only after a screenshot shows it does not
   blacken faces turned toward the camera (the known fault of GTAO in r186
   with a reversed depth buffer).
4. Contact shadows under small objects (occlusion blobs in the ground shader,
   or a short depth march on High).

**Check:** a grey card in the sun at the preset's EV; an underside and an
interior readable, not black; horizon, fog and reflections the same hue at
sunset; no new pipelines when the time of day changes.

### Stage 4. The vertical slice — 100 × 100 m at final quality — R1, R5, R10

The most important stage. Choose the place where the player spends the first
minute.

**Do**

1. Terrain from one height function; ground from scans, height-blended, with
   detail within 10 m and macro variation; paths, ruts, wet bands.
2. Every category of the asset plan, one instance each at final quality: a tree
   of every species, the building modules put together into one house, a
   vehicle, a character, a weapon, rocks, ten to twenty props.
3. **Density near the eye**: look at the picture from 0.45 m and from 1.7 m.
   Edges carry wear, cavities dirt, flat faces dust; nothing is showroom clean.
4. Water, if the brief has any (playbook §7).
5. The Low preset of the same slice: simpler, not different.

**Check**

- Screenshots of the slice beside the photographs of the look board, at the
  same time of day: write down the five largest differences and remove them
  before going on (this is the first round of the loop in Stage 8).
- Frame budgets met in the slice on both presets; a test on the phone.
- Extrapolation: "the whole map is N such slices within sight" — work out draw
  calls, triangles, memory and loading for the full map. If they do not fit
  the budget, change the asset plan or the size of the world **now**.

**Stop and report. The rest of the world is built only after the slice is approved.**

### Stage 5. The whole world

**Do**

1. Plants and props scattered from data (a cover map, rules of slope and
   distance), not by hand; one `InstancedMesh` per kind, streamed by grid
   cell; the static ones marked with `markStaticInstances`.
2. Buildings from modules merged by material into one mesh per block.
3. Distance: full models → light ones → impostors, handed over with
   complementary dithering (playbook §5.5); nothing pops.
4. Game objects (targets, pickups) placed through the same cover function the
   renderer uses.

**Check:** draw calls flat while moving; `load.mjs` — pipelines and gpu idle
within budget; a flight or a walk across the map without a frame over 50 ms;
no new pipelines.

### Stage 6. Gameplay and motion — R4

**Do**

1. The brief's rules as logic at a fixed step, with unit tests (physics,
   ballistics, flight — with at least one value from an outside source).
2. Characters: a skeleton, skinning with motion vectors, clips of real movement
   (`tools/assets/mocap`, playbook §6s); clips blended, feet that do not slide.
3. Effects in layers: flash, fire, smoke, dust, debris that stays; particles
   soft and lit; marks left on surfaces.
4. The world reacts: grass bends, water ripples, branches and dust answer a
   blast and a passing vehicle.
5. Positional sound with the speed of sound, layered weapons and engines.

**Check:** frames taken apart in time for everything that moves; no TRAA
smearing on characters and rotors; feedback readable within 200 ms.

### Stage 7. The phone — R11

The Low preset on the target phone: twice the device pixels with TRAA, the
frame governor lowering render scale before effects. The benchmark at every
fixed view and three minutes of play. The pause menu's "Loaded in X s" line
goes into the report. The memory and loading budgets of Stage 2 must hold.

### Stage 8. The critic loop (repeat until the end criterion)

1. Screenshots at the fixed views, at noon, at golden hour and under overcast,
   beside the photographs of the look board.
2. List the differences, sorted by how quickly each gives a game away; for each,
   its cause in code or asset and what fixing it costs against the budget.
3. Fix the first five; each fix with a screenshot before and after, and numbers.
4. **The end**: when an outsider, looking for two seconds at a reduced
   screenshot, is not sure whether it is a photograph — or when the next round
   needs a technique outside the platform. Then write plainly what is left and
   why.

### Definition of done

- [ ] Every feature of the brief meets its acceptance criterion.
- [ ] The scene acceptance checklist of `rules/graphics-quality.md` §14 on both
      presets.
- [ ] The budgets of Stage 0 met at every fixed view; loading and memory
      measured on the phone.
- [ ] No new pipelines after loading; no frame over 50 ms after the first second.
- [ ] `CREDITS.md` complete; no real markings.
- [ ] A final report: what was done, the numbers, what cannot be done on this
      platform.

### Dividing the work between models

One model can do all of it — that is what a model comparison looks like. With
two tiers of models available, divide it like this:

| The stronger model | The lighter model (following `ROUTINE-WORK.md`) |
|---|---|
| Stage 0 (brief, budget, asset plan) | downloading and preparing assets with the scripts |
| the first instance of each part of the pipeline (Stage 2) | running the remaining files through the pipeline |
| indirect light (Stage 3) | measurements, screenshots, reports |
| the vertical slice (Stage 4) | replicating the slice across the world (Stage 5) to its pattern |
| judging in the critic loop | fixes with a known cause |

### What not to do

- Do not start with screen effects; do not add a render pass to cover a weak
  asset.
- Do not build the whole map at sketch quality with a plan to "polish later".
- Do not add a model without levels of detail, a texture without compression,
  a material without checking the pipeline count.
- Do not call `renderer.compileAsync`; do not create a material, a canvas
  texture or a light during play.
- Do not judge driving or flying from a browser without a GPU.

---

## Appendix: what comes after this plan (techniques and engines)

**In the present stack (three.js + WebGPU)** — once the game is finished to this
plan, in order of gain:

| Technique | What it gives | Cost / condition |
|---|---|---|
| Visibility selection on the GPU (a compute shader and indirect drawing) | many times more objects for the same number of draw calls | WebGPU only; the WebGL2 fallback keeps the present path |
| Temporal upscaling (render at 50–67 % and rebuild full resolution from history) | headroom for everything else, most of all on the phone | your own implementation on top of TRAA; a browser has no ready DLSS or FSR |
| Volumetric fog in a view-space grid, shadows in smoke | depth in the scene, light in a forest and a city | High; a few milliseconds |
| Screen-space reflections beyond water (wet asphalt, glass) with a probe fallback | the realism of a city and of rain | High |
| Virtual texturing of terrain | unique detail over kilometres without the memory | a large project |
| Skin, hair, cloth (subsurface scattering, anisotropy, sheen) | close-ups of characters | per material, moderate |
| Particles and simulations in compute shaders | smoke, dust, debris in thousands | WebGPU only |

**Changing engine** makes sense only once the browser and the phone stop being
the target:

| Engine | What it brings | What is lost |
|---|---|---|
| Unreal Engine 5 | virtualised geometry (Nanite), dynamic indirect light (Lumen), virtual shadow maps, ready libraries of scans and characters — the actual road to AAA on desktop and console | the browser; the work happens in an editor on binary files, which a language model cannot build by itself the way it builds code; on a phone most of these techniques are switched off |
| Unity 6 (HDRP on desktop, URP on phones) | a mature asset pipeline, light baking, export to many platforms | much the same: the editor is at the centre; the highest quality (HDRP) does not run on a phone |
| Godot 4 | scenes and scripts as text — a model can write them; dynamic indirect light in the desktop renderer; free | a lower ceiling than Unreal; in the browser only the simplified renderer |
| PlayCanvas / Babylon.js | browser engines with an editor, light-map baking and compression included | the same ceiling as today (the same browser); the gain is tooling, not picture |

Engines change fast: check the current versions before deciding (above all,
export to the browser through WebGPU). The conclusion for this kind of project:
as long as the game must run in a browser and on a phone and be built by a
model, the gain is in the stages of this plan, not in a change of engine.
