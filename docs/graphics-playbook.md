# Graphics playbook — real-time outdoor worlds in three.js (WebGPU + TSL)

Everything the two games in this repository do to look good and still run on a
phone, written so another project (or another coding agent) can repeat it step by
step. It is a record of what was built, measured and fixed here, including the
traps that cost the most time.

- **Field Line** (`field-line/`): military FPS — shooting range, city block, pine
  forest ridge.
- **Castaway Lagoon** (`castaway-lagoon/`): tropical bay with a jungle, a beach,
  a survival outpost, weather and time of day.

Both use **three.js r186**, `WebGPURenderer` (falls back to WebGL2 by itself),
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
   scene → **TRAA** (High only) → **screen-space sun shafts** → **bloom** →
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

### 5.6 Grass from real blades (`render/grassField.ts`, shared by all three games)

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

---
## 8. Phones: budget and stutter-proofing

Target here: a Pixel 9 Pro XL in an Android WebView (WebGL2 fallback is common).

### 8.1 Presets

| Setting | High | Low (default on touch devices) |
|---|---|---|
| Pixel ratio | device × render scale | capped at 1 on touch screens |
| TRAA | on | off |
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

---

## 12. Sources and credits

- **Tidewater** by Dan Greenheck (MIT), github.com/dgreenheck/tidewater — the
  eikonal shore-wave field, the per-wave height model and swash run-up, the lace
  foam idea, and photon-splat caustics. Ported and simplified for phones here;
  credited in the file headers.
- **"Real-Time Coastal Simulator"** prompt, hajimetwi3/hajimetwi3-prompt-okiba (MIT) —
  the coastal quality checklist (§10).
- Evan Wallace, *WebGL Water* — caustics by rasterised photon splatting.
- GPU Gems 1 ch. 1 (Gerstner waves), GPU Gems 3 ch. 13 (light scattering).
- Lagarde & de Rousiers 2014, *Moving Frostbite to PBR* — physical light units,
  pre-exposure.
- Pope & Fry 1997 — pure-water absorption.
- The repository's `references/` sheets (PBR materials, lighting values).
