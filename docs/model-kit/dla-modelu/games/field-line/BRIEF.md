# Field Line — brief

This is the task. Build the game described below. The images it refers to are in
`target-look/` (next to this file) and the binding reference sheets in
`../../reference-sheets/`.

## 1. What to build

A realistic single-player FPS in **TypeScript + three.js**, running in desktop
Chromium and, packaged, as an Android app. One soldier with an assault rifle, a
bolt-action sniper rifle and a pistol, med kits, ammo packs and grenades,
fighting AI infantry squads on three maps:

- **Range** — a shooting range with steel targets from 100 to 800 m, for zeroing
  and feel. Build it first; it is your test bench.
- **City block** — 400 × 400 m, four enterable buildings with interiors,
  stairwells and rooftops, asphalt, kerbs, brick, glass, wrecked cars, sight
  lines of 30–150 m, a wet-street variant.
- **Forest ridge** — 800 × 800 m of pines and birches on rolling ground, a dirt
  track, rock outcrops, a ruined farm, and a small lake with a pebbly shore and
  reeds; sight lines of 100–700 m so the sniper rifle earns its place.

Three modes: **Range**, **Skirmish** (clear every squad), **Extraction** (reach
a point, hold it 60 s against waves, leave).

Everything is generated in code: geometry, textures, sounds. No downloaded
models, textures or audio files.

The images in `target-look/` show the quality bar. Match their mood, scale,
density and light, not their exact layout. The sheets in `../../reference-sheets/`
are binding numbers: lighting (lux, EV100, colour temperature), PBR material
values, human and object scale, ballistics, HUD zones and the performance
budget.

## 2. Platform and hard rules

1. TypeScript strict, Vite, no `any`. SI units in names (`speedMs`, `dtS`,
   `rangeM`, `lux`, `ev100`). Comments say *why*.
2. Renderer: three.js **`WebGPURenderer`** with its own WebGL2 fallback — one
   code path. All shaders in **TSL** node materials. No `ShaderMaterial`,
   `onBeforeCompile`, `ShaderChunk` patches or `EffectComposer`.
3. One post chain (`RenderPipeline`): HDR scene pass with a velocity MRT → TRAA
   (every preset) → GTAO (High) → sun shafts → bloom → exposure + ACES + sRGB
   once, at the end → sharpen (0.3 High, 0.25 Low).
4. Physical light: sun and sky in lux, lamps in candela, exposure from EV100
   with auto exposure (about 2 s to adapt between a noon street and an
   interior), pre-exposure on every light so FP16 never overflows.
5. Logic is headless and deterministic: a fixed 60 Hz step, render interpolates.
   Game logic never imports three.js. A seeded RNG drives every map.
6. A **fixed light count** from the first frame (toggle intensity, never add or
   remove lights; never toggle `castShadow`), and every shader compiled behind
   the loading screen: no hitch the first time something is seen or fired.
7. Collision for bullets and grenades uses the logic's own simple shapes
   (boxes, capsules, trunk cylinders), never render geometry.
8. A Low and a High preset, a frame governor that lowers render scale (and
   switches off the costliest effects first) to hold 60 fps, and a benchmark
   that visits fixed named views and prints draw calls, triangles and frame
   times.
9. It must build into an Android APK that starts on the Low preset with touch
   controls (floating move stick, drag-to-look, on-screen buttons).

## 3. Required features and acceptance criteria

Each item has an ID; the grader checks them one by one.

### Player and movement
- **P-01** Capsule 1.83 m, 0.35 m radius, 80 kg; stand / crouch 1.25 m / prone
  0.55 m eye-ward heights; walk 1.4, jog 3.5, sprint 6.0 m/s; stamina drains
  on sprint. *Accept:* measured speeds within 5 %.
- **P-02** Acceleration-based movement: no instant top speed, no instant stop;
  sprint + crouch slides. *Accept:* reaching jog speed takes 0.1–0.4 s.
- **P-03** Fall damage above 4 m, a 20 s limp above 8 m.
- **P-04** Wading in the lake slows you with depth; no prone in water deeper
  than a hand's width.

### Weapons and ballistics
- **W-01** Assault rifle: 30 rounds, ~750 rpm, semi/auto on `B`, tactical and
  empty reloads with different timings and a visible magazine swap.
- **W-02** Red-dot sight drawn as a real optic: the dot at infinity, parallax
  correct with head movement, not a screen-space crosshair.
- **W-03** Recoil: per-shot impulse (vertical + seeded horizontal), visual kick
  separate from aim kick, recovery toward the original point of aim.
- **W-04** Bolt-action sniper: 5 rounds, bolt cycle, variable 4×/10× scope as a
  **second render target** at ≤ ½ resolution, black shadow ring, eye-relief
  penalty when moving, mil-dot reticle.
- **W-05** Point-mass ballistics with drag, the same solver for bullets and for
  the range finder. *Accept:* drop and time of flight within 5 % of
  `ballistics-reference.png` at 300, 500 and 800 m; holdover in mil matches the
  sheet; a hit at 600 m with the sheet's holdover.
- **W-06** Wind per map drifts bullets and moves foliage with the same vector.
- **W-07** Penetration: a per-material energy cost on the ray — through wood and
  sheet metal, stopped by concrete.
- **W-08** Grenades: frag (4.5 s fuse, cook, arc preview, line-of-sight damage
  falloff), smoke (blocks AI vision rays, not only the camera), flashbang
  (whitens screen, muffles audio, blinds AI in the cone).
- **W-09** Suppressor on/off changes flash and the audible detection radius.

### Damage, items, AI
- **D-01** Hitboxes per body part (head, chest, abdomen, arms, legs) with
  multipliers and effects (leg = limp, arm = sway); a chest plate that breaks
  after a set number of hits.
- **D-02** Health = regenerating buffer + permanent pool; med kit 6 s,
  interrupted by being hit; ammo pack 4 s refills both primaries.
- **D-03** Feedback: directional hit indicator, a dirt/focus vignette (no
  blood), distinct sounds for plate hit, flesh hit and a supersonic near-miss
  crack.
- **A-01** Squads of 4 (point, rifleman, support, leader); vision cone with
  distance falloff and occlusion rays; hearing radius from stance, speed and
  suppressor.
- **A-02** Patrol → alert (search last known position) → engage (cover,
  suppress, flank) → regroup; if the leader dies the squad falls back.
  *Accept:* a squad flanks a stationary player within 15 s.
- **A-03** They throw grenades at a player who stays put > 8 s and miss
  believably: the first burst is loose and tightens over time.

### Graphics (compare with `target-look/`)
- **G-01** Sky, fog and the environment probe come from one sky function; fog
  is height-based and tied to the lighting preset; 700 m looks 700 m away.
- **G-02** Three lighting presets from `lighting-reference.png`: clear noon,
  overcast, golden hour.
- **G-03** Cascaded shadows (3 High / 2 Low) and soft cloud shadows; the
  first-person weapon falls into shadow under a roof.
- **G-04** Forest: instanced pines and birches with alpha-clip foliage, thin
  translucency on High, coverage-preserving alpha mips, wind sway. **One draw
  call per plant species** (streamed instances), not one mesh per chunk.
- **G-05** Distance: full trees near, light crowns further, **impostors** (8
  baked views, blended) beyond ~200 m; LOD hand-overs **dithered**, never
  popping.
- **G-06** Ground: layered terrain (grass, soil, gravel, rock on slopes,
  triplanar), a detail layer sharp at prone eye height, the dirt track with
  ruts.
- **G-07** **Real grass blades** (not cards) on the meadows: curved blades in
  tiles around the camera, thinned smoothly with distance, standing exactly on
  the terrain surface, bending in the wind and under the player's feet.
- **G-08** The lake: refraction of the bed through the surface, Beer–Lambert
  absorption, Fresnel reflection with the far tree line mirrored, small
  shore waves and a wet bank, caustics on the shallow bed, reeds; **ripples**
  from wading, bullets and blasts that spread and stop at the bank.
- **G-09** City: brick, plaster, glass, asphalt from the PBR sheet; interiors
  lit by probes, not the outdoor sky alone; the wet variant reflects buildings
  in puddles.
- **G-10** Effects: muzzle flash as a light with a fixed slot, smoke, dust and
  sparks per surface, decals, grenade blasts that flatten the grass.

### UI, audio, settings
- **U-01** HUD per `hud-layout-reference.png`: objective top-left, compass
  top-right, weapon and ammo bottom-left, health/armour/med kits bottom-right,
  grenades bottom-centre; nothing but the reticle in the centre zone, nothing
  at all while aiming down sights. A minimal-HUD option.
- **U-02** Menus: map, mode, lighting preset, quality, render scale, adaptive
  resolution on/off, sensitivity, invert Y, rebindable keys, volume, a
  Benchmark button that shows a copyable table.
- **U-03** Audio: layered gunshots, sound delayed by distance (343 m/s),
  ducking on flashbang, footsteps by surface.

## 4. Reference images

Target look (`target-look/`, captured from the reference implementation at
960 × 540, High preset, software renderer — expect a real GPU to look
sharper):

| File | What it shows | Match this |
|---|---|---|
| `01_range.png` | Range lane, berms, tree lines to the horizon, rifle in hand | the scale cues, haze toward the horizon, clean HUD corners |
| `02_scope.png` | Sniper scope: second view, shadow ring, mil reticle | a real second render, not a zoomed FOV |
| `03_forest_meadow.png` | Meadow of grass blades under pines, sun through crowns | grass density and colour, crowns with translucency |
| `04_forest_lake.png` | Lake from a grassy bank: water, reeds, the far shore | grass blades on the bank, refraction, Fresnel, the tree line on the water |
| `05_forest_squad.png` | Two soldiers at a squad position on a forest track | sight lines, ground variety, mossy rocks — the soldiers are procedural stand-ins: a floor to beat, not the target |
| `06_city_square.png` | City square: paving, benches, buildings, street trees | material variety, shadow, distance haze |
| `contact-sheet.png` | All of the above with captions | — |

Binding numbers (`../../reference-sheets/`): `lighting-reference.png`,
`pbr-material-reference.png`, `scale-reference.png`,
`ballistics-reference.png`, `hud-layout-reference.png`,
`performance-budget-reference.png`.

## 5. Budgets and presets

| | High (desktop) | Low (phone) |
|---|---|---|
| Draw calls (per frame, any benchmark view) | ≤ 2500 | ≤ 1500 |
| Triangles | ≤ 12 M | ≤ 4 M |
| Frame time | 60 fps at 1440p on a mid-range desktop GPU | 30 fps steady on a mid-range phone at 1 CSS px per pixel |
| Shadow cascades | 3 × 2048 | 2 × 1024 |
| Scope view | ≤ ½ resolution, fits the 2 ms game slot | same |
| Load to first frame | ≤ 20 s desktop, ≤ 40 s phone | |
| Hitches | none > 50 ms after the first second of play | |

The frame governor may lower render scale to 58 % and switch off shafts/AO;
it must never change gameplay.

## 6. Build order (stop and report after each)

1. Skeleton: fixed-step loop, renderer with the colour and tone-mapping chain,
   pre-exposure, auto exposure, a grey-box room at city scale, a moving
   capsule. Report the frame time.
2. Movement with stances, stamina and camera.
3. Range map, then the rifle end to end (model, animation, recoil, ballistics,
   decals, sound). Report measured drop at 300/500/800 m against the sheet.
4. Damage model and hitboxes on a target dummy.
5. AI perception and one engaging enemy.
6. Sniper rifle and the scope render target.
7. Grenades and items.
8. City map, then forest map with the lake, art-passed against `target-look/`.
9. Squads, modes, audio pass, post-processing pass.
10. Performance pass (benchmark views, governor), settings and menus, Android
    build with touch controls.

Each report states: what works, how to run it, measured frame time and draw
calls at the benchmark views, and what is not done.
