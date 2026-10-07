# Ridgeline

An attack helicopter simulator in TypeScript and three.js (`WebGPURenderer`,
WebGL2 fallback), built to [`BRIEF.md`](BRIEF.md). You fly a two-seat western
attack helicopter, the **AH-7 Warden** (AH-64 class). The **M-38 Bulat**
(Mi-28 class) is also flyable. Both are invented types with no markings.

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # flight model and terrain checks
```

Status: build step 1 of the brief. It covers the flight model, the terrain,
the cameras, the HUD with the hover cue, and the debug page. Sensors, weapons,
enemies and missions follow.

## Controls

| | Keyboard and mouse | Touch |
|---|---|---|
| Cyclic | mouse or W/S A/D; springs back to the trim position | left thumb, floating stick; or tilt the phone |
| Trim | T: the current stick and pedals become neutral | TRIM |
| Collective | Shift / Ctrl, or the wheel in notches | lever on the left edge |
| Pedals | Q / E | ◀ ▶ |
| Stability augmentation | Z | SAS |
| Engines (autorotation practice) | I | ENG |
| Wheel brakes | B | — |
| Camera (chase, pilot, gunner, orbit) | C | CAM |
| Flight data / sky / quality / sound | H / K / O / M | — |

The menu sets the pitch sense, tilt steering and the graphics preset.

URL options:

- `?autostart` skips the menu.
- `&heli=warden|bulat` picks the helicopter.
- `&time=morning|noon|dusk` picks the sky.
- `&spawn=air&alt=30` starts in a hover, at the given height in metres.
- `&debug` opens the flight data page.
- `&q=high|balanced|fast`, `&invert=0|1` and `&tilt=0|1` set graphics and
  controls.

## The flight model

All of it is a game abstraction with invented numbers. It is built from the
rotor, not from a plane with vertical thrust.

- **Thrust.**
  - Blade-element thrust from collective pitch, with inflow from momentum
    theory, solved every substep at 240 Hz.
  - Scaled by air density and the square of rotor speed.
- **Disc.**
  - The disc tilts with cyclic through a flapping lag.
  - It blows back with speed, which gives speed stability.
  - It lags the body's rotation, which is the rotor's damping.
  - Thrust acts at the hub, with a hub spring moment.
- **Torque.**
  - The rotor's torque yaws the airframe.
  - The tail rotor's pedal-pitch thrust holds it, and pushes the aircraft
    sideways too, so a hover is flown slightly wing-low.
  - More collective swings the nose until the pedals follow.
- **Translational lift.** Induced inflow collapses with forward speed, so
  forward flight needs less power than a hover.
- **Ground effect.** Cheeseman–Bennett, below about one rotor diameter. It
  fades with speed.
- **Vortex ring state.**
  - Sinking at 0.3 to 1.6 times the hover induced velocity with little forward
    speed costs thrust and rocks the disc.
  - More collective makes it worse. Forward cyclic flies out of it.
- **Retreating blade stall.** Past about μ 0.35 (earlier when heavy) the
  blade stalls: vibration, pitch-up, and a roll towards the retreating side.
- **Engines and autorotation.**
  - Turboshafts behind a governor, with a lag, so a snatched collective
    droops the rotor.
  - With the engines cut, air coming up through the disc keeps the rotor
    turning.
- **Airframe.**
  - Fuselage drag, a cambered fin that unloads the tail rotor at speed, and a
    stabilator.
  - Spring-damper wheels, rotor strike, and fuel burn.
- **SAS.** Rate damping in all three axes, on by default. With it off, a
  hover is genuinely hard to hold.

The tests in [`tests/rotor.test.ts`](tests/rotor.test.ts) fly the model with a
simple test pilot and check the brief's acceptance points.

## The terrain

- 20 × 20 km at 10 m resolution, with a 164 km ring around it.
- Long ridges 250–600 m above the valley floors, with saddles to cross low.
- A meandering river down a broad valley.
- The forward base on a levelled terrace at the centre.
- From the valley at 30 m above the ground, terrain closes most lines of sight
  within 4 km, so masking works.
