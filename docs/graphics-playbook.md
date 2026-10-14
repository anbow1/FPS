# Graphics playbook — real-time outdoor worlds in three.js (WebGPU + TSL)

Everything the games in this repository do to look good and still run on a
phone, written so another project (or another coding agent) can repeat it step by
step. It is a record of what was built, measured and fixed here, including the
traps that cost the most time.

- **Field Line** (`field-line/`): military FPS — shooting range, city block, pine
  forest ridge.
- **Castaway Lagoon** (`castaway-lagoon/`): tropical bay with a jungle, a beach,
  a survival outpost, weather and time of day.
- **Tanks** (`tanks/`): tank combat on fields, lakes and a village.
- **Contrail** (`contrail/`): jet fighters over 100 km of terrain under a
  physical sky with volumetric clouds.
- **Ridgeline** (`ridgeline/`): an attack helicopter over 20 km of ridges, with
  a cockpit, weapons and a ground force.

All use **three.js r186**, `WebGPURenderer` (falls back to WebGL2 by itself),
**TSL** node materials, strict TypeScript, Vite. Everything is procedural: no
texture or model files, so the builds are ~1.2 MB and ship offline in an APK.

> File references are relative to the repository root. "Lagoon" = `castaway-lagoon/src`,
> "FL" = `field-line/src`.

---

## 0. How to use this document (agent workflow)

Work in this order; each stage has a **Do**, a **Check**, and the **Traps** that
bit us. Do not move on while a Check fails.

1. **Renderer, units, post chain** (§1). Nothing else looks right until exposure
   and colour are right.
2. **Procedural texture pipeline** (§2), then **terrain** (§3).
3. **Sky, sun, environment probe, shadows** (§4).
4. **Vegetation** (§5), **rocks and props** (§6).
5. **Water and shoreline** (§7), if the world has any.
6. **Mobile budget and stutter-proofing** (§8). Do this *continuously*, not at the
   end: the two biggest regressions here (stuck shader compile on phones, hitches
   while walking) came from features that looked fine on desktop.
7. **Verification** (§9) after every feature: tests, a headless screenshot, the
   pipeline tracer, draw calls and triangles.
8. For **flight and vehicle simulators** (kilometres per minute, 100 km views):
   map-scale terrain, baked mountain shadows, GPU forests, sky and clouds (§12);
   cockpits, displays and the HUD (§13); controls and the flight computer
   (§14) — the controls decide whether anyone can fly it.

General rules that held up:

- **One height function** for logic and rendering (terrain mesh, collision,
  vegetation placement, water depth). If they disagree you get floating trees and
  water under sand.
- **Physical units everywhere** (metres, seconds, lux, cd/m², kelvin) and
  constants with units in their names (`amplitudeM`, `dryTimeS`).
- **Comment the why**, credit the source of every technique (paper, sheet, repo).
- **Measure, don't guess**: every claim about cost comes from `drawCalls`,
  `triangles`, pipeline counts or timings logged by the scripts in §9.
- **Screenshots are not enough for anything that moves**: take frames seconds apart.

---

## 1. Renderer, light units and the post chain

**Files:** Lagoon `render/stage.ts`, `render/lighting.ts`, `render/exposure.ts`,
`render/colour.ts`; FL `render/stage.ts`, `render/lighting.ts`.

### Do

1. `new WebGPURenderer({ antialias: false })`, `await renderer.init()`. One code
   path; it falls back to WebGL2 when WebGPU is missing (Android WebView often).
2. **HDR scene pass**: `pass(scene, camera, { type: HalfFloatType })` with an MRT
   `{ output, velocity }` (velocity for TRAA).
3. **Post chain** (in `RenderPipeline`, HDR until the very end):
   scene → **TRAA** (every preset; it was High only until phones moved to 2×) → **screen-space sun shafts** → **bloom** →
   **grade** (saturation, vignette) → exposure → ACES tone map → sRGB (the output
   transform, once) → **CAS-style sharpen** (wins back what TAA softens).
4. **Sun shafts** = radial light scattering (GPU Gems 3 ch. 13): march from each
   pixel toward the sun's screen position, but sample **only sky pixels** (depth
   at far plane), so leaves and buildings cut the beams. Strength scales with a
   low sun and clear sky; zero samples on the Low preset.
5. **Physical light**: author the sun and sky in **lux** from a lighting sheet;
   colours from **kelvin**. Multiply every light, emissive and sky value by a
   **pre-exposure** factor derived from the preset's anchor EV100 (Lagarde & de
   Rousiers 2014) so the sun's glint never overflows FP16.
6. **Auto exposure**: reduce the HDR pass to a small luminance grid on the GPU,
   read it back **asynchronously** every 6th frame, histogram on the CPU, keep the
   50th–95th percentile band, adapt bright→dark slowly (~2 s) and dark→bright fast
   (~0.5 s), clamp EV per preset.
7. **Interiors** (FL `render/interior.ts`): a baked "sky visibility" factor per
   building volume scales the sky ambient via the AO channel (indirect only), so
   rooms are darker than the street while sun through windows stays full.

### Check

- A grey card in noon sun meters near the preset's EV; sunset and night look like
  themselves, not like a darkened noon.
- No banding in the sky, no NaN/black pixels at the sun's glint.

### Traps

- Tone-map **once**. Doing sRGB in a material and again in output washes out.
- Each GPU→CPU readback is a sync point on mobile: throttle it (every 6th frame).
- TRAA needs the velocity MRT; objects moved by `positionNode` get velocity
  from three automatically, but custom `vertexNode` materials do not.

---

## 2. Procedural textures (no image files)

**Files:** Lagoon `render/textureSet.ts`, `render/patterns.ts`,
`render/foliagePatterns.ts`, `render/textures.ts`; FL `render/textures.ts`,
`render/patterns.ts`, `render/plantPatterns.ts`.

### Do

1. A **texel sampler** is `(u, v, out) => void` over `[0,1)²` that writes base
   colour (sRGB), height, AO, roughness, metalness and alpha. Everything must tile:
   use periodic noise (`tileNoise`, `tileFbm`) and periodic Worley (wrap cell
   indices modulo the grid).
2. `makeTextureSet(size, sampler, normalStrength, alphaCoverage)` bakes three maps:
   **base colour** (sRGB), **normal** (from the height, Sobel, OpenGL convention,
   linear) and **ORM** (R AO, G roughness, B metalness, linear, `NoColorSpace`).
3. **Alpha cards** (leaves, needles, grass): bake with **coverage-preserving
   mips** (scale alpha per mip so the fraction above the alpha test stays the same)
   or foliage thins to nothing at distance. Give transparent texels the leaf's
   colour, not black, so filtering never draws a dark halo.
4. **Texture arrays for splat terrain**: stack same-size sets into three
   `DataArrayTexture`s (colour, normal, ORM) and sample with
   `texture(arr, uv).depth(int(layer))`. Four layers cost 3 bindings, not 12.
5. Useful samplers written here: sand with ripples and shell fragments, tropical
   grass, leaf litter, coast rock, moss, pine bark, palm bark, jungle bark, palm
   frond, fern frond, grass tuft, broadleaf cluster (ovate leaves with veins and a
   serrated edge), banana leaf, pine needle spray (see §5), surf-foam lace (§7.5).

### Traps

- **16 sampled textures per shader stage** is the WebGPU default and the limit
  on most phone GPUs (SwiftShader allows 32, so headless tests will not catch
  it). A terrain with 4 layers × 3 maps + noise + shadow cascades + environment
  hit 19: on phones the pipeline never compiled ("stuck at compiling shaders") and
  on desktop WebGPU the ground vanished. Count every `texture()` in a material.
- Needle cards made of 1–2-texel strands alias into moiré stripes at range.
  Draw **tufts** (a rounded mass around each twig) instead of strands.

---

## 3. Terrain

**Files:** Lagoon `game/terrain.ts`, `render/ground.ts`; FL `maps/*.ts`,
`maps/terrain.ts`, `render/ground.ts`.

### Do

1. **Height function first** (pure, no three.js): layered fbm, ridged noise,
   explicit landforms (a bay, a channel, islets, a ridge with a saddle), a
   thermal-erosion pass so slopes settle at a talus angle. Logic, collision and
   rendering all call it.
2. **Mesh**: a dense near grid over the play area (1.25–2 m cells) plus a coarse
   far ring out to the fog, with a skirt to hide the seam.
3. **Per-vertex splat weights** (grass, soil/sand, rock, track/litter) from slope,
   a patch noise field, distance to tracks, and **canopy cover**.
4. **Height-blended splat**: lift each weight by that layer's height (texture AO or
   height channel), subtract `max − 0.2`, renormalise: sand fills between stones,
   rock pokes through turf, instead of a mushy linear fade.
5. **Triplanar rock** (sample three projections weighted by `|normal|⁴`) so cliffs
   never smear.
6. **Detail layer** within ~10 m (a high-frequency copy of the dominant texture)
   and **macro variation** (two low-frequency noise lookups at ~200 m) to kill the
   tiling grid at every distance.
7. **Canopy shade and litter** (FL `ground.ts` `canopyAt`, Lagoon `treeShade`):
   sum a Gaussian per tree crown over each vertex; push the splat toward needle
   litter/soil under crowns and multiply the AO (indirect light only — the sun has
   real shadows) down to ~0.55. Grass under a pine stand looks wrong without it.
8. Dirt paths as a splat weight from polylines; wet band / puddles from a wetness
   uniform (rain) and the shoreline model (§7.6).

### Traps

- Put ~10 textures max in the terrain material (see §2 traps).
- The far ring needs every vertex attribute the material reads (we added a
  constant `shade` attribute, or the shader fails on that mesh).

---
## 4. Sky, sun, environment and shadows

**Files:** Lagoon `render/sky.ts`, `render/lighting.ts`; FL `render/lighting.ts`.

### Do

1. **One analytic sky function** (Lagoon): horizon→zenith gradient calibrated to
   the sky illuminance in lux, a Mie glow and warm horizon band toward the sun,
   sun and moon discs, stars, and a wind-driven cloud deck with weather-driven
   coverage. The **same function** draws the dome, lights the environment probe,
   reflects in the water and colours the fog, so horizon, haze and reflections
   always agree. (FL uses Preetham, scaled once per preset — `calibrateSky` — so
   the dome delivers the sheet's sky illuminance.)
2. **Environment probe**: render a small probe scene (the sky dome, plus a ground
   hemisphere lit by sun and sky with a mean ground albedo ≈ 0.2 — the **ground
   bounce** that lifts shaded walls, trunks and soldiers) into a PMREM. Re-bake
   only when the sun moved, the EV changed, clouds or night changed.
3. **Cascaded shadows** (`CSMShadowNode`): split to the real play distance (e.g.
   450 m High / 220 m Low), not the default; 4 cascades High, 2 Low; 2048/1024 px
   (FL) or 4096/1024 (Lagoon); `fade = true`.
4. **Height fog**, integrated along the view ray:
   `τ = ρ₀ · d · (e^(−f·h₀) − e^(−f·h₁)) / (f · (h₁ − h₀))`, coloured by the sky.

### Traps

- **Re-bake PMREM into the same render target**
  (`pmrem.fromScene(scene, 0, near, far, { size, renderTarget })`). A new target
  per bake changes `scene.environment`'s texture object, and every material that
  reads it rebuilds its shader: a hitch on every re-bake.
- **Never toggle `light.castShadow` at runtime** (e.g. "no shadows at night").
  The light set is part of every material's cache key: the whole scene recompiles.
  Fade the intensity instead.
- The probe's sky dome must sit inside the PMREM camera's far plane (we scaled the
  dome to 50) or the probe is black.

---

## 5. Vegetation

**Files:** FL `render/foliage.ts`, `render/undergrowth.ts`, `render/instanceStream.ts`,
`render/meshkit.ts`, `render/plantPatterns.ts`, `render/materials.ts`;
Lagoon `render/palms.ts`, `render/jungle.ts`, `render/undergrowth.ts`,
`render/foliageMaterials.ts`, `render/meshkit.ts`.

### 5.1 Geometry kit (`meshkit.ts`)

- `card(w, h)` — an upright quad, base at y = 0.
- `foldedStrip(spine, sides, halfWidths, foldRad, bendFrom, bendK)` — a strip along
  a spine whose two halves fold down about it: palm fronds, fern fronds, banana
  leaves. Normals bent toward `vertex − bendFrom` so a crown shades as a volume.
- `tube(points, radii, radial, vTileM)` — trunks, stems, vines, ropes.
- `merge(parts)` — strips non-standard attributes and merges.
- `rand(a, b)` — deterministic hash for per-part variation.

### 5.2 Plants built here

| Plant | Construction |
|---|---|
| Pine (FL) | whorls of branch cards from 30 % up the trunk, drooping more lower down; **two cards per branch** (flat + rolled ~70° about the branch) so the crown has volume from the side; a crossed leader on top; normals from the crown axis; a light version (4 whorls × 5 big cards) for distance |
| Coconut palm (Lagoon) | curved leaning tube trunk; folded two-rank fronds arching out and down; two dead fronds; nuts |
| Rainforest tree (Lagoon) | buttressed trunk, limbs, leaf-cluster cards on an ellipsoid shell with outward normals; a cheaper version carpets far hills |
| Broadleaf shrub | 14 leaf-spray cards over a dome, normals from the dome centre |
| Fern / bracken | 8–10 folded fronds radiating and arching |
| Grass tuft | 3 crossed cards, normals mostly up (reads as a lawn, not dark cards) |
| Banana, vines, sprouts (Lagoon) | tube stem + folded leaves; rope tube + leaf cards; 5 tilted cards |

### 5.3 Materials

1. **Alpha-clipped, double-sided** cards, `alphaTest = 0.5`.
2. **Thin translucency** (`MeshSSSNodeMaterial`): the term is added inside the
   direct-light loop and multiplied by the *shadowed* light, so only sunlit
   leaves glow from behind — the golden-hour look. Thickness colour = albedo ×
   (1.1, 1.2, 0.6); distortion 0.25, power 2.5, scale 2.2, attenuation 0.6.
   **Off on the Low preset** (a second light evaluation per leaf pixel with heavy
   overdraw).
3. **Wind**: bake a `sway` attribute per vertex (bend weight ∝ height², plus a
   flutter weight); in `positionNode` (which runs after instancing, so
   `positionLocal` is world space) push along the wind with a slow gust and add a
   faster flutter across it. One wind uniform drives every plant (and in FL also
   the bullets' drift).
4. **Per-instance tint** with `InstancedMesh.setColorAt` (three multiplies the
   material colour by `instanceColor`): crowns a little yellower, bluer or darker
   per tree; grass drier or lusher by a noise patch.
5. World-space UVs for bark on a unit cylinder scaled per tree
   (`uv.y = positionWorld.y / 1.1 m`), or one tile stretches over 20 m of trunk.

### 5.4 Placement

- Trees on a jittered grid thinned by a stand-density field; clear around tracks,
  buildings and rocks; fewer on steep rock.
- Undergrowth by **rejection sampling** against a coarse (4 m) grid of the splat
  weights: grass where the ground is grass, bracken in clumps (`fbm` mask) on the
  forest floor and its edge, nothing on rock or tracks, nothing inside building,
  wall, prop or trunk footprints (binned 16 m grid of oriented boxes).
- Keep plants out of "mown" rectangles (firing lanes, yards) and away from the
  shelter, paths and interactables.

### 5.5 Distance handling (critical for phones)

1. **Two levels of detail for trees**: full crowns within `nearCrownM`
   (110 m High / 60 m Low), light crowns beyond.
2. **Streamed instancing** (`FL render/instanceStream.ts`): **one `InstancedMesh`
   per plant kind**, fixed capacity, refilled from the grid cells around the
   camera whenever the camera enters another cell. Selection is measured from the
   camera **cell centre** with one cell diagonal of margin; the capacity is the
   largest refill any cell (including empty ones) can need, computed at build.
   Far LOD = the complement (`outside: true`) of the near set.
3. **Sink-fade**: small plants sink into the ground over the last ~15 m of their
   draw distance (`positionNode` subtracts `smoothstep(from, to, dist) × depth`),
   so they never pop.
4. **Shadows only from the near ring**: a streamed mesh has no per-chunk culling,
   so every far crown would be drawn into every sun cascade. Near crowns and
   near trunks cast; far ones do not; the baked canopy AO keeps the ground under
   them dark.

Measured on the forest map (SwiftShader, 640×360): 516 → ~130 draw calls,
3.99 M → 3.1 M triangles on High; 87 draw calls / 1.7 M on Low.

5. **Impostors beyond `impostorM`** (`render/impostor.ts`, shared by all three
   games): at load each species is rendered from 8 directions round its vertical
   axis into one atlas, **unlit albedo + alpha and object-space normals through
   one MRT** (`mrt({ albedo: vec4(diffuseColor.rgb, 1), normal: normalWorld·0.5+0.5 })`,
   render-target textures named like the MRT outputs), each species in a row,
   each view in a column, framed by an orthographic camera fitted to the
   species' bounding box (`target.viewport/scissor` per frame, autoClear off).
   At run time **all far trees of all species are one instanced draw**: an
   `InstancedBufferGeometry` quad whose corners are an attribute; the vertex
   node builds the billboard in world space facing the camera horizontally,
   takes the camera's angle round the tree **in the tree's own frame**
   (atan2 − yaw), and passes the UVs of the two nearest baked views plus the
   blend between them, so walking round a tree turns it smoothly. The fragment
   blends both views, turns the baked normal by the instance yaw and lights it
   like any surface (sun, sky, shadows, fog). Refilled on the stream grid.
   **Orientation:** render-target textures are addressed from the **top** on
   both backends (three flips WebGL's to match), so the frame's bottom — the
   trunk — is at the larger v: `row = (species + 1 − corner.y) / speciesCount`.
   Getting it backwards stood every tree past 200 m on its crown for weeks;
   check a forced close-up of the impostors alone, not a forest at a distance.
6. **Dithered hand-over**: over a band `[impostorM − fadeM, impostorM]` the
   meshes keep a pixel where an interleaved-gradient-noise threshold is above the
   fade and the impostor where it is below (`ditherOutBeyond` gives opaque bark
   an alphaTest for this): the two cover every pixel exactly once, and TRAA hides
   the pattern. Both sides use the **same per-pixel horizontal distance**; a
   per-instance distance on one side and per-pixel on the other leaves holes.
7. **Ring streams**: the far mesh LOD is `outside: true, maxM: impostorM`, a
   ring, so meshes stop where the impostors take over. In Tanks, where every
   tree was a full mesh at any range and every one of them fell into three
   shadow cascades, the near set is refilled per 32 m cell (felled trees stay
   meshes wherever they lie, and leave the impostor list).
8. **Hit proxies**: bullets, shells and the knife never test render geometry in
   these games — they test the logic's own colliders (Field Line: a box per
   trunk; Tanks: hulls knock trees through a 16 m spatial hash, shells ignore
   them), which is the cheap "invisible proxy" the high-end pipelines add
   separately. Impostors therefore need no collision of their own.

### 5.6 Grass from real blades (`render/grassField.ts`, shared by all four games)

Grass cards (a few crossed quads per tuft) read as paper on a phone at any
distance under 10 m, and every tuft is its own instance. The shared field
draws **individual Bezier blades**, generated entirely in the vertex stage:

1. **One tile, R2 order.** A 4 m tile holds N blades (700 High / 300 Low in
   the FPS games) in R2 low-discrepancy order (Roberts 2018), so *any prefix*
   of the list is an evenly spread subset. Each blade is jittered within its
   spacing and a two-sine clump field modulates presence and height, so the
   tile never shows rows.
2. **Three rings, three draws.** Tiles are instanced round the camera in rings
   out to 30 %, 65 % and 100 % of the radius (40 m / 24 m). Each ring has its
   own geometry (4, 3, 2 segments per blade) and a `drawRange` of the list
   prefix it can ever need (100 % → 45 % → 20 %). Inside the ring a blade's
   rank is compared with a keep fraction that falls smoothly with distance,
   and blades near the cut shrink over the last 15 % of ranks — no pop. Kept
   blades widen by `1/sqrt(keep)` (never below ~1 px), so coverage holds.
3. **Exact ground height.** The terrain's height grid goes up as an R32F
   `DataTexture` read with `textureLoad`, and the vertex splits each cell into
   the same two triangles the terrain mesh uses (`split: 'bc' | 'ad'`), so no
   blade floats or sinks on a slope. Bilinear sampling is visibly wrong here.
4. **Density map.** An RGBA8 grid per game — meadow, beach grass, sedge, shade
   — decides presence, kind (height, lean, colour) and darkening under trees.
   It is zero in water, on roads, under buildings and wherever the logic says
   the ground is mown or blocked; the game bakes it once at load.
5. **Shape and light.** Width tapers to the tip, the Bezier control point
   leans by kind and by a travelling wind gust (`uWind`, `uTime`); the shading
   normal is 60 % straight up and 40 % the blade's own face normal, so a field
   lights like ground with texture instead of flickering blade by blade, and
   colour darkens toward the root (`mix(0.6, 1, sqrt(t))`) — that dark base
   is what sells depth from above. Blades are two-sided.
6. **Trampling.** A 128² × 0.3 m map, re-centred on the player in whole
   texels, stores a push direction and strength per cell;
   `stamp(x, z, r, dirX, dirZ, strength)` is called for the feet each frame
   (bigger when prone), for hulls in Tanks and with a 4 m radius for
   explosions; cells decay back exponentially over a few seconds.
6b. **Wind from a point** (`blow`): a rotor's downwash or a blast lays the
   blades outward over a disc and sets them thrashing (A channel of the
   trampling map, decaying in 0.35 s). Held, not accumulated: call it every
   frame while it blows. Ridgeline drives it from the rotor (§12.6).
6c. **Functions instead of grids**: the ground height and the density may be
   TSL functions of the root (`GrassGroundNode`, `GrassSurfaceNode`), and the
   density function may return the ground's colour for the blades to take.
7. **Per-game scale.** `widthScale`/`heightScale` and the colours are options:
   Tanks views the ground from 3–10 m up, so its blades are 3.2× wider, 1.3×
   taller and brighter (thin blades at that range alias into stripes darker
   than the terrain under them).

Cost measured with the bench (§9.2): about +0.5 M triangles and 3 draws in
Field Line; in Tanks +0.1–0.4 M.

### Traps

- **`NodeMaterial.copy()` never calls `Material.copy()`** (r186), so `clone()` loses
  `alphaTest`: cloned foliage draws every card as a solid quad. Restore it
  (`cloneMaterial` in FL `render/materials.ts`).
- **`alphaToCoverage` without MSAA** disables the alpha-test discard in three:
  cards draw solid. The renderer uses TRAA, not MSAA, so leave it off.
- **Every `InstancedMesh` gets its own shader build** (three keys instanced meshes
  by `uuid`). Hundreds of per-chunk meshes = a shader build each time a new chunk
  first comes into view = a hitch every few steps on a phone, plus a draw call per
  chunk per cascade. Use one mesh per kind (§5.5.2).
- **Pre-compiling an empty instanced mesh** (`count = 0`) left its pipeline
  never ready: the plants drew in the shadow pass but never in the main pass.
  Fill streams at the spawn point before `compileAsync` (and see §8.3).

---

## 6. Rocks and props

**Files:** Lagoon `render/rocks.ts`, `render/props.ts`; FL `render/props.ts`,
`render/materials.ts` (`boulder`).

- **Boulders**: an icosphere (detail 5) pushed out by two layers of fbm on the
  unit direction, one or two flat facets, flattened where it sits in the ground,
  **welded** (`mergeVertices`) before `computeVertexNormals` so it shades smoothly.
- **Triplanar** rock colour and ORM (`triplanarTexture`), **moss on upward faces**
  (`smoothstep` on `normalWorld.y` broken up by a blotch texture), **bump** from
  the height (`bumpMap`), darker and glossier when wet; in the lagoon an always-wet
  surf zone and algae below the waterline.
- Props: share materials through a cache (`shared(key, make)`); build hidden
  "gallery" copies of anything that can appear later (ammo box, food, flare) so
  the warm-up compiles them (§8.3).

---
## 6b. First-person rendering (FL)

- **Viewmodel in the world scene, scaled down about the eye** (`VM_SCALE`): the
  picture is identical but the gun sits inside the player's capsule, never pokes
  through walls, receives the sun's cascades (step under a roof → it falls into
  shadow) and takes the interior ambient factor.
- **Real optics**: the red dot is drawn on the sight's rear glass where the eye ray
  is within the dot's angle of the optic axis (collimated: parallax behaves like a
  real one). The scope renders a second camera into its own target, shown on the
  ocular with a first-focal-plane reticle, a shadow ring and an exit-pupil
  penalty when the eye leaves the axis. Render the scope only after the main view
  has compiled once (the sun cascades bind to the first camera that renders).
- **Arms** (Lagoon `render/arms.ts`): articulated hands on two-bone IK from fixed
  shoulders, so hands never float.
- Static world boxes merged per material with world-space UVs (continuous brick
  across pieces); breakable glass instanced one per pane.

---

## 6c. Hard-surface props and characters (FL cars, weapons, soldiers)

Boxes read as toys at any distance; what reads as "real" is the silhouette, the
edges that catch light and the small parts people expect.

- **Cars as lofts** (`render/carModel.ts`): rounded sections every ~10 cm from
  bumper to tail (eased between a handful of key stations: half width at sill
  and shoulder for tumblehome, sill and waist heights, corner radius), the sill
  lifted into a **wheel-arch tunnel** over each axle (a narrow floor fills it
  between the wheels). The greenhouse is a second loft that narrows to the roof
  and rises along the windscreen rake. **Sort every quad into a part by where it
  sits** (paint, glass, black trim: seals, B-pillar, door shut lines, sills) and
  put a ring exactly on every boundary: shut lines and window edges become real,
  crisp mesh edges. Lamps, grille, intakes and plates are **patches laid on the
  skin** (march in from the end until the section contains (x, y), bisect, lift a
  few mm), so they wrap round the nose flush; boxes stuck on stand off it. Lathed
  tyres (rounded sidewall) and a five-spoke rim. ~10 k vertices per car; two
  body variants by a hash of the parking place; one InstancedMesh per part.
- **Weapons** (`render/weaponModels.ts`): side profiles as `ExtrudeGeometry` with
  a 1–4 mm **bevel** (every edge gets a highlight), trigger guards as shapes with
  holes, turned parts as lathes (barrel steps, muzzle device, scope bells),
  rail teeth every 10 mm, a slotted handguard, and holes (ports, slots, flutes,
  serrations, knurling) as a near-black "cavity" part — it reads as depth.
- **Characters** (`render/actors.ts`): rigid segments (pelvis, torso, head, upper
  arm, forearm, hand, thigh, shin, boot, rifle), one InstancedMesh each, both
  sides in the same mesh (two instances per soldier). Pose per frame: stance sets
  hips and spine to the hitbox layout; the rifle butt sits in the shoulder pocket
  along the aim; **two-bone IK** brings the hands to the grips (elbows out) and
  the feet to a stride (knees forward); the torso is **bladed ~35°** so the
  support hand reaches the handguard. One material for all kit: per-vertex colour
  plus a kind (hard / plain fabric / camouflage) that sets roughness, sheen and a
  procedural four-colour camouflage in segment space.
- Never mirror an instance with a negative-determinant matrix: instanced draws
  pick the front face per mesh, not per instance, so the mirrored copies render
  inside out. Build paired segments symmetric instead.

---

## 6d. A city at night, and rooms behind the windows (FL)

- **Street lamps** (`render/cityLights.ts`): physical units throughout (lamp
  ~2500 cd with a cut-off profile, lens ~9000 cd/m², EV 1.5). The few lamps
  nearest the camera are real `SpotLight`s (they light characters and draw the
  highlights on wet asphalt); every other lamp lights the ground through a
  half-float irradiance map baked once at load (0.5 m texels). The shader
  subtracts the near lamps' share with the bake's own formula, so no surface is
  lit twice. Everything night-only sits behind `If(uniform)`: switching day and
  night never recompiles (mind the variable trap in §11).
- **Interior mapping** (`render/roomInteriors.ts`, van Dongen 2008): for a pixel
  of clear pane the view ray carries on into a room one bay wide, one storey
  high and a few metres deep; the nearest of the three planes it is heading for
  gives wall, floor or ceiling. Add one piece of furniture (a rectangle in front
  of the back wall), curtains just inside the glass, a ceiling light (Lambert +
  inverse square + bounce) lit in a hashed share of rooms at night, and daylight
  through the window by day (~5 % of the outside light, falling off inwards).
  The pane mask is the façade texture's own roughness (clear glass is the
  glossiest texel), so blinds and frames stay as drawn. Past ~60 m fade to the
  room's mean or sub-pixel rooms sparkle. Needs a per-vertex tile size (bay ×
  storey in metres) to turn UVs into metres.

## 6e. A city by day: architecture, street and wear (FL)

What made the city read as a model, found by a screenshot tour of every kind
of place (street, façade close up, junction, car park, roof view), and the fix
for each:

- **Scale of the wall texture.** A façade texture covers one bay × one storey,
  so a brick sampler written for a metre tile drew bricks 0.8 × 0.25 m. Count
  the real units per tile instead (`brick(…, 13, 38)`: a course is 65 mm of
  brick and 10 mm of mortar, ~38 to a 3 m storey) and give such tiles 1024 px.
- **Windows cut by corners.** World-anchored UVs put a window's edge wherever
  the corner happened to fall. Fit a whole number of bays per face (the bay
  stretched to fit) and start u at the face's corner; make each building whole
  storeys tall plus a parapet zone (`fitStoreys`).
- **Relief, as geometry** (`render/facadeTrim.ts`): plinth, string course over
  the shops, cornice (frieze, bed moulding, corona overhanging 0.32 m: the
  shadow line under it is what the eye reads), parapet above the roof with a
  coping, stone sills and hoods at every upper window, roof plant (stair
  housing, AC units, vents, chimneys). Bands on two faces fill the corners and
  stop against them on the other two, so no faces overlap and fight.
- **Shops on the ground storey** (`render/shopfront.ts`, in the façade shader):
  glazing on a stall riser, transom, a painted fascia with "lettering" (strokes
  on a 3 × 5 grid per character: reads as a name, says nothing), roller
  shutters; awnings as geometry. Shops keep their lights on by day.
- **Glass.** A near-white albedo at low opacity reads as frosted plastic in
  sun. Glass albedo is ~0; let alpha follow Schlick (≈15 % face-on, most of it
  grazing) so the room shows face-on and the sky at an angle. Tilt each pane a
  fraction of a degree (hash per pane) so a wall of windows does not mirror one
  grey.
- **The road** (`render/cityRoad.ts`): darker, smoother wheel paths per lane;
  patched rectangles with a sealed seam; bitumen-filled cracks; oil in the
  parking lane; manholes and kerb gullies — all in world metres, so nothing
  repeats with the texture. Markings: zebra and stop line at each approach,
  paint worn through in patches.
- **Overhead and at the corners** (`render/streetFurniture.ts`): span wires
  from wall to wall with pendant lamps, signals on each approach, one lens lit
  at real LED luminance (~9000 cd/m², visible at noon).
- **Haze.** A clear day over a city is ~15 km visibility (β = 3.9 / V ≈
  2.6e-4 /m); at 6e-5 the far blocks had the contrast of near ones.

## 6g. Ground and plants up close (FL forest, found by a screenshot tour)

- **Litter, not weave.** Two anisotropic noises crossed at 90° read as knitted
  carpet; one stretched noise reads as brushed metal. Scatter short straight
  fibres per cell in random directions (each texel checks its 3 × 3 cells) for
  dead grass, fallen needles, straw.
- **Reed beds** are stems of uneven height with arching leaves and plumes on
  cards of different heights in a fan; equal cards with a meadow-tuft texture
  read as blocks of hedge in the water.
- **Leaves at the lens.** Dither leaf cards out within ~0.85 m of the camera
  (screen-space hash against a distance ramp, TRAA smooths it); the shadow
  pass sees them from the light, so shadows keep every leaf.
- **The far ring wears what the map wears.** Hills beyond a forest map need a
  canopy material (dark crowns in colour and bump, clearings); on the meadow
  splat they read as grey domes in the haze.
- **Litter on the floor**: cones, twigs, a fallen branch now and then, streamed
  round the camera; without them a forest floor reads as bare earth.
- **Cap cut and fill** where a road is pulled to a grade: a smooth target
  surface far below the local ground carves a trench along the whole road.

## 6f. Explosions in layers, and debris that stays (FL)

Learned from a study of *hood-warfare* (a three.js FPS): one effect per layer.
Flash core and a light that dies as `k^1.6` with flicker over ~0.4 s; fireball
billows whose colour follows a cooling ramp (white-yellow → orange → dull red,
brightness ∝ heat^2.2); a dust-and-smoke cloud following 30–150 ms later, lit
orange from inside while young (`emissive ∝ glow`), rising and thinning; a
dust ring thrown flat along the ground; solid chunks on ballistic arcs that
bounce, settle and stay (`render/debris.ts`); embers; a scorch decal with a
ragged, streaked edge. Billow sprites are not discs: two octaves of noise push
the edge in and out, and a rounded view-space normal lets the sun shade the
puff (`render/particles.ts`). Put ground debris on the real surface under it
(pavement, kerb, roof), not the terrain height.

## 6h. Animals and enemies (lagoon `render/creatures.ts`, `render/guerrillas.ts`)

- **The same rigid-segment rig as the soldiers** (§6c), one InstancedMesh per
  segment per species, posed from the headless logic each frame through a small
  matrix stack (`push`/`t`/`rx`/`emit`/`pop`). Bodies are lathes along the
  spine (`along()`, flattened for the croc's head and the boar's wedge), limbs
  tapered capsules hanging along −Y from their joint.
- **Joints bent the animal's way.** A cat's fore leg: upper arm back to the
  elbow, forearm straight down; its hind leg: thigh forward to the knee, shin
  back to the hock. Straight posts read as a toy. Stalking folds the elbows up
  behind the shoulders. Tails hang down and back (a *negative* `rx` swings −Y
  backwards) and curl at the tip; a charging boar carries it straight up.
- **Gait from speed**: one phase per animal advanced by speed / stride length;
  walk = lateral sequence, gallop = the pairs close in phase with a spine flex;
  the croc and shark get a travelling lateral wave (`sin(φ − k·0.9)`, larger
  toward the tail); the croc swims with its legs folded back.
- **One material, per-vertex kind** (tiger stripes along z or y, bristle, scutes,
  countershaded skin, plain eyes and teeth), patterns in **`positionGeometry`**:
  in an instanced mesh `positionLocal` is already the instanced position, so
  stripes crawl over a walking animal and countershading follows world height
  (a shark at −2 m went all belly white).
- **What sells the threat**: the croc's eyes and nostrils standing proud so they
  are what shows at the waterline; the shark's dorsal fin breaking the surface;
  muzzle flash, smoke and a tracer (life cut at the first raycast hit) for every
  enemy shot; blood puffs, or a red cloud and a ripple under water; HUD arcs
  pointing at whoever hit you.

---

## 7. Water and the shoreline

**Files:** Lagoon `render/water.ts`, `render/shoreField.ts`, `render/shoreWaves.ts`,
`render/caustics.ts`, `render/waterFx.ts`, `render/ground.ts` (swash, wet sand,
caustic lookup), `config.ts` (`WAVES`, `SHORE`).

The shoreline is where water looks fake first. The design target (from the
coastal checklist in §10) is one continuous chain driven by the **real seabed**:

> offshore swell → slows and shortens in the shallows → bends to the depth contours
> → grows → breaks → foam → runs up the sand → drains back → wet sand → dries.

### 7.1 The water surface

1. **Radial grid** centred on the camera (rings 0.35 m apart near the eye, growing
   4.5 % per ring out to 6 km), snapped to the finest spacing so it never swims.
2. **Depth map**: seabed height baked once into a half-float texture over the bay
   (shared with the wave field so `heightAt` runs once per cell).
3. **Wind chop**: a few Gerstner components (GPU Gems 1 ch. 1) with analytic
   normals, damped in very shallow water.
4. **Shading by hand** (`MeshBasicNodeMaterial`, every term explicit):
   - **refraction**: `viewportSharedTexture(screenUV + distortion)` — the floor
     already rendered behind the water, distorted less where it is shallow;
   - **Beer–Lambert absorption** along the path down and back up, per RGB channel
     (clear sea water ≈ 0.45 / 0.07 / 0.045 per metre, Pope & Fry 1997): red dies
     first, so white sand under a metre of water turns turquoise, deep water navy;
   - **single scattering** (turquoise in the shallows → navy in the deep) lit by
     sun and sky; light through the backs of crests;
   - **Schlick Fresnel** (F0 = 0.02), **reflection of the same analytic sky**, and a
     tight glint lobe of the sun and moon;
   - detail normals from two wind-scrolled ripple layers (faded with distance to
     avoid aliasing), splash rings and rain rings;
   - at the waterline the water fades into the wet sand behind it (thin film).

### 7.2 Shore wave field (eikonal, baked at load)

`render/shoreField.ts` — ported from Tidewater's `ShoreField`.

1. Grid over the bay (512², 1.2 m cells). Per cell: depth `d`, phase speed
   `c(d) = ω / k(d)` with **Eckart's approximation**
   `k = (ω²/g) / √tanh(ω² d / g)` (full dispersion, so deep water matches a plane
   wave exactly).
2. **Fast Marching Method** for `|∇T| = 1 / c`: sources are the border water cells
   with a plane-wave arrival `T = (x·dir)/c₀ + offset`; a binary heap pops the
   smallest `T`; the upwind first-order update is
   `a + f` if `|a − b| ≥ f`, else `½ (a + b + √(2f² − (a − b)²))`, `f = h / c`.
3. **Path loss**: accumulate `Σ ds / depth` from the upwind neighbour, and
   attenuate by `exp(−μ · loss)` — a long shallow channel calms the lagoon.
4. Extend onto land one ring per pass (reading the previous pass only):
   the **shoreline arrival time** carried inland unchanged (swash timing), and `T`
   continued slowly up the beach. Smooth `T` three times (removes FMM kinks).
5. Direction = normalised ∇T; **exposure** = alignment with the swell × path loss.
6. Store RGBA **float32** (`T`, dir × exposure, shore `T`): arrival times reach
   hundreds of seconds, beyond half-float precision. Float32 is not filterable
   everywhere, so the shader does **bilinear by hand from four `textureLoad`s**.

Cost: ~0.4 s at 512² once the heights are shared (the heights themselves were
1.5 s: share them). Unit tests: dispersion limits, fronts turning to meet a
straight beach, the lagoon beach reached through the channel with less energy.

### 7.2b An enclosed lake (FL `maps/lake.ts`, `render/shoreField.ts`, `render/water.ts`)

The same machinery on a small lake in Field Line's forest, with four changes:

1. **Carve the basin into the height function** (pure data: an ellipse with a
   gentle bowl at most 1.3 m deep and banks that rise above the water out to 1.3
   radii, then blend back to the terrain). The level is a little under the lowest
   ground on the blend rim. Tests: the banks are above the water all round, and
   no spawn, patrol, pickup, tree or track is in it. Logic reads the same data:
   wading slows the player (half speed at 1 m) and forbids going prone.
2. **Sources = the upwind shore** (water cells whose upwind neighbour is dry): a
   lake has no open boundary to feed a plane wave in from. **Fetch** (distance
   travelled over water) is accumulated along the same fast-marching paths and
   sets the height, `A ∝ √(fetch / 90 m)` — short, fetch-limited wind waves
   (period 1.7 s, ~5 cm in the forest's 5 m/s wind).
3. **Water on a physical material** instead of hand shading: a
   `MeshPhysicalNodeMaterial` with `ior 1.333` takes the environment reflection,
   the sun's highlight and its shadows and the fog from the scene's own lights;
   the refracted bed, absorption and scattering go in `emissiveNode × (1 −
   Fresnel)`; foam is diffuse `colorNode` with its own roughness; the edge fades
   out with `opacityNode` on the per-vertex depth. Wave normals go through
   `transformNormalToView` (a material's `normalNode` is view space).
4. The terrain's swash code runs only inside the lake's ellipse (elsewhere,
   ground at the same height would get wet patches from the clamped field), and
   reeds grow in clumps along the waterline.

### 7.3 Shore waves (`render/shoreWaves.ts`)

1. **Phase**: `s = (t − T(x)) / P + wobble(along)` counts waves; the crest of
   wave `m` passes when `s = m`; `u = s − round(s)` is −½…½, **u < 0 is the
   front of the wave** (shoreward points see each crest later).
2. **Every wave is an individual**: height from a set pattern (groups of ~7,
   bigger in the middle), a per-wave hash, and an along-shore variation (a few
   sines whose phases depend on `m`), so waves peel along the beach instead of
   closing out in one straight line. Hand the height over between consecutive
   waves in the trough (`mix` over the last 18 % of each half) so there is no step.
3. **Shoaling**: Green's law, `A = A₀ (d_ref / d)^¼`, capped.
4. **Depth-limited breaking**: `H = 2A ≤ γ d` with `γ ≈ 0.78`; `breaking =
   smoothstep(0.8, 1.15, A / (γd/2))`; the amplitude is capped at `γd/2`.
5. **Shape**: elliptic orbits — vertical `A`, horizontal `A / tanh(kd)` (flatter
   and longer in the shallows), clamped so `k × horizontal ≤ 0.9` (no loops). Water
   behind the crest moves forward and water ahead moves back, so crests bunch up.
6. **Forward lean**: warp the phase `g(u) = 2πu − β sin²(πu)` with `β = 1.2 ×
   breaking`, so the front face steepens as the wave breaks (`g′ > 0` for β < 2).
7. **Normal analytically**: along the travel direction ξ, `du/dξ = −1/λ`, so
   `dY/dξ = A sin g · g′ / λ`, `dX/dξ = 1 − H cos g · g′ / λ`; slope = dY/dX.
8. Pass the **continuous** wave count `s` to the fragment shader as a varying (the
   wrapped phase would jump inside a triangle) along with breaking and direction.
9. The long swell of the old Gerstner set only runs outside the baked field
   (fade over the field's last 6 %); the short chop runs everywhere.

### 7.4 Surf foam

- **Roller**: whitewater on the crest and its front face where the wave breaks.
- **Trail**: behind it the foam decays with the time since the crest passed,
  `age = fract(s) · P`, over `foamLifeS`, drifting shoreward with the bore. Keep
  the foam life well under one wave period (1.8 s for a 3.6 s period) in calm
  water: at 4.5 s every breaker's foam overlapped the next one's and the whole
  inner surf zone stayed white.
- **Lace** (after Tidewater's lace texture): a tileable texture whose R channel
  is "hole-ness" — round holes of many sizes (three scales of jittered points, each
  with its own radius, strongly domain-warped) plus fbm mottling — G small bubbles,
  B mottling, A a per-cell random. `cover = smoothstep(R − 0.08, R + 0.08, amount)`:
  fresh foam is a dense mat; as it thins, holes open and merge until only
  irregular strands and patches remain. (Our first version used Worley F2 − F1
  cell edges: at every amount it read as a regular honeycomb / paving stones —
  exactly what the coastal checklist warns against.) Offset the lace per wave (hash of `m`) so no two
  waves leave the same pattern. **Multiply the result by `smoothstep(0.03, 0.12,
  amount)`**: with any mottling offset in the threshold, zero foam otherwise still
  draws the whole strand net over every beach and every square metre of water
  (our first screenshot).
- A thin lacy edge where the water meets the sand; storm whitecaps on the chop;
  splash foam; the surf zone scatters a little milkier (stirred sand).

### 7.5 Swash, backwash and wet sand (ground shader)

All analytic — no simulation texture, so it costs nothing on phones outside the
beach band (the code runs inside a TSL `If` on the ground's height).

1. At a sand point `y` metres above sea level, the latest wave's time since it
   reached the shore: `τ = frac((t − T_shore) / P + wobble)`.
2. **Run-up** (vertical): `R(τ) = R_max × (1 − (1 − τ/up)^1.5)` while running up
   (decelerating), then `R_max × (1 − sb^1.6)` while draining
   (`sb = (τ − up)/down`, a backwash that starts slowly and accelerates), with
   `R_max ≈ 2.1 A` of the wave as it arrives, and a **lobed front** (three sines
   along the shore whose phases depend on the wave).
3. **Sheet**: `R(τ) − y > 0` → a film of water: darker and a touch green-blue,
   normals flattened, **roughness ≈ 0.14, not a mirror** (at 0.03 the whole run-up
   band reflected the sky as a solid white strip); a thin **foam line at the
   leading edge** while running up; a few foam patches riding the backwash while
   it drains (lace stretched along the flow looked like a comb: avoid). Only **above the still waterline** (`y > 0`):
   below it the water surface draws the waves, and swash foam on the seabed shows
   through the water as a white blanket.
4. **Wet history**: for each of the last six waves, when did its backwash uncover
   this height (invert the backwash curve), and `wet = max exp(−since / dryTime)`
   with `dryTime ≈ 28 s` × a noise factor so the dry line is ragged. The wet band
   follows the set's biggest run-ups and dries over half a minute.
5. **Wet sand look**: darker (× (1 − wet × porosity)), a little more saturated,
   roughness → 0.2, normals 40 % flatter.
6. It runs inside `If` in a TSL `Fn`, so every texture read in there needs an
   explicit mip level (WGSL): take it from the camera distance,
   `log2(dist × pixelAngle × texelsPerMetre)`.

### 7.6 Caustics by photon splatting (`render/caustics.ts`)

After Evan Wallace's *WebGL Water* (also Tidewater's approach):

1. A grid covering one tile of the ripple pattern **plus a margin** is drawn
   into a small float target (256² High, 128² Low) **every frame**, additive.
2. Each vertex samples the **same two ripple layers the water shows** (tiles
   9.9 m and 3.3 m, ratio 3, so the combined pattern repeats every tile), refracts
   the sun (`refract(−L, N, 1/1.333)`) and moves to where the ray lands on a floor
   plane `D` below, relative to where it lands under a flat surface.
3. The fragment writes `area before / area after` (from `dFdx`/`dFdy` of the
   rest and landed positions): exactly the light concentration, so focusing forms
   the bright network by itself and it moves with the ripples. Two planes
   (1.2 m in R, 3.0 m in G), blended by the real depth at lookup. Check it by
   reading the target back (`readRenderTargetPixelsAsync`): the mean must be ≈ 1
   (energy conserved); a flat network means too little focusing — gentle detail
   normals at shallow depth barely focus, so the splat scales the ripple slopes
   by 1.5.
4. The ground looks it up where **its sun ray entered the water**
   (`p.xz − refractedShift × depth`) and adds `(I − 1) × direct sun × albedo`,
   faded with depth.
5. Write the vertex as `vec4(x·2−1, 1 − y·2, 0, 1)` via `material.vertexNode`:
   texel row 0 is NDC y = +1 on both backends (three flips WebGL render-target
   reads to match WebGPU), and make the grid `DoubleSide` (the flip reverses the
   winding, and refraction can fold triangles).
6. Vertex-stage texture reads need `.level(0)` (WGSL has no implicit LOD there).
7. High draws the lagoon's tile at 512² from a 192-cell grid (2 cm texels): at
   256² the network smeared into blobs a metre from a diver's mask.
8. Dispersion (lagoon): the floor looks the tile up **once per colour**, each at
   the entry point of that colour's sun ray (water's index 1.3291 red, 1.333
   green, 1.3369 blue). The focal depth differs by under 1 %, so one tile serves
   all three; only the entry point moves, giving thin coloured fringes that grow
   with depth. Not worth it in Field Line's 0.4–1.2 m lake (fringes < 0.6 cm).

### 7.7 Interactive ripples (`render/rippleField.ts`, shared by all three games)

Splash rings used to be analytic: a uniform array of 24 sources, each summed
in every water pixel. That costs a loop per pixel over the whole lagoon,
cannot show a wake (a moving source would need a new slot every frame), and
rings run straight through sand banks. The replacement is a small height field
stepped on the CPU:

1. **Grid**: 128² cells (96² on Low) round the camera — 0.2 m in Field Line
   (26 m), 0.25 m in the lagoon (32 m), 0.5 m in Tanks (64 m). Two time levels
   and a land mask (`isWater(x, z)`: the ground under the still water level).
2. **Step**: the damped wave equation at a fixed 30 Hz,
   `h' = (2h − h₋ + C²·∇²h)·damp`, `C = c·Δt/Δx`, five-point Laplacian, at most
   three steps per frame. With c = 1.1 m/s (lake, lagoon) or 2.4 m/s (Tanks) C²
   stays far below the 2-D stability limit of 0.5. Land cells are held at 0, so
   rings reflect off banks and islets. The steepest part of a ring trails its
   leading front (at c·t) a little, as 2-D waves do.
3. **Upload**: central-difference slopes go into an RGBA8 texture (R, G =
   ∂h/∂x, ∂h/∂z in ±0.6; B = |h| as agitation, 1 at 12 cm), linear filtered.
   The water shader reads it once per pixel and leans the normal against the
   gradient; B above ~0.35 adds froth, so a blast or a heavy stone churns the
   surface and a wading wake (a few cm) does not. Cells at the window's edge
   are held flat and the sample fades there.
4. **Following**: the window re-centres in whole cells once the camera has
   moved 12 cells, shifting both time levels and the mask, so a ring stays put
   in the world. Only newly exposed cells call `isWater`.
5. **Idle**: once every |h| is under 20 µm the field zeroes itself, uploads one
   flat frame and stops stepping, so calm water costs nothing on the CPU.
6. **Sources**: `disturb(x, z, radius, depth)` pushes a raised-cosine dip.
   Splashes call it once (stone: radius 0.12 + 0.15·s, depth 0.012 + 0.04·s;
   shell: 0.9–2.1 m, 0.25–0.45 m); anything moving through water calls it every
   frame scaled by `dt·60` (legs: 0.3 m, ≤ 4 mm; tank bow: 1.4 m, ≤ 3 cm), so
   the wake does not depend on the frame rate.

Cost: one 128² step is ~16 k cell updates (≈ 0.1 ms in V8), plus a 64 KB
texture upload per frame while anything moves. It needs no render target, so
it behaves the same on the WebGL 2 fallback. Tests: `tests/rippleField.test.ts`
in Field Line (ring speed, calming down, land held still, re-centring).

### 7.8 Swash at lake scale (Tanks `world/terrain.ts`)

The lagoon's swash (§7.5)
comes from its baked shore field; a small upland lake has no swell, only wind
chop, so Tanks fakes it cheaply in the terrain shader: a film runs up to
4–22 cm above the still level and back, with the same phase as the lake
shader's shore-foam fronts (`sin(1.22·t + noise)`), the bank stays dark and
glossy up to the highest run-up, and a lacy foam line rides the film's edge.

### 7.9 Open-sea FFT (lagoon `render/ocean.ts`, shared with Tanks)

Deep water
(fading in from 2.5 m to 10 m depth) takes its detail normals from a
Tessendorf FFT: a 64 m patch (256² High, 128² Low) sampled twice at different
scales and a rotation, scaled with the storm's wave height. The tiled ripple
normals stay at full strength over the shallows, because the caustics pass
splats exactly those, and at half strength in the deep for detail finer than
the FFT grid. The FFT runs every frame (spectrum, 2·log₂N butterfly passes,
resolve with mipmaps); its targets are filed under "water" in the pass timer.
Each pass writes its result through `fragmentNode`, not `colorNode`: the
colour path clamped every channel at 0 and forced alpha to 1, which turned the
signed spectrum into garbage (a straight band of nonsense slopes across the
water in both games). Checked by reading the target back and comparing with a
CPU DFT of the same spectrum (max difference 2·10⁻⁴).

**Domain warp against tiling** (`render/waveWarp.ts`, shared file for file by
the lagoon and Tanks; after ClearWater6.1's `wave_warp`, SamG-Coder, MIT). Even
two rotated lookups of a 64 m patch show their period as a grid towards the
horizon. Look the patch up at `xz + (n₁ − ½, n₂ − ½)·A` instead, with n₁, n₂ two
C²-continuous (quintic) value noises over cells four patches wide and A ≈ 0.7 of
the patch, and carry the slope through the warp's Jacobian
`(I + A·∇n)ᵀ` so the normals still belong to the drawn surface. Cost: eight
hashes and a few multiplies per pixel.

### 7.10 Sun glints by pixel footprint

A fixed specular exponent either sparkles (single pixels flicker on and off far
out) or is dull near the swimmer. Take the footprint `f = |fwidth(p.xz)|` (metres
of water per pixel) and set the exponent to `mix(90, 900, 1/(1 + 800 f²))`,
scaling the lobe's amplitude with the exponent so its energy stays constant:
a tight star close by, a soft glitter path far out, no aliasing in between
(ClearWater6.1). On a lit material (Field Line's lake) do the same through the
roughness: `0.04 + 0.18 · (1 − 1/(1 + 800 f²))`.

### 7.11 Sand ripples on the shallow bed (lagoon `render/ground.ts`)

Wave-formed ripples about 20 cm apart, after ClearWater6.1's `sand_relief`:
`h = A(cos φ + 0.18 cos(2φ + 0.6))` (sharp crests, flat troughs) with
φ = k·(xz·d) + bend, d the swell's propagation direction from the baked shore
field, bend a slow noise, plus a weaker family 26° off. The normal comes from the
analytic gradient (never tiles); weight it by sand coverage, 0.1–4 m depth,
swell exposure and `1/(1 + 600 f²)` so it cannot shimmer. Under water the
caustic light dominates, so tilt the caustics' N·L by the same gradient, or the
ripples barely show.

### 7.12 Screen-space reflection on water (`render/screenReflection.ts`, High only)

The sky alone is a poor mirror: at the grazing angles where Fresnel makes water
most reflective, the palms, pines, rocks and boats belong in it. The water is
drawn after the opaque scene, so it can march its own reflected ray: 20 points
along it in world space (0.3 m growing ×1.45, out to ~350 m), each projected to
the screen and compared with a copy of the depth buffer; a point less than a
step's thickness behind the scene is a hit, refined by 4 bisections; the scene
colour there is the reflection, faded over the last tenth of the screen edge and
mixed over the analytic sky by its weight. Rules learnt:

- **Unroll it**, no `Break`: WGSL forbids implicit-LOD sampling in non-uniform
  control flow. Only assignments go inside `If`.
- **The depth copy must match the depth buffer's format.** three's shared
  `viewportDepthTexture()` copy is `depth24plus`; a reversed depth buffer is
  `depth32float`, and every frame's copy then fails ("Source and destination
  formats do not match"). Construct `new ViewportDepthTextureNode(uv, null, t)`
  with your own `DepthTexture` whose `type = FloatType` when
  `builder.renderer.reversedDepthBuffer`.
- **One base depth node, sampled through `.sample(uv)` clones.** Each viewport
  texture node keeps its own copy of the framebuffer when drawing into a render
  target, so 24 separate nodes meant 24 copies and 24 texture bindings (WebGPU
  allows 16 per stage: the water pipeline was invalid). Clones made by
  `.sample()` share their base node's copy and binding.
- **Capture loop values before `If`.** TSL runs an `If` body later, when the
  shader is built, so a JS `let` changed by the unrolling loop is read at its
  final value in every branch (all twenty branches stored the last step's
  bounds and no hit ever refined). Copy it into a `const` inside the loop body.
  Likewise freeze a bisection midpoint with `.toVar()` before reassigning the
  bounds it is made of.
- `perspectiveDepthToViewZ` already handles reversed depth.
- Thickness grows with the step (`max(0.5 m, 1.2 × step)`) so thin trunks are
  hit but a ray passing far behind a foreground rock does not pick it up.
- **Check that the refined point lies on the surface.** A true intersection
  converges: ray depth and scene depth meet. A ray that only passed behind an
  edge converges onto the depth discontinuity and the gap stays wide; drop the
  hit when the gap exceeds about the final interval (it painted bright sand
  patches far out in the water).
- Debug it with false colour, not by eye: write `found`, the gap, the hit
  distance or the hit's height into the reflection channels, and show the
  mirror alone (`mix(under·0.2, reflection, max(fresnel, weight))`). Long
  vertical streaks of bright objects on rippled water are physical (the
  ripples tilt the rays), not a bug.
- Used by the lagoon (water shader), Field Line (lake emissive, the probe's
  specular scaled by `1 − weight`) and Tanks (lakes).
- The frame governor switches it off through a uniform (a branch on a uniform
  is uniform control flow) right after the sun shafts, before resolution.

---
## 8. Phones: budget and stutter-proofing

Target here: a Pixel 9 Pro XL in an Android WebView (WebGL2 fallback is common).

**Lesson:** "the picture looks low-res on the phone" was the 1× pixel-ratio cap
on touch screens, not a missing effect. Render phones at 2× (sharp on any screen
a hand holds; native 3× would triple the cost), keep TRAA on every preset, and
let the frame governor take the resolution down when it must. Contrail exposes
the choice as High / Balanced (cheaper effects, still 2×) / Fast (1×).

### 8.1 Presets

| Setting | High | Low (default on touch devices) |
|---|---|---|
| Pixel ratio | device (up to 4) × render scale; 2 on touch screens | 2 on touch screens (a "Fast" preset: 1) |
| TRAA + sharpen | on, sharpen 0.3 | on, sharpen 0.25 (the velocity target is drawn anyway; FXAA left the phone picture soft) |
| Frame governor floor | render scale 0.58 | render scale 0.42 (steps 0.5, 0.42 added for 2× phones) |
| Sun shafts | 16+ samples | 0 samples (pass skipped) |
| Shadows | 4 cascades, 2048–4096 px | 2 cascades, 1024 px |
| Leaf translucency | on | off |
| Tree LOD / shadow ring | 110 m | 60 m |
| Grass density / draw distance | 1 × / 48 m | 0.3 × / 26 m |
| Undergrowth, jungle cards, far trees | full | thinned |
| Caustics target / grid | 256² / 128 | 128² / 64 |
| Environment probe | 256 px | 128 px |
| Auto-exposure readback | every 6th frame | every 6th frame |

### 8.2 Budgets to watch

- **≤ 16 sampled textures per shader stage** (see §2).
- **Draw calls × shadow cascades**: every shadow-casting mesh is drawn once per
  cascade. 256 small chunks × 4 cascades tripled the draw calls; one streamed
  mesh per kind fixed it.
- **Triangles in shadow passes**: cast shadows only from what is near.
- **Overdraw** of alpha-tested grass and leaves: density and draw distance on Low.
- **GPU→CPU readbacks**: throttle.
- **Load time**: share expensive bakes (heights), avoid per-cell allocations in
  hot loops (the wave-field solver went from 1.9 s to ~0.4 s).

### 8.3 Stutter: compile every pipeline behind the loading screen

"Stutters now and then" on a phone is almost always a **shader or pipeline built
mid-game**. The three.js r186 rules we had to learn:

1. `renderer.compileAsync(scene, camera)` **skips hidden objects and objects
   outside the camera frustum**, and compiles for the plain framebuffer, not for
   the post-processing scene pass (half-float colour + velocity MRT). So also
   render **one real frame** with the full post chain.
2. The shader cache key includes: the material, the vertex layout (attribute names,
   item sizes, normalisation), `receiveShadow`, the **light set** (which lights,
   which cast shadows), `scene.environment`/fog, and **for instanced meshes the
   mesh itself (uuid)**.
3. **Warm-up** (`render/warmup.ts`, identical in both games): traverse the scene,
   take **one object per cache key**, force it (and its ancestors) visible,
   un-culled and with `count ≥ 1`, render the real pipeline once, restore.
   Run the same reveal around `compileAsync`, and restore as soon as it returns
   or times out (it collects its objects synchronously).
4. **The scene pass renders at most once per animation frame** (three's
   `NodeFrame.frameId` advances in the renderer's own animation loop). Our
   warm-up first rendered a normal frame and then the reveal frame *in the same
   animation frame*, so the reveal frame drew nothing and nothing hidden was ever
   compiled. **Await a `requestAnimationFrame` between them.**
5. **Pre-compile with instanced meshes non-empty** (fill streams at the spawn).
6. Bound `compileAsync` with a timeout (20 s) and catch its failure, so a slow or
   failing pipeline can never leave the player on the loading screen.
7. Everything that can appear later must exist in the scene at load: holstered
   weapons, the first muzzle flash, decals, particles, rain, night lights (at
   intensity 0), prop "gallery" copies. Never add a light or toggle `castShadow`
   during play.
8. Share materials between props (a cache), never create a material or a canvas
   texture mid-game.

**Proof it worked** (§9.3): in both games the pipeline count after loading stays
constant through equipping weapons, firing, storm, night, turning around and
teleporting across the map.

---

## 9. Verification

### 9.1 Every change

1. `npx tsc --noEmit -p .` and the unit tests (`npx vitest run`).
2. A production build served statically (`vite build --outDir …`, `npx
   http-server …`). **Not** the Vite dev server for screenshots: HMR reloads kill
   long headless runs.
3. Headless Chromium with SwiftShader
   (`--use-angle=swiftshader --enable-unsafe-swiftshader`), `?autostart&debug`
   hooks to skip the menu, script input and read stats. SwiftShader is slow
   (minutes per frame with vegetation): keep the viewport small for numbers,
   640×360 for looks, and give screenshots long timeouts.
4. Look at the image. Then take **frames several seconds apart** for anything that
   moves (waves, swash, foam, caustics).
5. **Phone emulation**: a context with `deviceScaleFactor: 3, isMobile: true,
   hasTouch: true` at ~800 × 380 checks the touch layout and that the canvas
   really renders at 2× (`canvas.width / clientWidth`).
6. **Do not judge flight or driving behaviour headless**: SwiftShader's frame
   rate makes wall-clock key presses a fraction of their simulated length (§14).
   Fly the simulation in unit tests and use the browser for pictures only.

### 9.2 Numbers to log: the measurement routine

`drawCalls`, `triangles` (from `renderer.info`), CPU and GPU frame time per
pass, load time — and for any performance change **the same numbers before and
after at the same fixed views**. All three games share `render/perf.ts` file
for file:

- **Fixed benchmark spots** (`app/bench.ts` per game): spawn, spawn turned
  round, and the heaviest views of the map (Field Line: squad ground,
  extraction, the lake; Lagoon: shore, jungle, outpost deck, islet). A spot is
  a position and a look direction, nothing random.
- **Benchmark run**: pause menu → *Benchmark* (on the phone, where real numbers
  come from), or `?autostart&bench` in a browser. Logic is paused, the
  governor is off, each spot settles 45 frames (streaming, exposure, a GPU
  timer batch) and records 120. One row per spot: fps, p95 frame time, CPU
  render time, calls, triangles, GPU ms per pass. *Copy* puts the table on the
  clipboard for the report.
- **Headless**: `node scripts/benchView.mjs --save before`, change, then
  `--save after --compare before` (Playwright; `PLAYWRIGHT_MODULE` points at a
  global install). Calls and triangles are exact anywhere; SwiftShader times
  only compare runs on the same machine.
- **GPU time per pass** (`PassTimer`): the renderer is created with
  `trackTimestamp: true` and a custom `renderer.inspector`. Three calls
  `inspector.beginRender(uid, scene, camera, target)` for every render and
  writes a timestamp pair under the same uid; the inspector sorts uids into
  groups (main scene + eye camera = `scene`; main scene + any other camera =
  `shadows`; a `QuadMesh` = `post`; offscreen targets registered by name, e.g.
  caustics = `water`, the rifle scope = `scope`). Every 12 frames
  `renderer.resolveTimestampsAsync('render')` fills
  `backend.timestampQueryPool.render.timestamps` (uid → ms); sum per group,
  divide by the frames in the batch. WebGPU needs the `timestamp-query`
  feature (Chrome quantises to 100 µs); WebGL2 needs
  `EXT_disjoint_timer_query_webgl2`, which most phones lack — the overlay then
  says "n/a" and CPU numbers carry the comparison.
- **CPU time per section** (`CpuTimer.lap`): update, streaming, scope, water,
  submit (the render call itself).
- **F3 overlay**: fps, frame ms, governor level, CPU and GPU breakdowns, calls,
  triangles, EV, backend.

### 9.2b Frame governor (dynamic resolution)

`FrameGovernor` (from Tanks, now shared) holds 60 fps by trading image
quality, never gameplay. Each one-second window it takes the 70th and 90th
percentile of frame intervals: p70 over 1/52 s → one step cheaper (quickly,
2.5 s cooldown); p90 under 1/58.5 s for 8 windows → one step better (slowly),
never back to a level that just failed (60 s memory). Isolated hitches don't
move it. Steps, cheapest loss first: sun shafts off (a uniform loop count, so
no recompile), then render scale 100 → 87 → 76 → 67 → 58 %. **A switch must
not recompile** — uniforms and render-target size only — or the governor
measures its own hitch. Added here: a run of steps down is judged after two
steps; if p70 did not improve by 8 % (a display capped at 30 Hz, a CPU-bound
frame), it goes back up and stays for a minute instead of blurring the image
for nothing. Off in benchmarks; a settings toggle for players.

### 9.3 Pipeline tracer (catches stutter sources)

```js
const pl = renderer._pipelines;              // three r186 internals, test only
const orig = pl.getForRender.bind(pl);
window.__new = [];
pl.getForRender = (ro, promises) => {
  const before = pl.caches.size;
  const res = orig(ro, promises);
  if (pl.caches.size > before) window.__new.push(`${ro.material.name}@${ro.object.name}`);
  return res;
};
```

Install it after loading (or during loading via `addInitScript` polling for the
renderer, to see what the warm-up itself compiles), then drive the game through
everything a player can do — equip each weapon, fire, change weather and time,
turn around, teleport across the map — and require **zero** new pipelines.

### 9.4 Unit tests worth having

- Pure functions: terrain heights, the wave-field solver (dispersion limits, fronts
  turning to the beach, energy through a channel), map generators.
- Streaming: a refill never exceeds capacity and always contains every instance
  within the radius (compare as float32!), near + far sets cover each instance once.

---

## 10. Quality checklist for a coastline (use as acceptance criteria)

Condensed from the "Real-Time Coastal Simulator" prompt in
`hajimetwi3/hajimetwi3-prompt-okiba` (MIT); ✔ = done in the lagoon.

- ✔ Beach, seabed, water surface and swash share one height/depth dataset.
- ✔ Waves slow, shorten and bend with depth; grow in the shallows; break where
  depth-limited; lose energy after breaking.
- ✔ Waves are individuals (sets, along-shore variation): no whole-coast
  synchronised line, no identical breakers.
- ✔ Foam has a history (made at the break, carried, decaying into lace) — **no
  periodic white bands parallel to the shore**, no rectangular foam edges.
- ✔ Swash runs up, slows, drains back; the wet line follows the recent run-ups and
  dries over time with a ragged edge — no fixed blue strip on the sand.
- ✔ Wet sand darker, slightly more saturated, smoother, glossier; not a mirror,
  not black paint.
- ✔ Shallow water shows the floor; colour from absorption along the real path, not
  a depth gradient; not swimming-pool cyan.
- ✔ Caustics tied to the surface and the sun direction, not a scrolling texture.
- ✗ Underwater view, surface crossing, total internal reflection (the lagoon's
  player wades, does not swim).
- ✗ Plunging lip, spray, stranded foam simulation (Tidewater does these on the
  GPU; too heavy for the phone budget here).
- Check at 0 s, 5 s, 20 s, 60 s; max and min storm settings; low sun; phone preset.

---

## 11. three.js r186 pitfalls (quick list)

| Symptom | Cause | Fix |
|---|---|---|
| Stuck at "compiling shaders" on phones; ground vanishes on desktop WebGPU | > 16 textures in one shader | texture arrays; count bindings |
| Cloned foliage draws solid quads | `NodeMaterial.copy()` loses `alphaTest` | restore after `clone()` |
| Leaves solid with `alphaToCoverage` | A2C without MSAA disables alpha test | leave A2C off with TRAA |
| Hitch when walking through vegetation | per-`InstancedMesh` shader build | one streamed mesh per kind |
| Hidden things compile on first use | `compileAsync` skips hidden/culled | reveal one per cache key + warm frame |
| Warm-up frame compiled nothing | pass renders once per animation frame | await rAF before the warm frame |
| Instanced plants visible only in shadows | pre-compiled while `count = 0` | fill before compile; reveal with count ≥ 1 |
| Hitch at dusk/dawn | toggling `castShadow` | never toggle; fade intensity |
| Hitch every sky re-bake | new PMREM target per bake | re-bake into the same target |
| Black environment | sky dome beyond the probe camera's far plane | scale the dome inside it |
| Float32 data texture blurry/wrong on some GPUs | float32 not filterable | nearest + manual bilinear with `textureLoad` |
| Vertex-shader texture read fails on WebGPU | implicit LOD in the vertex stage | `.level(0)` |
| Render-target lookup mirrored | NDC y vs texel rows | write y inverted; texel row 0 = NDC +1 on both backends |
| Test compared positions wrongly | buffers are float32 | compare `Math.fround` values |
| A second camera's picture (scope, mirror) shows upside down | texel row 0 of a render target is the top of its image on both backends | sample it with `v = 0.5 − y/2`, not `0.5 + y/2` |
| `Cannot read properties of null (reading 'If')` at load, game never ready | `If` / `Loop` / `toVar` used outside a TSL `Fn` | build that code in `Fn(([a, b]) => …)` and return a vector |
| WGSL compile error: sampling in non-uniform control flow | `texture()` with implicit LOD inside `If` (WebGL accepts it, WebGPU does not) | pass an explicit `.level()` computed outside the branch (e.g. from camera distance) |
| WebGPU only: `Failed to execute 'createView' … 'swizzle' … not of type 'GPUTextureComponentSwizzle'`, never finishes loading | three r186 sets `swizzle: 'rgba'` on every texture view; older Chromium/WebView builds (e.g. 140) implement an older swizzle draft | shim `GPUTexture.prototype.createView` to retry without the (identity) swizzle (`render/webgpuCompat.ts`), installed before the renderer |
| Headless tests only ever exercise WebGL2 | Playwright's headless shell has no WebGPU adapter | full Chromium with `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface` gives a software WebGPU adapter: test WGSL there too |
| Software WebGPU: "A valid external Instance reference no longer exists", device lost at once | Chromium 141 headless loses the device as soon as a canvas context is configured/presented (a bare device without a canvas lives) | test-only init script that replaces `GPUCanvasContext.configure/getCurrentTexture` with an ordinary texture (`benchView.mjs --no-present`): nothing is shown, every shader still compiles and errors still surface |
| Headless test hangs with an idle browser | a page error stopped loading; the script waits for "ready" | always log `pageerror` and console errors; time out early |
| A data pass (FFT, simulation) into a float render target gives garbage; one straight band of nonsense across the water | through `colorNode` a node material clamps each channel at 0 and forces alpha to 1 when opaque, so signed data and anything in `.w` are lost | write the result with `material.fragmentNode` (skips the colour and output stages), `transparent: true, blending: NoBlending`; verify against a CPU reference by reading the target back |
| High preset only, WebGPU: a straight line across the middle of the screen and grain over the ground | GTAO at `resolutionScale < 1` gathers four depths and keeps the min (the farthest with a reversed depth buffer); occlusion multiplied in after TRAA leaves its per-pixel noise un-averaged | GTAO at full resolution (fewer samples), applied to the scene colour before TRAA with `useTemporalFiltering = true` (Tanks `render/pipeline.ts`) |
| Every frame, WebGPU: `copyFramebufferToTexture: Source and destination formats do not match. depth32float depth24plus` | `viewportDepthTexture()` copies into a shared `depth24plus` texture, but a reversed depth buffer is `depth32float` | own `DepthTexture` with `type = FloatType` passed as the third argument of `ViewportDepthTextureNode` (§7.12) |
| Water pipeline invalid: "number of sampled textures (32) … exceeds the maximum per-stage limit (16)" after adding a screen-space march | every `viewportDepthTexture()` / viewport texture node keeps its own framebuffer copy and binding | build one base node and read it with `base.sample(uv)` (§7.12) |
| A branch built in an unrolled JS loop uses the wrong (last) loop value | an `If(cond, () => …)` body runs when the shader is built, after the loop has finished | copy the loop variable into a block-scoped `const` before `If` (§7.12) |
| Sand (or any splat) shows little squares | a texture sampler that paints whole hash cells (`floor(u·64)`) | draw a rotated soft ellipse inside the cell instead |
| Read-back rows look mirrored on WebGL only | `readRenderTargetPixelsAsync` flips WebGL rows to match WebGPU | compare with row `N − 1 − y`; `screenCoordinate` and `textureLoad` agree on both backends |
| A post-pass effect that needs world positions (aerial perspective, clouds) reads nothing or the wrong place | inside a post pass `cameraPosition` / camera matrices are the full-screen quad's camera | pass the scene camera's `projectionMatrixInverse`, `matrixWorld` and position as `uniform(...)` (Contrail `render/stage.ts`) |
| Distances from depth wrong by orders of magnitude on WebGL only (haze everywhere or nowhere) | `getViewPosition` maps depth to −1…1 under WebGL, but with `reversedDepthBuffer` the WebGL backend switches clip control to 0…1 | unproject yourself with NDC z = depth when the buffer is reversed (or on WebGPU), `depth·2 − 1` otherwise |
| Sky pixels (reversed depth 0) get "near" treatment | the far plane is not infinity; unprojecting depth 0 gives garbage | `select(depth <= 0, hugeDistance, length(viewPos))` |
| Scene colour reads black inside a `select` branch of a post pass | the pass texture node used as `colour.rgb` inside the branch | sample explicitly: `colour.sample(uv).rgb` |
| TRAA shows a smeared or black frame after an expression was inserted before it | TRAA re-samples its input at reprojected positions and needs a texture | wrap the expression in `convertToTexture(...)` before `traa(...)` |
| Debug colour views all grey or white | bloom spreads huge debug values (e.g. 1e7 for the sky) over the whole screen | clamp debug outputs to 0…1 before the post chain |
| WebGPU only: `TextureViewDimension::e2D … not compatible with … e3D` for a `Data3DTexture` sampled in an `rtt()` pass (setting `is3DTexture` does not cure it) | r186's WebGPU backend binds the volume through a 2-D view | store the volume as a 2-D atlas of z slices with a one-texel wrapped border and lerp two bilinear fetches (Contrail `render/clouds.ts` `volumeAtlas`); identical on WebGL2 and phones |
| Volumetric clouds cover the whole sky at "50 %" coverage | raw Perlin-Worley values bunch around 0.6–0.8, and a column is cloudy if any height in it is | histogram-equalise the baked noise and calibrate the threshold against measured column coverage in a unit test |
| Contrails, flames and other transparents vanish whenever a cloud lies behind them | a cloud (or fog) composite in post only knows the depth of opaque surfaces, so it covers anything transparent | put those objects on their own layer and draw them in an overlay `pass()` (`setLayers`) composited after the clouds, hidden behind opaque surfaces by comparing fragment depth with the scene pass's depth texture (Contrail `render/stage.ts`) |
| An overlay pass composites as solid black | a pass referenced from inside `convertToTexture` (RTT) renders after `resetRendererState`, which clears to opaque black, ignoring your clear alpha | store transmittance in alpha instead of coverage: blend colour premultiplied and alpha as `dst × (1 − α)` (`overlayBlending`), composite `base × a + rgb` |
| Ray-march grain shows as diagonal stripes in fast flight | interleaved gradient noise has a diagonal structure; TRAA rejects history while the scene moves fast | add per-pixel white noise to the IGN offset, and refine the step after the first hit inside the medium |
| `bumpMap(expression)` on a procedural pattern (panel lines, seams) does nothing | `BumpMapNode` re-samples its input as a texture at offset UVs; an expression has no UVs to offset, so its gradient is zero | build the perturbed normal from the expression's own screen derivatives (`h.dFdx()`, `h.dFdy()`, Mikkelsen's surface gradient), as `bumpNormal` in Contrail `render/jetMaterials.ts` |
| Procedural panels stretch and squeeze across a curved hull | the pattern is drawn in model space (x, y, z), which is not the skin | write a skin-coordinate attribute in metres (along, arc length around) while building the geometry and draw panels in that |
| Fine lines (seams, rivets) shimmer or thicken into dark bands at a distance | an `smoothstep(w, w + fwidth)` edge keeps every line at least a pixel wide | scale the line's coverage by `2w / fwidth` so sub-pixel lines fade instead of thickening (`lineAA`) |
| Every tree past ~200 m upside down | impostor atlas rows read bottom-up; render targets are top-origin on both backends | `v = species + (1 − corner.y)` (§5.5); check impostors alone, close up |
| GPU-generated forest grows in neat rows ("orchard") | TSL `hash()` casts its seed to `uint`, so negative world cells all hash alike | `fract(sin(dot(cell, vec2(12.9898 + k·1.37, 78.233 + k·2.71)) + k·0.618) · 43758.5453)` and a full-cell jitter |
| WebGL: "Active draw buffers with missing fragment shader outputs" when baking into an MRT target | render-target textures not named like the MRT outputs | `target.textures[i].name = 'albedo'` etc., matching `mrt({ albedo, normal })` |
| "No stack defined for assign" from a material callback | nodes that assign (`toVar`, `assign`) built outside a `Fn` or callback | build them inside the callback that runs at compile time (e.g. inside `receivedShadowNode`) |
| Cockpit displays flicker | screen plane coplanar with its bezel's face (z-fighting) | 3–4 mm proud; mipmapped canvas texture so text stops shimmering under TRAA |
| A delayed one-shot sound (far explosion) plays at full volume at once | an `AudioParam` holds its default (gain 1) until its first scheduled event | `gain.value = 0` before scheduling, or `start(at)` the source at the event time |
| Android flavour's own `signingConfig` ignored | a build type's `signingConfig` overrides the flavour's | set the default on `defaultConfig`, override per flavour |
| Low cloud layer turns blocky on phones | one bilinear tap upsampling a ¼-resolution layer | a 4-tap tent when the layer is below ½ resolution |
| Lamp-lit or other night-only shading in an `If(uniform)` branch: fine at night, by day façades mirror the sky and blocks go black | TSL declares a shared variable (`normalWorld`, `normalWorldGeometry`) where it is first built; built first inside the branch, it is only assigned when the branch runs, and the material's own lighting reads it unset | build it before the branch: `const out = normalWorld.mul(0).toVar()` (FL `materials.ts` `lampLit`) |
| Lit windows (or any per-object hash) speckle pixel by pixel | the hash key uses `normalWorld`, which carries the normal map | key on `normalWorldGeometry` |
| Camouflage or coat patterns slide over a moving instanced figure; countershading follows world height | in an instanced mesh `positionLocal` is the position *after* the instance matrix | key segment-space patterns to `positionGeometry` (§6h) |
| Paired limbs or wheels instanced with a mirrored matrix render inside out | instanced draws set the front face per mesh, not per instance | build both sides from symmetric geometry; never negate an axis per instance |
| Shaded faces turned toward the camera (a vehicle's rear, trunks, walls) render near black on High only | three r186's GTAO under a reversed depth buffer marks them fully occluded (seen in its AO target: black on every camera-facing plane, white on the ground); depth-derived normals and a flipped depth both make it worse; the pipeline multiplied the whole colour by it | compare High with a no-AO preset at one view before trusting AO; Tanks runs without GTAO until it is fixed upstream |
| Road paint, bullet holes, tracks and scorch marks never show | the renderer uses a reversed depth buffer (near = 1), and three.js passes `polygonOffset` to the GPU unflipped: a negative bias pushes the decal *behind* its surface | with `reversedDepthBuffer: true`, use positive `polygonOffsetFactor` / `Units` |

---

## 12. Large worlds: flight and vehicle simulators

**Games:** Contrail (`contrail/`, jets over 100 km), Ridgeline (`ridgeline/`, an
attack helicopter over 20 km of ridges). What changes when the player covers
kilometres a minute and sees 100+ km.

### 12.1 Terrain at map scale

1. **Bake the height function into float grids at load**, not per query: a near
   grid (Contrail 102.4 km at 50 m, Ridgeline 20.48 km at 10 m) and a coarse far
   grid to the horizon, read by the CPU (collision, radar altimeter, AI line of
   sight, placement) and the GPU (vertex stage) with the **same bilinear**. What
   you see is what you hit.
2. **Bake on all cores**: split the grid into bands of rows and post each band
   to a module worker (`sim/terrainWorker.ts`, `onWorkers`/`bakeGridParallel`),
   with a single-thread fallback when workers are missing. The normal and
   land-cover maps are baked the same way, each band with one extra row either
   side. A unit test checks that the band bake equals the single-thread bake.
3. **CDLOD** (Strugar 2009): a quadtree selected on the CPU by distance and
   frustum, drawn as **one instanced mesh** of 32 × 32-cell patches; each vertex
   reads four heights (`textureLoad`, the same bilinear as the CPU) and morphs to
   the coarser level over the last quarter of its range. No cracks, no pops, one
   draw call. Tune leaf size, levels, leaf range and the node cap per game
   (Contrail 1600 m / 10 / 3600 m / 1000; Ridgeline 320 m / 10 / 760 m / 900).
4. **Earth curvature** in the vertex stage (`d²/2R` drop) and the same drop for
   the cloud layer, so the overcast meets the horizon.
5. **Rock and snow from slope**, not height alone: rock strata (banded colour)
   only on cliff patches, snow that slides off steep faces, so ridges read
   from 10 km.
6. **Tried and dropped:** a hydraulic-erosion pass on the grid. Within the
   load-time budget it made silt lakes and streaks instead of valleys. The
   relief now gets its look from light (§12.2) and resolution, not erosion.

### 12.2 Mountain shadows and sky occlusion, baked on the GPU (`render/terrainShadow.ts`)

Without them the relief is lit like a plastic model: every sun-facing slope
bright, every gully as open to the sky as a summit. Both come from **horizon
angles** over the near height grid, computed in **one full-screen `QuadMesh`
pass into a `RenderTarget`** (≈1 M texels × ~150 height reads: milliseconds on
a GPU, minutes on a CPU), and again when the sun moves (time-of-day change):

- **r = sun visibility**: march towards the sun with geometric steps (56 steps
  out to `sunM`: Contrail 20 km, Ridgeline 6 km); lit if the sun stands above the
  steepest terrain angle along the way, with a soft edge for the disc.
- **g = sky visibility**: the horizon angle in 8 directions × 14 steps out to
  `skyM` (3 km / 1.2 km); each contributes `1 − sin(horizon)`.

The terrain material multiplies the sun shadow by r inside
`receivedShadowNode` (with the cloud shadow) and feeds g to `aoNode`. Forests
(§12.3) sample the same texture so a tree in a ridge's shadow is dark too.

### 12.3 Forests generated on the GPU (`render/forest.ts`)

No list of trees anywhere. Each **ring is ONE instanced draw** of N × N
camera-facing impostor quads on a grid that moves with the camera in whole
cells; the instance index alone gives the cell (no per-instance attributes).
Per cell, a **hash** gives the jitter (a full cell, or rows show), the species,
the size and the yaw; a coarse hash makes stands and clearings. The vertex
stage reads the forest density (cover map: forest minus water and rock) and the
height (`texture().level(0)` in the vertex stage), and collapses the quad where
there is no forest. A 100 km map costs the same as a park, and a tree is always
in the same place when you come back.

- Two rings: dense and small near, sparse and larger far (Contrail High
  `{256 × 256, 11 m}` + `{192 × 192, 34 m from 1250 m}`; Ridgeline
  `{256, 7 m}` + `{192, 22 m from 800 m}`). Low uses fewer cells.
- Atlas: three procedural species (spruce of ruffled tiers, pine, broadleaf),
  8 views round the trunk **plus one from above**, unlit albedo and
  object-space normals through a named MRT. The top view blends in with the
  camera's elevation, so from altitude you see crowns, not edge-on cards.
- **Gameplay objects must not stand in it.** Vehicles parked "on the river
  bank" sat inside riverside woods and were invisible. Place them by querying
  the same cover function the bake uses (`sourceCover(...).forest`) and search
  outwards for open, level ground.

### 12.4 Sky, clouds and their shadows

- **Hillaire 2020 sky** (`render/atmosphere.ts`): transmittance, multiple
  scattering, sky-view and aerial-perspective LUTs, all quad passes written
  through `fragmentNode` (the colour path clamps raw data). Valid from the
  runway to 15 km+, unlike the Preetham sky. Sun, sky and haze share one
  pre-exposed scale.
- **Volumetric cloud slab** (`render/clouds.ts`): ray march at ½ (High) or ¼
  (Low) resolution inside the post chain, before TRAA (which averages the
  jittered start). Below ½ resolution, upsample with a **4-tap tent**, not one
  bilinear tap, or the edges turn to blocks on phones. Dual-lobe HG phase,
  Wrenninge's multiple-scattering octaves, Hillaire's energy-conserving steps,
  each pixel's cloud hazed at its transmittance-weighted depth.
- **Cloud shadows on the ground**: `clouds.shadeReceivers(scene)` wraps every
  receiver's `receivedShadowNode`, multiplying by the cloud's transmittance
  towards the sun (and by the material's own `userData.shadowFactor`, e.g. the
  terrain's horizon shadow). Build the cloud-shadow nodes **inside** the
  callback (see §11).
- The game logic reads the same density formula (`sim/cloudField.ts`), so
  what the player sees hiding him is what the AI cannot see through.
- **What made them read as clouds, not grey cotton** (Ridgeline, after a
  screenshot tour: soft blobs of one height, flat grey, blurred edges):
  1. **Cloud types in the weather map** (its G channel): a type 0…1 sets
     each cloud's relative top, 0.35 (flat stratocumulus) to 1 (cumulus to
     the layer's top), so one layer holds towers beside low heaps. The
     spread closes as the coverage reaches 1, or an overcast has holes.
  2. **Height profile**: a flat base rounded over the bottom 8 %, tapering
     over the upper half of the cloud's own top (towers narrow as they rise).
  3. **Detail erosion, Schneider's way**: two octaves of the Worley detail
     (the second 3.1× finer), its coordinates warped by the shape value
     (±130 m, curls the edges), and inverted above the base — wispy
     undersides, billowy tops. Detail voxels went from 50 m to ~7 m.
  4. **Billows in the shape volume** (its G channel, a Worley fbm with cells
     of 1.1 km to 280 m, fetched with the shape in one RG lookup): a remap
     `(shape − cut) / (1 − cut)`, `cut = 0.4 (1 − billow)`, carves grooves
     between cells and leaves domes. The light march sees them, so a body
     shades as heaped billows, not a smooth slab; zero extra fetches.
  5. **Hard edges**: density × 4, clamped to 1, after the erosion. The
     coverage remap ramps density over the shape noise's own scale (100 m+),
     a dozen pixels of fuzz from a few kilometres. Keep the gain in the
     light march and the ground shadows too, but march the light at **half
     the view extinction**, or the saturated cores go grey.
  6. **Sky occlusion inside the cloud**: the local density stands in for the
     column above (`exp(−ρ σ min(top − h, 250 m) · 0.25)`) and scales the
     ambient term. A real sample up there cost a fifth more per step and
     **lost the WebGL device** on SwiftShader (black frames, "context
     lost"): count fetches per step before adding any.
  7. **Beer–powder** (Schneider 2015) on the sun term, at 60 %:
     `1 − 0.6 exp(−140 σt)`, faded out towards the sun. Rims seen away from
     the sun darken and every billow outlines itself.
  8. **Overcasts are smoother**: billows and erosion scale by
     `1 − 0.6 c⁴`; at full coverage a deck otherwise comes out holed.
  9. Every one of these changes the coverage statistics: re-fit the coverage
     exponent against the test that measures cloudy columns (1.8 → 1.3
     here), on the CPU and in the shader together.

### 12.5 Vehicles, wrecks and effects in the open

- **Vehicles on slopes**: pitch and roll each model from four ground samples
  around it, every frame for movers.
- **Destroyed**: swap to a charred material, throw the turret askew; a smoke
  column as an `InstancedMesh` of dark puffs that rise, swell and drift on a
  loop (7 per wreck, one draw for all), plus a flickering emissive fire for
  the first ~40 s.
- **Emission in physical units on the overlay layer** (Contrail §11 trap):
  tracers (`LineSegments`, 1900 K × 60 000 cd/m²), motor flames, fireballs,
  wreck fires. Smoke and dust are lit scene geometry.
- **Smoke trails** of rockets and missiles: the contrail ribbon (`trails.ts`), a
  ring buffer of points drawn as one camera-facing strip, lit with a forward
  scattering lobe; its noise scale is for big trails, so keep widths ≥ 0.25 m.

---

### 12.6 The ground from a helicopter (Ridgeline)

A colour-only terrain shader (fields, heath, strata from noise) holds up from
1 km and falls apart below 100 m: the pad, a low hover and the pilot's seat
showed flat green plates. What fixed it, all from the other games' kits:

1. **One land-cover function for every consumer** (`render/landCover.ts`):
   world position, baked normal and cover map in; air-view albedo, the
   close-range layer weights (meadow, soil, rock, litter) and the grass
   density (tall sward, short stubble/heath, sedge, canopy shade) out. Pure
   ALU plus its inputs, so the terrain runs it per fragment and the grass per
   blade (vertex stage, `texture().level(0)` for the maps).
2. **Close-range layers as ratios** (`render/groundTextures.ts`, after Tanks):
   four procedural 512² layers (256² Low) with height in alpha and normal +
   cavity AO in a second array. The terrain multiplies its air-view colour by
   each layer's albedo **divided by the layer's mean**: the mips average the
   ratio to 1, so from altitude the land is exactly what it was, and from the
   pad it has blades, clods, pebbles, joints and needles. Height blend,
   stochastic tiling on High, rock projected on the slope's own plane, and a
   second lookup 7.3× coarser and rotated, which carries the pattern to a few
   hundred metres where the first has mipped away. Skip all lookups beyond
   4 km. Where the air view has no colour for a layer (worn heath, the floor
   under the crowns seen from below them), use the layer's own mean colour.
3. **Meadow mottling** (two noise lookups at 1.9 m and 7.3 m: tussocks,
   yellower and bluer patches), **worn bare patches**, **mower's swaths**
   (2.6 m bands, faded by 2.5 km before they alias), tracks as darker earth
   instead of white lines, and a wider per-field brightness range. Procedural
   noise has no mips: fade every such term out by distance.
4. **Real grass blades** from the shared `grassField.ts`, now taking the ground
   and the density as shader functions, fed from **two small maps baked
   round the camera** (105 m at 0.5 m texels, one quad pass each, again when
   the camera has moved 4 m): density (RGBA8) and colour + height (RGBA16F,
   height relative to the camera's ground). Evaluating the land cover and
   the mesh height per blade vertex (twenty noises, nine loads, half a
   million vertices) **lost the GPU device**. The height is the rendered
   mesh's own (`meshHeightNode`: level-0 vertices are the bilinear at the
   10 m lattice, cut b–c like the patch index buffer); blades take the
   colour of the field they stand in (`groundTint` 0.8); off above 90 m. The
   ridge shadow reaches them through `material.userData.shadowFactor`.
   Bake passes write `fragmentNode` (the colour path would clamp heights).
4b. **Matte blades** (`matte: true`: a physical material with
   `specularIntensity: 0`): a blade's shading normal leans up, so from a few
   metres up it is seen at a grazing angle where Fresnel reflects ~40 % of
   the sky; under Ridgeline's bright sky probe the meadow turned to frost.
   A Lambert material lost the sky's diffuse light too and drew black dashes.
5. **Rotor downwash**: `grass.blow(x, z, r, strength)` lays the blades outward
   from the hub's ground point and sets them thrashing (the trampling map's
   A channel, decaying in 0.35 s; the shader pulses the push and whips each
   blade across it at its own phase). Strength from the thrust over the
   weight, the rotor speed squared and `(1 − h / 2.5D)²`; radius
   `R · (1.7 + h/D)`; the trampling window follows the helicopter, not the
   chase camera (`update(..., focus)`), at 0.45 m cells (58 m).

## 13. Cockpits, displays and the HUD

- **Cockpit geometry relative to the eye** (x right, y up, −z forward): one
  layout serves several airframes; only the eye point moves. Model what the
  eye sees: glare shield, panel, sills, consoles, stick and collective, and in a
  tandem cockpit the front seat's station and helmet. The crew figure of the
  seat the camera is in is hidden; the canopy glass drops to ~0.1 opacity from
  inside (0.6 outside).
- **Live displays**: one 2-D canvas (512 × 256) redrawn ~10 times a second
  into a `CanvasTexture` (engine page with tapes, a heading-up map baked once
  as shaded relief). Rules learned the hard way:
  - **Constant output brightness** (`MeshBasicNodeMaterial`, colour × a level
    ~1.3), not lit and not exposed with the scene: an eye adapted to the cockpit
    reads them at noon and at dusk.
  - **Never coplanar with the bezel**: a screen flush with its frame's face
    z-fights and flickers. Put it 3–4 mm proud.
  - **Mipmapped** (`LinearMipmapLinearFilter`, anisotropy 4): a 512-px page
    shown at ~300 screen px aliases differently under each TRAA jitter, and
    thin text shimmers.
  - A second seat's view can be blocked by its own instruments; check every
    camera seat's centre of view and lower the hardware below the eye line.
- **Rotor blur**: blades as meshes while slow; from ~40 % rotor speed a disc
  whose shader draws each blade as its **exposure smear** (the angle swept in
  one frame, `ω·dt`, at least a few degrees), blended in by rotor speed.
- **HUD on a canvas**, symbology projected through the camera. Test "behind the
  camera" in view space (`z > −0.5` after `matrixWorldInverse`), not with the
  NDC z of `project()`, which misbehaves with a reversed depth buffer.
- **Weapon symbology** (Ridgeline `ui/hud.ts`): target diamonds for what the
  sensor sees; the gun cross where the turret's rounds land; a rocket cue ring
  at the impact point of a rocket simulated now with the **same fixed-step
  integrator** as real rockets (otherwise the cue and the hits disagree at
  grazing angles); a missile seeker box; a laser spot with its range.
- **An on-screen aim cursor** moved by the mouse or the right thumb; the sight
  line is the ray `vec3(cursorNdc, 0.5).unproject(camera) − camera.position`,
  marched against the height grid (growing steps, then bisection) for the aim
  point. The camera stays with the vehicle.

---

## 14. Controls and flight computers (what players actually asked for)

The rotor and jet models are physical; the **controls** decide whether anyone
can fly them. Each item below came from a player's complaint.

1. **Keys never flip.** W is nose down / forward, S nose up, whatever the
   "invert" setting; that setting belongs to a thumb stick only.
2. **A/D turn, Q/E rotate.** In a hover a sideways input is mostly a yaw (with
   ~30 % bank); with speed it blends to a banked turn the computer
   coordinates. Pedals stay pure yaw.
3. **The mouse aims, it does not fly**, once the game has weapons. It moves a
   cursor over the view; the camera and the aircraft carry on. Rotating the
   camera with the aim made fixed-weapon cues drift off the axis.
4. **On touch the right thumb never touches the flight controls.** A right-side
   drag that silently added to the cyclic made the helicopter "unstable".
5. **A flight computer is on by default** (SAS), off = the bare airframe:
   - **attitude hold**: the stick commands a pitch/bank attitude (±20° / ±29°),
     PI on attitude plus rate damping; at hover speeds the reference leans
     against drift so a centred stick settles into a hover;
   - **heading hold**: pedals command a yaw rate; the tail rotor is **fed
     forward from main-rotor torque** (`dir·Q / arm`), plus a PI on yaw rate.
     Without the feed-forward any collective change spun the aircraft at
     60–150 °/s; at speed a centred pedal asks for the coordinated turn rate
     `g·sin φ / V`;
   - **height hold with a neutral detent**: the power lever is a vertical-speed
     command (below the middle mark descend, at it hold, above it climb, ±8 m/s
     at the stops). The computer integrates the hover collective itself, moves
     it rate-limited (0.5 lever/s), stays under a 98 % torque limit (no
     wind-up while limited), keeps a straight-down descent under the vortex
     ring's onset (2.5 m/s at hover speeds, the full rate only with airspeed)
     and eases off near the ground for a soft touchdown. The touch lever springs
     back to the detent when released.
6. **Fixed weapons go where the nose points.** Rockets leave at the aircraft's
   speed *along* the pod line plus their launch speed, not inheriting a sideways
   drift (fins weathercock them at once); otherwise the cue sits off the axis.
7. **Turn-on tilt steering in flight** (a TILT toggle, CAL to set hands-off);
   iOS grants motion only inside a tap (`DeviceMotionEvent.requestPermission`).
8. **Test the controls in a unit simulation**, not by flying headless:
   SwiftShader renders a frame every few seconds, so a 25-second key press is
   two seconds of simulated flight. Tests here: hover, climb/hold/descend and
   soft landing, heading held through lever snatches, attitude step response,
   key mapping (W never flips, A yaws at hover and banks at speed), rockets on
   the axis while drifting.

## 15. Sources and credits

- **Tidewater** by Dan Greenheck (MIT), github.com/dgreenheck/tidewater — the
  eikonal shore-wave field, the per-wave height model and swash run-up, the lace
  foam idea, and photon-splat caustics. Ported and simplified for phones here;
  credited in the file headers.
- **"Real-Time Coastal Simulator"** prompt, hajimetwi3/hajimetwi3-prompt-okiba (MIT) —
  the coastal quality checklist (§10).
- Evan Wallace, *WebGL Water* — caustics by rasterised photon splatting.
- **ClearWater6.1 / RTXShowcase** by SamG-Coder (MIT),
  github.com/SamG-Coder/RTXShowcase — footprint-adaptive glints, the wave-patch
  domain warp with its Jacobian, sand relief, RGB dispersion in caustics (§7.6, §7.9–7.11).
- GPU Gems 1 ch. 1 (Gerstner waves), GPU Gems 3 ch. 13 (light scattering).
- Lagarde & de Rousiers 2014, *Moving Frostbite to PBR* — physical light units,
  pre-exposure.
- Pope & Fry 1997 — pure-water absorption.
- The repository's `references/` sheets (PBR materials, lighting values).
- Hillaire 2020, *A Scalable and Production Ready Sky and Atmosphere Rendering
  Technique* (EGSR) — the sky and aerial-perspective LUTs (§12.4); Bruneton 2017
  for the coefficients.
- Hillaire 2016, *Physically Based Sky, Atmosphere and Cloud Rendering in
  Frostbite* (SIGGRAPH course) — energy-conserving cloud integration;
  Wrenninge et al. 2013, *Oz: The Great and Volumetric* — multiple-scattering
  octaves.
- Strugar 2009, *Continuous Distance-Dependent Level of Detail for Rendering
  Heightmaps* — CDLOD terrain (§12.1).
- Max 1988, *Horizon Mapping: Shadows for Bump-Mapped Surfaces* — the horizon
  angle idea behind the mountain-shadow and sky-visibility bake (§12.2).
- Leishman, *Principles of Helicopter Aerodynamics* — blade-element thrust with
  momentum inflow; Cheeseman & Bennett 1955 — ground effect (the rotorcraft
  model behind §14).
