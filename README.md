# Field Line — single-player military FPS

TypeScript + three.js (`WebGPURenderer`, WebGL2 fallback). Three maps — a
shooting range, a 400 × 400 m city block and an 800 × 800 m forest ridge — and
three modes: Range, Skirmish and Extraction. The brief is `01-modern-fps.md`;
the rules are `AGENT.md` and `games-ts-threejs.md`; the reference sheets are
in `references/`.

## Run it

```powershell
npm install
npm run dev        # http://localhost:5173 — pick map, mode and light, then Deploy
npm test           # logic, maps, ballistics, exposure and acceptance tests (headless)
npm run bench      # CPU cost of one 60 Hz logic step on the city and forest maps
npm run build      # type-check and production bundle in dist/
```

Chromium with WebGPU is the target. Without WebGPU the renderer falls back to
WebGL2 by itself.

## Controls (rebindable in the menu)

| | |
|---|---|
| Move / sprint / jump | WASD · Shift · Space |
| Crouch (slide at sprint) / prone | C or Ctrl · Z |
| Fire / aim | Mouse 1 · Mouse 2 |
| Hold breath (while aimed) | Shift |
| Reload / fire mode | R · B |
| Carbine / sniper / pistol | 1 · 2 · 3 |
| Scope zoom 4× ⇄ 10× | V or wheel up |
| Range finder | T |
| Suppressor on / off | N |
| Grenade: hold to cook, release to throw / next type | G · 4 or wheel down |
| Med kit / ammo pack | H · J |
| Pause | Esc |

## Layout

```
src/config.ts        every tunable, SI units, with its source
src/core/            fixed-step loop, rebindable input, vectors, seeded RNG, noise
src/game/            logic only — no THREE: player, weapons, G7 ballistics, bullets,
                     grenades, items, collision, nav grid, cover, soldier AI, squads, modes
src/maps/            deterministic generators: range, city (enterable buildings), forest
src/render/          stage and post chain, lighting and exposure, materials, world,
                     props, foliage, actors, viewmodel and optics, effects
src/audio/           Web Audio: layered shots, speed of sound, ducking
src/ui/, src/app/    DOM HUD, menus, settings, controls
tests/               vitest, headless
```

Fixed update order: `src/game/game.ts` (`Game.step`). The render system reads
game state once per display frame and interpolates between steps.

## Where it stands

See the latest commit messages for what each step added and what was measured.
The open items are listed at the end of the last report: GTAO, SSR, motion
blur, a colour-grade LUT, volumetric light and contact shadows are not in the
post chain yet; characters and weapons are procedural stand-ins, not scanned
or authored assets; textures are generated at load, not KTX2.

---

# Castaway Lagoon — tropical first-person exploration

A second game in the same repo: a small, dense tropical bay with a survival
outpost beside the beach, inspired by the Far Cry 3 island look. Open
`http://localhost:5173/lagoon.html` after `npm run dev`.

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

`lagoon.html?autostart&time=sunset&weather=storm` starts without the title and
without pointer lock (for screenshots); `q=low` picks the Low preset.

## Layout

```
src/lagoon/config.ts   every tunable (player, stone, rifle, knife, weather, daylight, waves), SI units
src/lagoon/game/       logic only, no THREE: terrain height function, world layout, collision,
                       player, bodies (stones, shells, cans), bullets, equipment, inventory,
                       time of day and weather, and the fixed step order in game.ts
src/lagoon/render/     stage and post chain, sky, lighting and exposure, ground, water,
                       palms, jungle, undergrowth, rocks, outpost, props, arms, viewmodel,
                       particles, effects, rain, ambient life
src/lagoon/audio/      synthesised positional audio (no samples)
src/lagoon/ui/         HUD, menus, inventory, icons
tests/lagoon.test.ts   headless logic tests
```

Everything is procedural: textures are generated at load, models are built
from primitives, and every sound is synthesised with Web Audio.
