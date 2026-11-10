# Graphics quality contract

What "maximally realistic graphics that run smoothly at a good resolution"
means in this kit, as rules you can check. `rules/games-ts-threejs.md` is the
architecture; `docs/graphics-playbook.md` shows how each item below was built,
with the numbers that were measured. Where a game brief asks for more, the
brief wins; where it asks for less, this contract still applies.

Each item has a **Must** (the rule) and a **Check** (how you prove it before you
report it done). "Check" is not optional.

---

## 1. The quality bar in one paragraph

A screenshot should read as a photograph of a real place at a real time of day:
correct exposure (sun-lit things bright, shade blue and dark, no grey murk),
correct scale (a 10 m tree looks 10 m tall next to a 1.8 m soldier), contrast
and saturation that fall off with distance through the atmosphere (not a white
fog wall), materials that respond to light like their real counterparts
(wet looks wet, metal looks metal, paint is not plastic), and no tell-tale game
artefacts: no visible tiling, no LOD pops, no shimmering foliage or specular
sparkle, no flat-coloured sky, no square or stair-stepped edges, no hitches.
On the phone preset the picture is simpler, never different.

---

## 2. Light and colour

| Must | Check |
|---|---|
| Sun in lux, sky in lux, local lights in candela, colours from kelvin (lighting sheet). | A grey card (albedo 0.18) in noon sun meters near the preset's EV100. |
| Pre-exposure on every light, emissive and sky value. | No black or white pixels at the sun's glint on water or metal; no NaN after TAA. |
| Auto exposure with asymmetric adaptation, EV clamped per preset. | Walking from sun into a building or a cave adapts in ~2 s with no black or blown frame. |
| One tone map, ACES or AgX chosen by A/B screenshot and written down. | Fire, afterburner and sunset checked under both; choice recorded in config. |
| Sky, fog, environment probe and water reflection all come from one sky function. | At sunset the horizon, the fog on distant hills and the reflection on water are the same hue. |
| Ground bounce in the probe (ground hemisphere, albedo ≈ 0.2). | Shaded walls and trunks are lifted and slightly warm, not black. |

## 3. Atmosphere and distance

| Must | Check |
|---|---|
| Aerial perspective on every object (in-scattering and extinction), height fog in the same model. | A ridge at 2 km is bluer and lower in contrast than one at 300 m, but still readable; no milky wall. |
| Flying games: LUT atmosphere (Hillaire 2020) valid to the ceiling; the horizon never shows the map edge. | Screenshots at 0, 3, 8, 12 km altitude: sky gradient darkens with altitude, horizon haze stays continuous. |
| Clouds (where the game has them) lit from the sun side, with real parallax, casting moving shadows on ground and water. | Fly or move past a cloud: it shifts against the background and its shadow moves on the terrain. |
| Sun shafts sampled from sky pixels only (geometry cuts the beams). | Shafts through a tree line at golden hour; none through solid walls. |

## 4. Shadows

| Must | Check |
|---|---|
| Cascaded shadows split to the real play distance, faded between cascades. | No visible cascade seam walking forward; distant shadows still present on hills. |
| Penumbra sharp at contact, soft with distance; no acne, no peter-panning. | A pole on flat ground at noon and at golden hour. |
| Only nearby objects cast; impostors and far LODs do not. | Draw calls in the shadow pass grow with nearby content only. |
| Light set fixed from load; no `castShadow` toggling. | Pipeline tracer shows 0 new pipelines through dusk and dawn. |

## 5. Materials

| Must | Check |
|---|---|
| Every value inside the PBR sheet ranges (non-metal luminance 0.021–0.92, metals ≥ ~#b4b4b4, metalness 1 only for bare metal). | Static check of the config palette against the sheet. |
| Normal and ORM maps linear, base colour sRGB; ORM order R = AO, G = roughness, B = metalness. | A rough surface is not shiny and a metal is not dull; swapping the channels would show. |
| Wetness drives the same material: darker, more saturated, smoother, clearcoat; puddles mirror. | Rain on asphalt, sand at the waterline. |
| Wear and dirt in masks (edges, cavities, dust on top, mud low). | Vehicles and props close up: no showroom-clean surfaces. |
| Specular detail fades with pixel footprint (`fwidth`) so far surfaces do not sparkle. | Water and wet ground at 500 m+ show a soft sun path, not flickering single pixels. |

## 6. Terrain

| Must | Check |
|---|---|
| One height function for mesh, collision, placement, water depth. | No floating trees, no water under sand, no bullets stopping in mid-air. |
| Real landforms (ridges, valleys, saddles, erosion), not raw noise. | From the highest point the land reads as geology, and it allows masking / cover. |
| Height-blended splat in texture arrays, triplanar rock, detail normals near, macro variation far. | No visible repeat grid at any distance; cliffs not stretched; sharp at the lowest eye height. |
| Paths, ruts, wet bands, canopy shade and litter under trees from the same data. | Grass under a pine stand turns to needles and is darker. |
| Map scale (≥ 10 km): grids baked at load on worker threads, CDLOD drawn as one instanced mesh, Earth curvature. | No cracks or pops while flying; collision, altimeter and picture agree. |
| Mountains shade the land behind them and valleys see less sky (horizon-angle bake on the GPU, re-baked when the sun moves). | Low sun: ridges throw long shadows across valleys; gullies darker than summits. |

## 7. Vegetation and distance

| Must | Check |
|---|---|
| One instanced mesh per species, streamed by grid cell. | Draw calls with a forest in view stay flat as you move; no hitch entering new areas. |
| Near meshes → light meshes → impostors with dithered hand-over. | No popping in a slow pan at the LOD distances; trees at 1 km still have the right silhouette and light. |
| Grass from blades, density thinned by distance, rooted on the terrain triangles, trampled. | No paper cards, no floating or sunken blades on slopes, no visible density rings. |
| Coverage-preserving alpha mips; translucency on High. | Trees do not thin out at distance; leaves glow from behind at golden hour. |
| Wind from one source moves every plant (and bullets / smoke where the game has them). | Gust visibly travels across a field. |
| Map-scale forests generated on the GPU from the land-cover texture (instanced impostor rings, per-cell hash, stands and clearings, a top view for altitude). | No rows, no orchard grid; from 3 km up you see crowns, not edge-on cards. |
| Impostor atlas read with the right orientation (render targets are top-origin). | A forced close-up of impostors alone: trunks at the bottom. |
| Gameplay objects placed where the player can see them (queried against the same cover data). | No target, pickup or landing site inside a generated wood. |

## 8. Water (where the game has any)

| Must | Check |
|---|---|
| Fresnel (F0 ≈ 0.02), Beer–Lambert absorption per channel along the real path, scattering, refraction of the real bed. | Shallow over sand reads turquoise and clear, deep reads navy; no swimming-pool cyan. |
| Reflections of the sky from the same sky function, plus the scene on High (SSR) with a sky fallback. | Palms, banks and boats mirrored at grazing angles; no black holes in the reflection. |
| Shore waves from the bed (shoaling, refraction, breaking), foam with history (lace, not bands), swash with drying wet sand. | Frames at 0 / 5 / 20 / 60 s: waves peel along the shore, foam decays into lace, the wet line dries raggedly. |
| Caustics tied to the surface and the sun (photon splat), energy conserved. | Read the caustic target back: mean ≈ 1. |
| Interactive ripples from everything that touches the water. | Wading, a thrown stone, a hull and a shell each leave their own rings and wakes. |
| No visible tiling of wave patches (domain warp + rotated second lookup). | View from altitude: no repeat grid towards the horizon. |

## 9. Effects

| Must | Check |
|---|---|
| Particles soft (depth-faded), lit by sun and ambient, coloured by the surface (dust, spray, snow). | Smoke near a wall has no hard intersection line; dust in shade is darker. |
| Fire, muzzle flash and engines with physical colour temperature and candela values. | Checked against the lighting sheet under the chosen tone map. |
| Moving parts (rotors, wheels, tracks) handled explicitly (blur disc, motion vectors). | No ghosting in the exterior camera under TAA. |
| Rotor blur: each blade drawn as its exposure smear (angle swept in one frame) once the rotor is fast. | At 100 % rotor speed a soft disc with blade hints, no strobing spokes. |
| Tracers, flames, fireballs as emission on the overlay layer; smoke and dust lit; wreck smoke columns rise and drift. | A burning wreck reads at 2 km, at noon and at dusk. |
| Cockpit displays at constant output brightness, mipmapped, never coplanar with their bezel. | Readable at noon and dusk; no flicker, no shimmering text. |

## 10. Image stability and resolution

| Must | Check |
|---|---|
| TRAA on every preset with velocity for everything that moves (instanced, animated, vertex-displaced). | Pan across foliage: no ghost trails, no crawling edges. |
| Sharpening after TAA; render scale setting (1.0 default, up to 1.25–1.5 on High). | Texture detail survives TAA; text on signs readable. |
| High-frequency detail faded by pixel footprint (grass blades ≥ 1 px wide, ripples, specular). | No moiré or sparkle on distant grass, wire, water. |
| Device pixel ratio honoured on the desktop; phones render at 2× (not 1×), with the governor lowering render scale (to ~0.42) before effects die. | 1440p desktop and a 3× phone screen both sharp at 60 fps; canvas width / client width = 2 in phone emulation. |

## 11. Smoothness

| Must | Check |
|---|---|
| Every pipeline built behind the loading screen by rendering it (reveal per cache key + one real frame per post variant and per extra camera; no `compileAsync`). | Pipeline tracer: 0 new pipelines through weapons, each sight and scope, effects, weather, time of day, views, teleports. |
| Loading is measured and budgeted: stages logged, canvases drawn once made in memory, static instanced meshes sharing shaders, few materials. | `tools/measure/load.mjs`: the pipeline count and "gpu idle" before and after every change that adds a material, an instanced mesh or a camera; no image upload over ~50 ms. |
| ≤ 16 sampled textures per shader stage. | Count per material; test on a real phone. |
| No allocation, no material or light creation in play; GPU→CPU readbacks throttled. | 3 minutes of play: no frame over 50 ms after the first second. |
| Frame governor holds 60 fps by dropping effects then render scale, never by recompiling. | Benchmark on Low on the phone; governor label in F3 shows what it gave up. |

## 12. Presets

| Setting | High (desktop) | Low (phone, default on touch) |
|---|---|---|
| Pixel ratio | device × render scale (2 on touch screens) | 2 on touch screens (an opt-in "Fast" preset at 1) |
| TRAA / GTAO / sharpen | on / on (full res, before TAA) / 0.3 | on / off / 0.25 |
| Governor floor (render scale) | 0.58 | 0.42 |
| Sun shafts | 24–40 samples | 0 |
| Shadow cascades × size | 3–4 × 2048–4096 | 2 × 1024 |
| Leaf translucency | on | off |
| Near crowns / impostors from | ~110 / ~200 m | ~60 / ~125 m |
| Grass blades per tile, range | ~700, ~40 m | ~300, ~24 m |
| Water: SSR / caustics / FFT | on / 512² / 256² | off / 128² / 128² |
| Environment probe | 256 px | 128 px |

## 13. Verification you must run (and report)

1. `tsc --noEmit` clean, unit tests green.
2. Production build served statically (not the dev server).
3. Headless Chromium on **both** backends:
   - WebGL2: `--use-angle=swiftshader --enable-unsafe-swiftshader`;
   - WebGPU (software): full Chromium with `--enable-unsafe-webgpu
     --enable-features=Vulkan --use-vulkan=swiftshader
     --use-webgpu-adapter=swiftshader --disable-vulkan-surface`; if the device
     is lost when the canvas is configured, replace
     `GPUCanvasContext.configure/getCurrentTexture` with an offscreen texture in
     a test-only init script — shaders still compile and errors still surface.
   Zero page errors, zero console errors, the game reaches play.
4. Look at screenshots at the fixed benchmark views (`tools/measure/shots.mjs`,
   the same views before and after); for anything that moves, frames several
   seconds apart.
5. Debug with false colour, not by eye: write the quantity you doubt (a hit
   mask, a depth gap, a weight) into the output and look at it.
6. Benchmark table before and after any performance change; the loading
   report (`tools/measure/load.mjs`) before and after anything that touches
   materials, instancing, textures or cameras.
7. On the real phone: the benchmark on Low, and three minutes of play.

## 14. Acceptance checklist (every scene, every preset)

- [ ] Exposure and contrast like a photograph at noon, golden hour, overcast
      (and night where the game has it).
- [ ] Atmosphere: distance reads through colour and contrast; no milky wall,
      no map edge.
- [ ] Shadows sharp near, soft far, no seams, no acne, no swimming.
- [ ] No tiling, no LOD pops, no density rings, no floating objects.
- [ ] No sparkle, moiré or crawling edges in motion.
- [ ] Water (if any): shallow → deep transition, foam only where waves break,
      caustics on the bed, real reflections.
- [ ] Budgets met at every benchmark view, both presets.
- [ ] 0 new pipelines after loading; no hitch > 50 ms after the first second.
- [ ] Loading: stage times logged, the pipeline count stated and justified.
- [ ] High and Low look like the same world.
- [ ] WebGPU and WebGL2 both run without errors.

## 15. Never again — the traps that cost the most time

| Symptom | Cause | Fix |
|---|---|---|
| Stuck at "compiling shaders" on phones; ground vanishes on desktop WebGPU | more than 16 textures in one shader | texture arrays; count bindings |
| Hitch every few steps through vegetation | one `InstancedMesh` per chunk = one shader build each | one streamed mesh per kind |
| Hidden or later objects compile on first use | `compileAsync` skips hidden / culled objects and the post pass | reveal one per cache key, render a real frame, in separate animation frames |
| Every load waits out a timeout at "compiling shaders" | `compileAsync` hangs after its first pipeline (r186, WebGPU) | no precompile call; warm-up frames only |
| Seconds per texture at the first frame | a GPU-backed 2D canvas is read back when copied into a texture | `getContext('2d', { willReadFrequently: true })` for canvases drawn once |
| Hundreds of shader builds for a few dozen materials | each instanced mesh under 1024 instances has its own named uniform buffer | static meshes get capacity past the uniform-buffer limit (shared vertex attribute path) |
| The first look through a scope freezes the game | its target differs from the scene pass's, so everything builds again | a target cloned from the scene pass's, same MRT; warm it up at load |
| CI builds the APKs and then fails | an artifact per run filled the storage quota | publish to one rolling release |
| Instanced plants visible only in shadows | precompiled with `count = 0` | fill before compiling |
| Whole scene recompiles at dusk | `castShadow` toggled or a light added | fixed light set, fade intensities |
| Hitch on every sky re-bake | new PMREM target per bake | re-bake into the same target |
| Cloned foliage draws solid quads | node material clone loses `alphaTest` | restore it |
| Leaves solid with `alphaToCoverage` | A2C without MSAA disables the alpha test | leave A2C off with TAA |
| `Cannot read properties of null (reading 'If')` | `If` / `Loop` / `toVar` outside a TSL `Fn` | build that code inside `Fn` |
| WGSL error: sampling in non-uniform control flow | implicit-LOD `texture()` inside `If` | explicit `.level()` computed outside the branch |
| A branch built in an unrolled loop uses the last loop value | TSL runs an `If` body when the shader is built | copy the loop variable into a `const` first |
| Signed data in a float target turns to garbage | `colorNode` clamps at 0 and forces alpha | write with `fragmentNode`, `NoBlending` |
| Screen-wide line and grain on High only | GTAO at reduced resolution with reversed depth; AO after TAA | GTAO full resolution, before TAA, temporal filtering |
| Depth copy fails every frame (`depth32float` vs `depth24plus`) | shared viewport depth copy has the wrong format for reversed depth | own `DepthTexture` with `FloatType` |
| Water pipeline invalid after adding a screen-space march | every viewport texture node keeps its own copy and binding | one base node read through `.sample(uv)` clones |
| Square specks in a procedural texture | features painted as whole hash cells | soft rotated shapes inside each cell |
| Grass shimmer and "static" on a green surface | blades thinner than a pixel; identical tiles; self-shadow acne | ≥ 1.3 px width, per-tile shift, shadow lift by distance |
| Foam reads as paving stones | Worley cell edges | lace texture (holes of many sizes, domain-warped) |
| Whole swash band reflects the sky as a white strip | wet film too smooth | roughness ~0.14 on the film |
| Headless tests pass, phone fails | software renderers allow 32 textures and lose no device | test WebGPU too, then the real phone |
| "Low resolution" picture on phones | pixel ratio capped at 1 on touch, FXAA on Low | 2× on phones, TRAA + sharpen on every preset, deeper governor steps |
| Distant trees stand on their crowns | impostor rows read bottom-up; render targets are top-origin | `v = species + (1 − corner.y)` |
| GPU forest grows in rows | TSL `hash()` casts negative seeds to `uint` | sin–fract hash, full-cell jitter |
| MRT bake fails on WebGL ("missing fragment shader outputs") | target textures not named like the MRT outputs | name them (`albedo`, `normal`, …) |
| Cockpit displays flicker | screen coplanar with its bezel | 3–4 mm proud; mipmaps |
| Targets nobody can find | parked inside a generated forest | place by the cover data, on open ground |
