# Prompt 4 — Attack helicopter simulator (AH-64 class)

Paste everything below into the coding agent. It assumes `AGENT.md` and
`rules/games-ts-threejs.md` are already in context (in this kit: also
`rules/graphics-quality.md`; see `START.md`).

---

## Kit notes (read first)

- No `target-look/` exists for this game: the quality bar is
  `rules/graphics-quality.md` plus the reference sheets.
- Where this brief names a stack item that `rules/games-ts-threejs.md` replaces,
  the rules win: shaders in TSL on `WebGPURenderer` only; glTF/KTX2 are optional
  (procedural models and textures are fine); the rotor model is hand-written
  from forces and moments — no generic vehicle helper.
- Add the measurement tools, the Low preset for a phone, touch controls
  (cyclic stick, collective slider, pedal buttons) and the APK to your
  milestones; they are required by the rules even though this brief does not
  list them.
- Sensor, designator, seeker and countermeasure behaviour stays a game
  abstraction (rules §13).

## The brief

Build an **attack helicopter simulator** in TypeScript + Three.js. The player
flies a two-seat western attack helicopter (AH-64 class) against ground forces
and an enemy attack helicopter (Mi-28 class). Interior and exterior cameras, a
real rotorcraft flight model, a sensor turret, and weapons that behave like
weapons instead of hitscans.

Follow `rules/games-ts-threejs.md`. Use `scale-reference.png` for airframe and
rotor size, and the helicopter panel of `hud-layout-reference.png`.

## Flight model — the hard part, do it properly

A helicopter is not a plane with vertical thrust. Build it from the rotor.

- **Main rotor**: thrust from collective pitch, scaled by air density and rotor
  RPM. Tilt of the rotor disc from cyclic input produces both a force vector and
  a moment. Model flapping at least approximately — the disc lags the input.
- **Torque and tail rotor**: main rotor torque yaws the airframe; the tail rotor
  cancels it. Pedals set tail-rotor pitch. Change the collective and the nose
  yaws until you correct it. This coupling is the whole feel of the machine.
- **Translational lift**: hovering is expensive, forward flight above roughly
  15 m/s is cheap. Accelerating out of a hover gives a distinct lift surge.
- **Ground effect**: extra lift below about one rotor diameter. Landing and
  low hovers feel different from high hovers.
- **Retreating blade stall** at high forward speed: a hard ceiling with a
  vibration warning before it.
- **Vortex ring state**: descend too fast with power in a low-speed descent and
  the aircraft falls through its own downwash. Recovery is forward cyclic, not
  more collective. Warn with airframe shake, then let it happen.
- **Autorotation**: engine failure keeps rotor RPM alive with a flare and a
  correct approach. Survivable if flown right.
- Weight and balance: fuel burn and expended stores change the trim.
- Stability augmentation on by default, with a switch to turn it off. With it
  off the aircraft should be genuinely hard to hold in a hover.

Debug overlay showing collective, cyclic, pedal, rotor RPM, torque, disc tilt,
airspeed, vertical speed and the current lift regime. Keep it in the shipped
build behind a key.

## Controls

- Collective on mouse wheel or `Shift`/`Ctrl`, cyclic on mouse, pedals on `Q`/`E`.
- Full support for a joystick and throttle if present, with axis calibration.
- Trim key that sets the current cyclic position as neutral — without it, mouse
  flying is exhausting.

## Cameras

- **Cockpit (pilot, rear seat)** — modelled cockpit with the instrument panel,
  two multi-function displays rendering real content to textures (sensor video,
  map, engine page), the canopy frame, and the monocle-style symbology overlay
  that stays aligned to where the pilot is looking. The sensor and MFD views
  render at reduced resolution and fit the 2.0 ms game slot on the budget sheet.
- **Cockpit (gunner, front seat)** — narrower, sensor-focused, with the turret
  slaved to the view.
- **Exterior chase** — spring arm, damped, terrain-collided.
- **Orbit / flyby** — for looking at the aircraft and for replays.
- **Weapon cam** — follows a launched missile.
- Head movement under load and vibration. Rotor shadow sweeps across the
  cockpit interior — a small detail that sells the whole thing.
- Rotor look: above ~50 % RPM the blades cross-fade to a blurred disc with a
  blade-shadow texture, driven by RPM. TAA and camera motion blur alone smear
  a fast rotor into ghosts.

## Sensor turret

- A steerable nose turret with daylight, thermal (white-hot and black-hot) and
  a zoom range, rendered through its own render target onto the display.
- It can be slaved to the aircraft's nose, to the pilot's look direction, or
  locked onto a ground point that it then tracks as you manoeuvre.
- A laser designator that holds a target for guided weapons, with a real time
  needed to settle and a line-of-sight requirement. Break the line of sight and
  the shot goes wide.
- Targets found by the sensor are stored and shown on the tactical map.

Keep sensor behaviour at game-abstraction level. Do not write real
targeting-system, seeker or countermeasure engineering detail into this repo.

## Weapons

- **Chin cannon** — 30 mm class, slaved to the sensor or to the pilot's look
  direction, with a real dispersion cone, a time of flight, and a visible
  ground-impact line of dust. Limited rounds, and a burst that overheats.
- **Guided anti-armour missiles** — the main anti-tank weapon. Two guidance
  modes: one that rides the designator (you must keep the laser on target
  through the whole flight) and one fire-and-forget with a lock before launch.
  Slow enough to watch, with a smoke trail, and defeated by smoke or a lost lock.
- **Rocket pods** — unguided, fired in ripples of 1 / 4 / 8, dispersing with
  range. A ballistic aiming cue on the HUD that accounts for the aircraft's
  motion. These are the fun ones and the hardest to hit with.
- **Air-to-air missile** — short range, for the helicopter duel.
- Countermeasure dispensers with a limited count.
- Every weapon changes the aircraft's weight and drag as it goes.

## HUD and symbology

Follow the helicopter panel in `hud-layout-reference.png`.

- Left: torque percentage, rotor RPM, collective position.
- Right: radar altitude (the number that matters below 60 m), vertical speed,
  airspeed.
- Top: heading tape, sensor state, current designation.
- Centre: velocity vector ball — the hover cue. It must clearly show the
  aircraft's drift, because hovering precisely is the core skill.
- Bottom: selected weapon and rounds or missiles left.
- Weapon-specific reticles: a gun cross that moves with the turret, a rocket
  ballistic cue, a missile seeker box.
- Warnings as distinct shapes plus voice: low rotor RPM, engine fire, low fuel,
  incoming launch, torque exceeded, vortex ring warning.

## Enemies

**Ground**

- Tanks and armoured vehicles with real armour facing — a top attack works, a
  frontal hit often does not. They shoot back with machine guns at close range.
- Infantry with shoulder-launched missiles: a visible launch flash, a slow
  smoke-trailing missile, and enough flight time to break lock or put terrain
  between you and it.
- A radar-guided anti-air vehicle that forces genuine terrain masking: fly below
  the ridgeline or die. This should shape every approach in the game.
- Trucks, fuel bowsers and light targets that are easy but not the objective.

**Air — the enemy attack helicopter**

- Flies the same flight model class, with its own character: faster in a dash,
  heavier, less agile at low speed, better armoured, worse sensor range.
- Helicopter dogfighting is slow, low and about masking: pop up, shoot, drop
  back behind terrain. Build the AI to fight that way, not to joust.
- It uses ridgelines, hovers behind cover, and will disengage when losing.

## Missions

1. **Free flight** — one map, no enemies. Build this first and fly it for a long
   time before adding anything.
2. **Hover and landing school** — precision hover boxes, a confined-area
   landing, and an autorotation to a field after an engine cut. Scored.
3. **Armour hunt** — destroy an armoured column while an anti-air vehicle
   covers it. Terrain masking required.
4. **Duel** — 1 v 1 against the enemy helicopter over broken terrain.
5. **Close support** — friendly ground troops call for fire on marked targets;
   you must hit the right ones. Friendly fire fails the mission.

## Environment

- 20 × 20 km terrain with real relief: ridges, valleys, a river, a road network,
  a village, and a forest belt. The terrain must be good enough that masking is
  a real tactic — flat terrain kills this game.
- Rotor downwash: dust, water spray, grass and snow reacting under the aircraft
  in a hover. This is the signature helicopter effect — give it real effort.
  Particles are soft (depth-faded), lit by the sun and ambient, and take their
  colour from the surface below (PBR sheet sand, soil, snow, water). Grass bends
  in a ring from the rotor wind.
- Dust brownout on a desert landing that genuinely obscures the view.
- Lighting presets per the lighting sheet, plus a night mission flown on
  thermal and night-vision, with the correct green-channel look and light
  blooming on point sources.

## Build order

1. Skeleton, renderer, terrain, and the rotor flight model with a debug overlay
   and a placeholder mesh. **Do not move on until a hover feels right.**
2. Translational lift, ground effect, vortex ring, autorotation.
3. Cameras, then the HUD with the velocity vector ball.
4. Hover and landing school mission. Use it as your test bed forever.
5. Sensor turret with render target and thermal.
6. Cannon, then rockets, then guided missiles.
7. Ground enemies, armour facing, anti-air vehicle.
8. Tactical map and designation flow.
9. Enemy helicopter AI and the duel.
10. Downwash, dust, night mode, art pass, sound, performance pass.

Report frame time and the flight-model state at each step.

## Acceptance

- A new player cannot hover on the first try, and can after ten minutes.
- Pulling collective yaws the nose until the pedals correct it.
- Vortex ring state is reachable, survivable, and recovered with forward cyclic.
- Autorotation to a field is possible from 300 m.
- The anti-air vehicle makes flying above the ridgeline fatal.
- Downwash reacts to the surface under the aircraft.
- 60 fps at 1440p with downwash and thermal active.
- At full RPM the rotor reads as a disc with a moving blade shadow, with no
  ghosting in the exterior camera.
