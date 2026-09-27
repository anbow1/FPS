# Castaway Lagoon — tropical first-person exploration

A small, dense tropical bay with a survival outpost beside the beach,
inspired by the Far Cry 3 island look. TypeScript + three.js
(`WebGPURenderer`, WebGL2 fallback). The rules are `../AGENT.md` and
`../games-ts-threejs.md`; the reference sheets are in `../references/`.

## Run it

```powershell
cd castaway-lagoon
npm install
npm run dev        # http://localhost:5173 — click to begin
npm test           # headless logic tests
npm run build      # type-check and production bundle in dist/
```

Things to do there: pick up stones on the beach and throw them into the
lagoon (hold the mouse to wind up; flat, fast throws skip), take the AK-47
from the cot and the knife from the table, open the supply crate, harvest
herbs, hibiscus and aloe, read the journal and the map, knock the tin cans
off the driftwood log, and change the weather (T) and time of day (N).

| | |
|---|---|
| Move / sprint / jump | WASD · Shift · Space |
| Interact / pick up / harvest / examine | E |
| Shoot · slash · throw (hold to wind up) | Mouse 1 |
| Aim the rifle | Mouse 2 |
| Reload | R |
| AK-47 / knife / stone / empty hands | 1 · 2 · 3 · H |
| Inventory | I |
| Weather · time of day | T · N |
| Pause and settings (time, weather, graphics, mouse, volume) | Esc |
| Stats overlay | F3 |

`index.html?autostart&time=sunset&weather=storm` starts without the title and
without pointer lock (for screenshots); `q=low` picks the Low preset.

## Layout

```
src/config.ts          every tunable (physics, player, stone, rifle, knife, weather, daylight, waves), SI units
src/core/              fixed-step loop, rebindable input, noise, seeded RNG, vector helpers
src/game/              logic only, no THREE: terrain height function, world layout, collision,
                       player, bodies (stones, shells, cans), bullets, equipment, inventory,
                       time of day and weather, and the fixed step order in game.ts
src/render/            stage and post chain, exposure, texture sets, sky, lighting and exposure, ground, water,
                       palms, jungle, undergrowth, rocks, outpost, props, arms, viewmodel,
                       particles, effects, rain, ambient life
src/audio/             synthesised positional audio (no samples)
src/ui/                HUD, menus, inventory, icons
tests/lagoon.test.ts   headless logic tests
```

Everything is procedural: textures are generated at load, models are built
from primitives, and every sound is synthesised with Web Audio.

## How the lagoon is rendered

- **Light in physical units.** Sun and sky illuminance come from the sun's
  elevation (Kasten–Young air mass) and the cloud deck; every light, the sky
  and every emissive is pre-exposed by the frame's EV100 anchor, and a
  histogram auto-exposure adapts around it (night is held ~2 stops under a
  grey card, and the eye can stop down for the camp fire).
- **One analytic sky** (gradient, Mie glow, sunset band, sun and moon discs,
  stars, wind-driven clouds) is used by the dome, the environment probe (with
  ground bounce below the horizon), the height fog and the water reflection,
  so horizon, haze and reflections agree at every time of day.
- **Water:** Gerstner waves damped by depth, Beer–Lambert absorption over the
  refracted lagoon floor (turquoise over sand, navy in the channel), Fresnel
  sky reflection with sun and moon glitter, crest subsurface glow, shoreline
  and storm foam, ring ripples from splashes and raindrops, caustics on the
  floor.
- **Ground:** height-blended sand / turf / leaf litter / rock splat, a wet
  band that follows the lapping waves, rain wetness, puddles, trodden paths,
  jungle canopy colour on the far hills.
- **Foliage:** instanced palms, rainforest trees, ferns, shrubs, banana
  plants, grass and vines; one wind field bends trunks and flutters leaves;
  leaves use shadow-aware thin translucency (`MeshSSSNodeMaterial`).
- **Post:** TRAA, screen-space sun shafts through the canopy, bloom, grade and
  vignette, ACES (AgX switchable in the pause menu).
- **Weather:** clear, cloudy, rain and heavy rain blend over ~7 s; rain
  streaks (dry under the tarp), splashes, wet materials, puddles, denser fog,
  lightning with delayed thunder. Time of day sweeps the clock over ~5 s.

## Where it stands

Checked by rendering in headless Chromium (SwiftShader, so the WebGL2
fallback) at every time of day and weather, and by scripted play-throughs:
pick up and throw a stone into the lagoon, open the crate, harvest a plant,
take the rifle, fire, reload, aim, slash with the knife. `npm test` covers
the logic (terrain, inventory, stones and skipping, rifle, crate, harvest,
examine, wading limit, daylight and weather).

Known gaps:

- Not profiled on a real GPU. The High preset is heavy (≈1100 rainforest
  trees with translucent leaves, 16 k grass tufts, 3 shadow cascades); Low
  thins vegetation and drops TRAA. Budget numbers against
  `performance-budget-reference.png` are still to be measured.
- No GTAO or SSR: the water reflects the analytic sky (with clouds, sun and
  moon) but not the islands; ambient occlusion is baked (canopy shade on the
  ground, texture cavities).
- Models are built from primitives in code (no glTF/KTX2 pipeline); textures
  are generated at load.
- The brief asked for an "AK-47" by name, so the UI uses that name; the model
  is a generic AK-pattern shape with no markings (rules §11 otherwise prefer
  invented names).
