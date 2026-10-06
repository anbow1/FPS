# Prompt 2 — Jet fighter simulator (5th gen vs 4.5 gen dogfight)

Paste everything below into the coding agent. It assumes `AGENT.md` and
`rules/games-ts-threejs.md` are already in context (in this kit: also
`rules/graphics-quality.md`; see `START.md`).

---

## Kit notes (read first)

- No `target-look/` exists for this game: the quality bar is
  `rules/graphics-quality.md` plus the reference sheets.
- Where this brief names a stack item that `rules/games-ts-threejs.md` replaces,
  the rules win: shaders in TSL on `WebGPURenderer` only; glTF/KTX2 are optional
  (procedural models and textures are fine); the flight model is hand-written
  from forces and moments, and ground contact (gear, runway) needs no physics
  library — if you add Rapier, it is the only one.
- Add the measurement tools, the Low preset for a phone, touch controls
  (virtual stick for pitch/roll, throttle slider, buttons) and the APK to your
  milestones; they are required by the rules even though this brief does not
  list them.
- Radar, RWR, seekers and countermeasures stay game abstractions with invented
  curves (rules §13).

## The brief

Build a **jet fighter simulator** in TypeScript + Three.js. The player flies a
stealth-style single-seat fighter (F-35 class) against a large twin-engine
super-manoeuvrable fighter (Su-35 class). Both are flyable. The focus is a
convincing flight model, a real HUD, radar, missiles, and a sky that looks like
a photograph.

Follow `rules/games-ts-threejs.md`. Use `scale-reference.png` for airframe size,
`lighting-reference.png` for the sky and `hud-layout-reference.png` for the HUD.

## Stack

- TypeScript strict, Vite, Three.js `WebGPURenderer` (falls back to WebGL2 by
  itself — one code path).
- Rapier for physics, fixed 60 Hz step.
- Howler or Web Audio for positional sound.
- No game engine wrapper, no React in the game loop. DOM only for HUD and menus.

Flight dynamics are custom — do not use a rigid-body vehicle
helper. Rapier handles collisions and ground only.

## Flight model

Build a proper six-degrees-of-freedom model. Forces, not tweens.

- **Lift** from a lift-coefficient curve against angle of attack, with a stall
  break and post-stall behaviour. Include a Mach-dependent drag rise.
- **Drag** split into parasitic and induced. Induced rises with load factor.
- **Thrust** from a thrust curve against altitude and Mach, with an afterburner
  stage and a spool-up time. Fuel burns; the aircraft gets lighter and livelier.
- **Air density** falls with altitude using a standard atmosphere model. Above
  ~12 km everything gets sluggish and the turn rate collapses. This must be felt.
- Moments of inertia per axis, differing between the two aircraft.
- Control surfaces produce moments scaled by dynamic pressure, so controls go
  soft at low speed and stiff at high speed.
- **Fly-by-wire on the player aircraft**: an authority limiter that respects a G
  limit and an AoA limit, with a switch to relax it. The second aircraft has a
  looser limiter and a thrust-vectoring bonus at low speed — that is its whole
  character.
- G-effects: grey-out and tunnel vision above sustained 7 G, red-out under
  negative G, with a G-tolerance pool that depletes and recovers.

Produce an energy-manoeuvrability chart in the debug build: turn rate against
speed at several altitudes. Tune against it. Print it in the reply.

## Cameras

- **Cockpit (interior)** — a fully modelled cockpit: seat, canopy frame, stick,
  throttle, side consoles, and a large multi-function display that actually
  renders the radar picture into a texture. Head moves with G. Canopy glass uses
  the transmission values on the PBR sheet, with reflections and rain streaks.
- **Chase (exterior)** — spring arm behind the jet, with adjustable distance.
- **Free orbit** — mouse-controlled orbit for looking at the model.
- **Padlock** — locks the view on the tracked target, cockpit frame obscuring
  the view where it physically would.
- **Missile cam** — follows a launched missile until it hits or times out.

## HUD

Follow the jet panel in `hud-layout-reference.png`. Green stroke, vector drawn,
no bloom, projected so it reads as collimated at infinity.

- Left: speed ladder in knots, with Mach below.
- Right: altitude ladder, radar altitude below 500 m, vertical speed bar.
- Top: heading tape.
- Centre: pitch ladder with correct climb-dive lines, waterline symbol, and the
  **flight-path marker** on the true velocity vector — the key realism cue.
- G meter, AoA bracket, fuel and remaining stores in the corners.
- Weapon mode box: gun, short-range missile, medium-range missile.
- When locked: target box, range in nautical miles, closure rate, and the
  in-range cue. For guns: a lead-computing pipper with a bullet-time trail.

## Radar and threat warning

- Scan volume in azimuth and elevation, with a sweep that takes real time.
  Contacts appear only when the sweep passes them.
- Range and elevation scales the player can change.
- Modes: search, track-while-scan, single-target track. Lock takes time and can
  be broken by a hard turn out of the scan volume or by terrain masking.
- Notching: a target flying perpendicular at low altitude drops out of the
  doppler filter. Make this work — it is the best emergent tactic in the game.
- **Radar warning receiver**: a ring display showing the bearing of anything
  painting you, with a different tone for search, track and launch.
- Stealth asymmetry: the player's aircraft is detected at much shorter range
  from the front, but the same as anyone from the side. This should change how
  both aircraft fly, and the AI should exploit it.

Keep all of this at the level of a game abstraction. Do not research or write
real radar, jamming or seeker engineering detail — invented curves that feel
right are what this project wants.

## Weapons

- **Gun** — a rotary cannon with a limited burst count, a real time of flight,
  and tracers that curve. The pipper is the aiming solution.
- **Short-range missile** — off-boresight seeker with a cone, high manoeuvre,
  short burn, and a strong sensitivity to flares and to the sun.
- **Medium-range missile** — needs the radar lock through most of its flight,
  goes active near the end, loses energy badly at long range. Launching at max
  range must usually fail — that is the lesson.
- Countermeasures: flares and chaff on separate keys, each defeating one
  guidance type, with a finite count and a reload-free cooldown.
- Missile flight is its own simplified physics body with guidance, drag and a
  fuel burn. Show it on the missile cam. No instant hits.

## Environment

The sky is the star of this game.

- Physical sky: a LUT-based atmosphere (Hillaire, EGSR 2020 method) valid from
  the runway to 15 km, with a sun position driven by time of day, correct
  horizon gradient and a bright sun disc with limb darkening. The three.js
  `Sky` (Preetham) model is not enough — it is only valid from the ground.
- Aerial perspective on terrain, clouds and aircraft from the same atmosphere,
  so distance and altitude read correctly.
- **Volumetric clouds** — layered, lit from the sun side, with real parallax as
  you fly past them. Flying into one must reduce visibility and hide you from
  the AI's visual check. At minimum, use a raymarched cloud layer; at maximum, a
  full volumetric pass with a Low-preset fallback to billboards.
- Contrails above a given altitude, wingtip vapour under high G, engine heat
  shimmer, and afterburner flame with correct colour temperature.
- Terrain below: a 100 × 100 km heightfield with satellite-style colour, low
  detail but correctly scaled, so altitude reads properly. Around it, a
  low-detail terrain ring out to the horizon (about 390 km at 12 km altitude),
  faded by aerial perspective, so the map edge is never visible. Terrain colour
  is 1–5 m per pixel plus procedural detail. A runway and an airbase at the
  centre for take-off and landing, with runway concrete, paint and tyre-mark
  decals from the PBR sheet.
- Three presets: clear morning, broken cloud at noon, dusk above an overcast.

## AI opponent

- Flies the same flight model. No cheating on thrust or turn rate.
- Behaviour tree: intercept → beyond-visual-range engagement → merge → dogfight
  → energy fight → separate and re-engage → bug out when low on fuel or stores.
- Manages energy: trades altitude for speed, climbs away when it has an
  advantage, refuses a losing turn fight.
- Uses the notch and terrain masking against the player's radar.
- Three difficulty levels changing reaction time and mistake rate, never its
  aircraft performance.

## Game modes

1. **Free flight** — one aircraft, one sky, no enemy. Build this first.
2. **Duel** — 1 v 1, choose your aircraft and the opponent's.
3. **Intercept** — two enemy fighters, limited fuel, return to base to win.
4. **Carrier-free landing challenge** — approach and land on the runway, scored
   on rate of descent, centreline and touchdown point.

## Build order

1. Skeleton, renderer, one jet mesh, and the flight model in a grey sky with a
   debug overlay of every force. Nothing else until the model feels right.
2. Cameras, then the HUD, then the flight-path marker (verify it sits on the
   real velocity vector while side-slipping).
3. Terrain, runway, take-off and landing.
4. Sky and cloud pass.
5. Radar and RWR, with a dumb target aircraft.
6. Gun, then missiles, then countermeasures.
7. AI opponent, tuned in the duel mode.
8. Cockpit interior art pass and multi-function display render target.
9. Sound, post-processing, performance pass.

Report frame time and the energy-manoeuvrability numbers at each step.

## Acceptance

- The two aircraft feel clearly different, and neither wins by default.
- A max-range medium missile shot at a manoeuvring target usually misses.
- The flight-path marker is correct in a slipping turn.
- Clouds hide you from the AI's visual detection.
- 60 fps at 1440p with volumetric clouds on the High preset (clouds fit the
  2.0 ms game slot on the budget sheet).
- No visible terrain edge from 12 km altitude in any direction.
- Afterburner and sunset colours checked with both ACES and AgX; the choice is
  written down.
