# Prompt 1 — Modern military FPS (city + forest)

Paste everything below into the coding agent. It assumes `AGENT.md` and
`rules/games-ts-threejs.md` are already in context.

---

## The brief

Build a single-player first-person shooter in **TypeScript + Three.js**, aimed
at maximum visual and mechanical realism. Two maps: a dense **city block** and a
**pine forest ridge**. The player is one soldier with a primary rifle and a
sniper rifle, carrying med kits, ammo packs and grenades, fighting AI infantry.

Follow `rules/games-ts-threejs.md` exactly. Use the reference sheets in
`references/` for materials, lighting, scale, ballistics, HUD and budget.

## Stack

- TypeScript strict, Vite, Three.js `WebGPURenderer` (falls back to WebGL2 by
  itself — one code path).
- Rapier for physics, fixed 60 Hz step.
- Howler or Web Audio for positional sound.
- No game engine wrapper, no React in the game loop. DOM only for HUD and menus.

## Player

- Capsule collider, 1.83 m tall, 0.35 m radius, 80 kg. See the scale sheet.
- States: stand / crouch (1.25 m) / prone (0.55 m), walk 1.4 m/s, jog 3.5 m/s,
  sprint 6.0 m/s, and a stamina pool that drains on sprint and recovers seated.
- Movement is force-based with ground friction, not direct position setting.
  Acceleration ramps: no instant top speed, no instant stop.
- Momentum carries into a slide when you crouch at sprint speed.
- Stance affects: weapon sway, recoil recovery, movement noise, and hitbox.
- Fall damage above 4 m. Above 8 m is a broken-leg limp for 20 s.
- Breathing affects sight picture. Hold breath key steadies the scope for 6 s,
  then the sway doubles for 3 s.

## Weapons

Two primaries, switched on `1` and `2`, plus a sidearm on `3`.

**Assault rifle with collimator (red dot) sight**

- 5.56 mm class. Muzzle velocity and drop per `ballistics-reference.png`.
- Fire modes: semi and auto, toggled on `B`. 30-round magazine, ~750 rpm.
- Reload has two timings: tactical (round in chamber, faster) and empty
  (bolt release, slower). Both fully animated with a real magazine swap.
- The red dot is a **real optic**: a physically modelled tube, the dot rendered
  at infinity so it parallax-shifts correctly with head position. Do not draw it
  as a screen-space crosshair.
- Recoil: a per-shot impulse with vertical and a seeded horizontal component,
  plus visual kick separate from aim kick, plus a recovery curve back toward
  the original point of aim.
- Hip fire uses a cone that grows with movement and fire rate. ADS is precise.

**Bolt-action sniper rifle**

- Magnum class, 5-round internal magazine, bolt cycle between shots.
- Variable scope, 4× and 10×, rendered through a **separate render target** so
  the magnified image is a true second view, with a black scope shadow ring and
  a visible eye-relief penalty if you move. The scope view renders at ≤ ½
  resolution, picks LOD by magnification, and must fit the 2.0 ms game slot on
  the budget sheet.
- Mil-dot reticle. Holdover in mil must match the ballistics sheet at 300, 500
  and 800 m (it lists the values).
- A range-finder key gives the distance to what is under the reticle.
- Suppressed variant reduces muzzle flash and the audible detection radius.
- Bullet drop, time of flight and a simple wind vector per map all apply.

**Grenades (`G`)**

- Frag: 4.5 s fuse, throw arc previewed as a faint trajectory while cooking,
  damage falls off with distance and is blocked by line of sight.
- Smoke: a growing volumetric-ish particle cloud that actually blocks AI vision
  raycasts, not just the camera.
- Flashbang: whitens the screen and muffles audio, and blinds AI in the cone.
- Three slots, cycled with `G` held.

## Items

- **Med kit** — 6 s animated use, restores 50 health, cannot be used while
  taking fire (interrupt on hit). Two carried.
- **Ammo pack** — refills magazines for both primaries, 4 s use, one carried.
- Both are dropped by dead AI and found at fixed points on the map.
- Health has two layers: a small regenerating buffer and a permanent pool that
  only med kits restore. Bleeding applies at low health until treated.

## Damage model

- Per-body-part hitboxes: head, chest, abdomen, arms, legs — each with its own
  multiplier and effect (leg hit = limp, arm hit = sway).
- Armour plate on the chest absorbs a set number of hits, then breaks visibly.
- Materials matter: a rifle round goes through wood and sheet metal with energy
  loss, and stops in concrete. Implement penetration as a per-material energy
  cost on the ray.
- Feedback: directional hit indicator, blood-free screen effect (a dirt and
  focus-loss vignette), distinct sounds for armour hit, flesh hit and near miss
  (supersonic crack).

## AI

- Squads of 4 with roles: point, rifleman, support, leader.
- Perception: a vision cone with distance falloff and occlusion raycasts, plus
  hearing with a radius that depends on your stance, speed and whether you are
  suppressed.
- Behaviour: patrol → alert (search last known position) → engage (use cover,
  suppress, flank) → regroup. Leader calls the flank; if the leader dies, the
  squad falls back to cover.
- They use cover geometry properly: lean out, fire, return. They throw grenades
  at a player who stays in one spot for more than 8 s.
- They must miss believably: a first-burst inaccuracy that tightens over time.

## Maps

**City block** — 400 × 400 m. Four enterable buildings with real interiors,
stairwells and rooftops. Asphalt, kerbs, brick, glass, wrecked cars. Sightlines
of 30–150 m. Wet-asphalt variant using the clearcoat values on the PBR sheet,
with SSR so puddles reflect the buildings, not just the sky. Interiors get baked
lighting or irradiance probes and box-projected reflection probes — never lit
by the outdoor environment map alone.

**Forest ridge** — 800 × 800 m. Instanced pines with alpha-clip foliage,
undergrowth, a dirt track, rock outcrops, a ruined farm building. Foliage uses
thin translucency and coverage-preserving alpha mips; rocks use triplanar
mapping; the ground has a detail layer that stays sharp at prone eye height
(0.45 m). Sightlines of
100–700 m, built so the sniper rifle earns its place. Wind moves the foliage and
that same wind vector drives bullet drift.

Both maps get three lighting presets from `lighting-reference.png`: clear noon,
overcast, and golden hour. Fog is height-based and physically tied to the preset,
and aerial perspective applies to every object, so 700 m looks 700 m away.

## HUD

Follow the FPS panel in `hud-layout-reference.png`.

- Bottom left: weapon name, rounds in magazine / magazines left, fire mode.
- Bottom right: health bar, armour state, med-kit count.
- Bottom centre: grenade type and count.
- Top left: current objective, one line.
- Top right: a compass strip with the objective bearing.
- Centre: nothing but the reticle, and nothing at all while ADS.
- A minimal mode (health + ammo only) toggled in settings.

## Game modes

1. **Skirmish** — clear all enemy squads on the map.
2. **Extraction** — reach a marked point, hold it 60 s, leave. Reinforcements
   arrive in waves.
3. **Range** — a shooting range with targets at 100–800 m for zeroing and feel
   testing. Build this first; you will use it constantly.

## Build order

1. Project skeleton, fixed-step loop, renderer with the correct colour and tone
   mapping, pre-exposure and auto exposure, a grey-box room built to the city
   dimensions on the scale sheet, a capsule that moves. Prove 60 fps.
2. Full movement with stances, stamina and camera.
3. The range map, then the assault rifle end to end: model, animation, recoil,
   ballistics, impact decals, sound.
4. Damage model and hitboxes, with a static target dummy.
5. AI perception and one engaging enemy.
6. Sniper rifle and the scope render target.
7. Grenades and items.
8. City map, then forest map, art-passed against the references.
9. Squad AI, modes, audio pass, post-processing pass.
10. Performance pass to the budget sheet, then settings and menus.

Stop after each step, tell me what is done, how to run it, and the frame time.

## Acceptance

- Locked 60 fps in both maps with the budget respected.
- Zeroing at 300 m and a hit at 600 m with the correct holdover from the sheet.
- An enemy squad flanks a stationary player within 15 seconds.
- Smoke actually blocks AI sight.
- Everything readable at a glance: no HUD text inside the centre zone.
- Walking from a noon street into a building interior adapts exposure in about
  2 s, with no black or blown-out frames.
- The first-person rifle falls into shadow when you step under a roof.
