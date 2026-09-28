# Field Line — single-player military FPS

TypeScript + three.js (`WebGPURenderer`, WebGL2 fallback). Three maps — a
shooting range, a 400 × 400 m city block and an 800 × 800 m forest ridge — and
three modes: Range, Skirmish and Extraction. The brief is `BRIEF.md`; the
rules are `../AGENT.md` and `../games-ts-threejs.md`; the reference sheets are
in `../references/`.

## Run it

```powershell
cd field-line
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
Ported from Castaway Lagoon: shadow-aware thin translucency on pine needles
and leaves, screen-space sun shafts through the canopy, ground-bounce light
in the sky probe (lifts shaded walls, trunks and soldiers), and a light
saturation and vignette grade. Also from the lagoon's jungle floor: grass
tufts and bracken scattered over the terrain (render only, sinking out of view
near their draw distance), broadleaf shrubs for the concealing bushes, crown
occlusion and needle litter baked into the ground under the pines, and mossy
triplanar boulders. Pines have two levels of detail per 100 m chunk (full
crowns near, light crowns beyond), each tree its own tint.

The open items are listed at the end of the last report: GTAO, SSR, motion
blur, a colour-grade LUT, volumetric light and contact shadows are not in the
post chain yet; characters and weapons are procedural stand-ins, not scanned
or authored assets; textures are generated at load, not KTX2.
