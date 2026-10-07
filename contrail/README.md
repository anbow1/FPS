# Contrail

A jet fighter simulator in the browser: the **V-17 Wraith**, a single-engine
stealth fighter, against the **K-27 Talon**, a heavy twin-engine fighter. Both
types are invented and both are flyable. TypeScript, three.js
`WebGPURenderer` with the WebGL2 fallback, no engine. Build brief:
[BRIEF.md](BRIEF.md). Look decisions: [LOOK.md](LOOK.md).

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # flight model, gear, terrain, clouds, radar, weapons, AI duel
npm run build
```

## Modes

The start menu picks the mode, your aircraft, the opponent's, the AI level and
the sky.

- **Duel.** One against one, head-on, 40 km apart. Both sides respawn after a
  kill, and the score counts kills and losses.
- **Intercept.** Two bandits are inbound to the base and you start with little
  fuel. Shoot both down, then land on the runway.
- **Landing.** A straight-in approach to runway 36 from 10 km. The touchdown is
  scored on sink rate, centreline and distance from the aiming point.
- **Free flight.** One aircraft, one sky, starting on the runway.

## Controls

| | Keyboard and mouse | Touch |
|---|---|---|
| Stick | mouse (springs back) or W/S A/D | left thumb, floating stick, or tilt the phone |
| Pitch sense | menu: up = nose up (default) or up = nose down | same |
| Tilt steering | — | menu toggle; hold the phone like a yoke (turn = roll, top edge towards you = pull); CAL re-centres |
| Rudder | Q / E | — |
| Throttle | Shift / Ctrl or wheel; press again at 100 % for afterburner | lever on the left edge, top fifth = afterburner |
| Fire | left button / Space | FIRE |
| Weapon (gun, short range, medium range) | X | WPN |
| Radar: lock / mode / range / antenna | V / R / `,` `.` / PgUp PgDn | LOCK / RDR / RNG |
| Flares / chaff | F / Z (hold) | FLR / CHF |
| Camera (chase, cockpit, orbit, padlock, missile) | C | CAM |
| Gear / brakes / G-limiter | G / B / L | GEAR / BRK |
| Sky / quality / tone map / data | K / O / T / H | — |
| Sound on / off | M | — |

URL options: `?mode=duel|intercept|landing|free`, `&ac=wraith|talon`,
`&vs=…`, `&ai=easy|normal|hard`, `&time=morning|noon|dusk`, `&q=low`,
`&autostart`, `&invert=0|1`, `&tilt=0|1`, `&q=high|balanced|fast`, `&mute`.
The pitch, tilt and graphics choices are remembered on the device.

Graphics presets (menu):

- **High:** all effects, temporal anti-aliasing, up to 2× on phones.
- **Balanced:** the phone default; lighter clouds and shadows, temporal anti-aliasing, a sharp 2× picture.
- **Fast:** lighter effects at 1×.

On every preset the frame governor lowers the resolution if the frame rate drops.

## What is modelled

All of it is a game abstraction, with invented numbers tuned to feel right.

- **Flight.**
  - A six-degree-of-freedom model with vortex lift, stall and post-stall,
    Mach drag rise and an ISA atmosphere.
  - Engines with spool-up and afterburner light-off.
  - Fly-by-wire with G and angle-of-attack limits, G tolerance, and gear on
    spring-damper legs.
- **Radar.**
  - The sweep takes real time, with search, track-while-scan and
    single-target track modes.
  - Lock takes time.
  - A target crossing low against the ground drops out of the doppler notch.
  - Terrain masks targets.
  - The stealth type is seen nose-on at about a third of the usual range.
- **Threat warning.** Shows search, track and launch, by bearing.
- **Cockpit.**
  - Glare shield, panel, sills and live displays (radar, threat ring, flight page).
  - The stealth type has one panoramic screen and helmet-mounted symbology.
  - The twin-engine type has a windscreen frame, two displays, and a HUD clipped to its combiner glass.
- **Sound.**
  - Synthesised, with no samples.
  - Engine whine and rumble follow the core speed; the afterburner roars.
  - Wind follows dynamic pressure, with buffet at high angle of attack.
  - Other jets are heard with a Doppler shift.
  - Explosions arrive after the sound's travel time.
  - The cockpit muffles everything.
- **Weapons.**
  - A gun with time of flight and tracers.
  - An infrared missile that flares and the sun can decoy.
  - A radar missile that needs the lock until it goes active and arrives
    spent at long range.
  - Flares and chaff.
- **AI.** It flies the same aircraft through the same control laws. It
  patrols, intercepts, takes envelope-checked shots, beams missiles into the
  notch, breaks, and bugs out when spent. Clouds hide you from its eyes.
- **Sky.** A Hillaire LUT atmosphere with aerial perspective, ray-marched
  volumetric clouds with shadows, contrails, wingtip vapour, heat shimmer and
  a black-body afterburner.

## Android

`android/build-apks.sh` builds this game as the `contrail` flavour. The
`android.yml` workflow publishes `contrail.apk` on the **android-latest**
release.
