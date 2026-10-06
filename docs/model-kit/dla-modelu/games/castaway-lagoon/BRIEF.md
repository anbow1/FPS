# Castaway Lagoon — brief

This is the task. Build the game described below. The images it refers to are in
`target-look/` (next to this file) and the binding reference sheets in
`../../reference-sheets/`.

## 1. What to build

A first-person game in **TypeScript + three.js** set on a sheltered tropical
lagoon: a white-sand beach, turquoise shallows over sand, a reef channel out
to the open sea, rainforest on steep karst slopes, a volcano behind, small
islets, and a castaway's **survival outpost** — a lean-to shelter on a plank
deck, a camp fire, a wooden dock running out into the lagoon.

The player wakes on the beach and can explore, pick things up, use tools and
vehicles, and change the time of day and the weather. There is no enemy and
no score; the quality of the place and of each interaction *is* the game.

Everything is generated in code: terrain, plants, props, textures, sounds. No
downloaded models, textures or audio files.

The images in `target-look/` show the quality bar. Match their mood, light,
water colour and density, not their exact layout. The sheets in
`../../reference-sheets/` are binding numbers (lighting, PBR materials, scale, HUD
layout, performance budget).

## 2. Platform and hard rules

1. TypeScript strict, Vite, no `any`; SI units in names; comments say *why*.
2. three.js **`WebGPURenderer`** with its WebGL2 fallback; all shaders in
   **TSL**; no `ShaderMaterial`, `onBeforeCompile`, `EffectComposer`.
3. One post chain: HDR scene pass (velocity MRT) → TRAA (High) → sun shafts
   through the canopy → bloom → grade → exposure + ACES + sRGB once.
4. Physical light: sun/sky/moon in lux from `lighting-reference.png`, lamps and
   fire in candela, EV100 exposure with auto exposure, pre-exposure on every
   light. Night stays about two stops under a grey card, never black.
5. Headless deterministic logic at a fixed 60 Hz, render interpolates; logic
   never imports three.js.
6. Fixed light count from the first frame (the lantern, the fire, a muzzle
   flash, vehicle lamps exist from load with zero intensity); every shader
   compiled behind the loading screen.
7. Any surface height the logic needs (a swimmer's head, a floating hull) is
   computed on the CPU from **the same waves** the water shader displaces with.
8. Low and High presets, a frame governor, and a benchmark at fixed named
   views; Android APK starting on Low with touch controls.

## 3. Required features and acceptance criteria

### The place (graphics — compare with `target-look/`)
- **G-01** One analytic sky drives the dome, the fog and the environment probe;
  four times of day (early morning, noon, golden hour, night with moon and
  stars) and four weathers (clear, cloudy, rain, storm with lightning and
  delayed thunder) that blend over a few seconds without a shader recompile.
- **G-02** Water optics written out term by term: refraction of the floor
  through the surface, **Beer–Lambert absorption per channel** (red dies first:
  turquoise over sand, navy in the deep), in-scattering, Schlick Fresnel
  (F0 ≈ 0.02), the sky's reflection with a sun glitter lobe.
- **G-03** **Shore waves** that slow, shorten and bend toward the beach with
  depth (refraction and shoaling from a field solved over the real seabed at
  load), steepen and break with whitewater.
- **G-04** **Swash**: the thin sheet running up the sand and back, a wet band
  that dries with a delay, lacy foam (a lace pattern, not raw noise) at the
  waterline.
- **G-05** **Caustics** on the shallow floor that move with the surface ripples
  above them.
- **G-06** Open water beyond the shallows: wind-sea detail from an FFT
  spectrum, faded out over the shallows where caustics must match the
  ripples.
- **G-07** **Interactive ripples**: splashes, stones, bullets, wading legs and
  the boat's wake push a small height-field simulation around the camera; rings
  spread, meet and stop at the shore. Calm water costs nothing.
- **G-08** Vegetation: coconut palms, broadleaf rainforest trees, ferns,
  banana and other undergrowth from a leaf atlas; alpha-clip with
  coverage-preserving mips; translucency on High; wind sway with gusts;
  **one draw call per species**; streamed instances around the camera.
- **G-09** **Real grass blades** where sand turns to soil and beach grass in
  clumps on the upper beach, standing exactly on the terrain, bent by the feet.
- **G-10** Rocks with worn edges, moss on top, a wet band and barnacles in the
  surf.
- **G-11** **Underwater view**: below the surface the scene fades by distance
  through the water (Beer–Lambert on depth) to the water's own colour; the
  surface seen from below shows **Snell's window** and total internal
  reflection outside it; sound is muffled.
- **G-12** Rain streaks, wet darkening of sand and wood (except under the tarp),
  rain rings on the water, lightning that lights the scene.

### Interaction (gameplay)
- **P-01** Walk 3.2 m/s, sprint 6.0 m/s, acceleration-based, step onto the deck
  and dock, jumping, head bob; wading slows you with depth.
- **P-02** **Swimming** deeper than 1.5 m: eye just above the chop (the same
  waves the water is drawn with), surface strokes, **dive** while a key is
  held, swim where you look once under, a **45 s breath** with an air bar;
  out of air you are pushed up. Tools go on your back while swimming.
- **P-03** A soft world border: past ~165 m from the lagoon's centre a current
  carries swimmers and boats back.
- **P-04** **Stones**: pick up on the beach, hold to wind up, throw overarm;
  drag, bounce, roll; flat fast throws **skip** on water (below ~20° entry);
  splashes ring the water; a stone that settles becomes a pick-up again.
- **P-05** **AK-47** found in the shelter: 30 rounds, ~600 rpm, aim down
  sights, recoil, reload with magazine stages, ejected shells; impacts by
  surface (sand puffs, wood splinters, rock chips and sparks, water spouts).
- **P-06** **Knife**: slash, harvest plants cleanly, knock tin cans.
- **P-07** Harvest herbs, hibiscus, aloe; pick coconuts; an **inventory** screen
  with item icons and descriptions.
- **P-08** **Supply crate** that opens with an animated lid and holds ammo,
  beans, a flare.
- **P-09** Examine notes: the journal, the hand-drawn map, the radio, a photo.
- **P-10** **Tin cans** on a driftwood log that fly when hit and reset later.
- **P-11** **Backpack**: taking it gives what is inside (a lighter, fishhooks).
- **P-12** **Kerosene lamp**: take it off its hook; it hangs from the left hand
  and **swings** on a pendulum with your movement, the existing lantern light
  moves with it; L lights it or puts it out; water puts it out.
- **P-13** **Sleep on the cot**: a fade to black, the clock jumps to morning
  (from evening or night) or to the golden hour (from day), a fade back.
- **P-14** **Camp fire with fuel**: it burns down in minutes (faster in rain);
  flames, light, smoke and crackle scale with the fuel left; logs from the
  woodpile are **thrown** on (a log landing in the pit feeds it; elsewhere it
  lies as a pick-up; wood floats) or put on by hand; a dead fire needs the
  lighter.
- **P-15** **Boat**: a dinghy moored at the dock; board and leave with E; an
  outboard (throttle, tiller); the hull **floats on the waves** with real
  buoyancy (heave, pitch, roll from several points), leaves a wake, runs
  aground on sand, fends off dock piles; leaving puts you on the dock or in the
  water. No water inside the hull.
- **P-16** **Jeep**: parked by the shelter; get in at the driver's door; drive
  on the beach with power-limited traction, sand drag, a grip limit in turns;
  the body pitches and rolls over the dunes; will not drive into water deeper
  than its intake; the bonnet and passenger door open with E; headlights on L;
  engine sound.

### UI and audio
- **U-01** DOM HUD: crosshair (gone when aiming), context prompt ("E Pick up
  Stone", "E Board the boat"), item toasts, ammo or stone count only while
  that tool is in hand, air bar, a strip that shows time and weather on change.
- **U-02** Menus: title, pause with time-of-day and weather choices, graphics
  quality, tone map ACES/AgX, adaptive resolution, sensitivity, volume, a
  Benchmark button with a copyable table, the controls list.
- **U-03** Audio synthesised in Web Audio: surf that breathes with each stretch
  of shore, wind, leaves, rain on leaves vs on the tarp, birds by day, crickets
  and an owl at night, fire crackle, footsteps by surface (sand, wood, water),
  gunshot with the lagoon answering, stone splashes with bubble tones,
  outboard and jeep engines, muffling under water.

## 4. Reference images

Target look (`target-look/`, captured from the reference implementation at
960 × 540, software renderer; a real GPU will look sharper):

| File | What it shows | Match this |
|---|---|---|
| `01_beach_noon.png` | The spawn: palms, shallows, channel, volcano, dock | water colour graded by depth, swash foam, palm shadows on sand |
| `02_golden_hour.png` | Low sun through palms on the beach, a stone in hand | warm light, sun glare on water, long shadows |
| `03_storm_shelter.png` | Storm at the outpost: rain, wet deck, fire | rain streaks, wet darkening, dry under the tarp |
| `04_shelter_rifle.png` | From under the tarp with the AK, lagoon beyond | interior/exterior exposure, hanging lantern |
| `05_swash_lace.png` | Looking down at the waterline | lace foam, refraction of the sand, caustics |
| `06_ripples.png` | Splash rings from above | rings and froth on top of the wave detail |
| `07_underwater.png` | Diving: lit seabed fading to blue, surface above | depth fade, caustics on sand |
| `08_snell_window.png` | Looking up from under water | bright sky window, total internal reflection outside |
| `09_fire_night.png` | Camp fire at night | warm firelight falloff on sand, flames and embers |
| `10_boat.png` | Under way in the dinghy | hull, seats, no water in the boat, open water ahead |
| `11_jeep_day.png` | The jeep beside the shelter, bonnet up | scale, olive paint, grille, wheels on sand |
| `12_jeep_night.png` | Driving at night with headlights | headlight pool on the sand, dark sky |
| `contact-sheet.png` | All of the above with captions | — |

## 5. Budgets and presets

| | High (desktop) | Low (phone) |
|---|---|---|
| Draw calls at any benchmark view | ≤ 2500 | ≤ 1500 |
| Triangles | ≤ 12 M | ≤ 4 M |
| Frame rate | 60 fps desktop mid-range GPU | ≥ 30 fps mid-range phone |
| Shadow cascades | 3 | 2 |
| Hitches | none > 50 ms after the first second | |
| Load | ≤ 25 s desktop, ≤ 45 s phone | |

Benchmark views: spawn, spawn looking back, the shore, inside the jungle, the
outpost deck, an islet.

## 6. Build order (stop and report after each)

1. Renderer, exposure, the analytic sky and fog, terrain with the lagoon basin,
   a walking player. Frame time.
2. Water surface with optics (G-02), then the shore wave field, swash and wet
   sand (G-03, G-04), then caustics (G-05). Screenshot the beach at noon.
3. Vegetation and rocks (G-08, G-10), streaming and one draw per species.
4. Outpost, props, interaction: pick-ups, inventory, crate, examine (P-07…P-10).
5. Stones with skipping, knife, rifle (P-04…P-06), effects and audio.
6. Time of day and weather (G-01, G-12), night lighting.
7. Grass blades, ripples, open-sea FFT (G-06, G-07, G-09).
8. Swimming, underwater and the border (P-02, P-03, G-11).
9. Backpack, lamp, sleep, camp fire (P-11…P-14).
10. Boat, then jeep (P-15, P-16).
11. Performance pass (benchmark, governor), settings, Android build with touch.

Each report: what works, how to run it, frame time and draw calls at the
benchmark views, screenshots of what changed, what is not done.
