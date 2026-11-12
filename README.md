# FPS — browser games

Separate TypeScript + three.js projects (`WebGPURenderer`, WebGL2
fallback), each with its own `package.json`, tests and build:

| Folder | Game |
|---|---|
| [`field-line/`](field-line/) | **Field Line** — single-player military FPS: shooting range, city block, forest ridge; Range, Skirmish and Extraction modes. |
| [`castaway-lagoon/`](castaway-lagoon/) | **Castaway Lagoon** — first-person tropical lagoon with a survival outpost: stone throwing, AK-47, knife, supply crate, harvesting, inventory, dynamic weather and time of day. |
| [`contrail/`](contrail/) | **Contrail** — jet fighter simulator: a stealth fighter against a heavy twin-engine fighter, six-degree-of-freedom flight model, radar and threat warning, gun and missiles, an AI opponent, volumetric clouds in a physical sky; Duel, Intercept, Landing and Free flight. |
| [`ridgeline/`](ridgeline/) | **Ridgeline** — attack helicopter simulator (in progress): a rotor flight model built from blade-element and momentum theory (torque and tail rotor, translational lift, ground effect, vortex ring state, retreating blade stall, autorotation), 20 km of ridges and valleys made for terrain masking, the helicopter HUD with its hover cue. |
| [`paris/`](paris/) | **Paris** — not a game: ten seconds of a Haussmann boulevard at golden hour (traffic at a red light, people crossing and walking, café terraces, cyclists, pigeons, plane trees in autumn), rendered frame by frame to a video; the graphics playbook put to the test. |
| [`marchland/`](marchland/) | **Marchland** — medieval real-time strategy against the computer (in progress): a town of production chains on building plots (grain to bread, pigs to sausages and hides, hides to armour, ore to weapons), regiments of up to a hundred men a side fighting in formation with morale, flanks and charges, archers, crossbows, ballistae and a trebuchet; strategy camera with zoom and pan; scanned CC0 ground, walls and roofs. |
| [`tanks/`](tanks/) | **Tanks** — tank combat on open fields, lakes and a village: a modern MBT with a fire-control system, gunner's and thermal sights, AI tanks, infantry and drones. Moved here from the separate `anbow1/tanks` repository with its history. |

```powershell
cd field-line        # or: cd castaway-lagoon, cd contrail, cd ridgeline, cd tanks, cd marchland
npm install
npm run dev          # http://localhost:5173
```

Shared by both, at the root: the coding rules (`AGENT.md`,
`games-ts-threejs.md`) and the reference sheets in `references/`.

**[docs/graphics-rules-template.md](docs/graphics-rules-template.md)** — the
graphics rules of all three games (Field Line, Castaway Lagoon, Tanks) as a
fill-in template (Polish) to copy into a new game: architecture, light,
materials, vegetation, water, stutter, measurement, presets, acceptance.

**[docs/model-kit/](docs/model-kit/)** — a copy-and-paste kit for any coding
model: the rules (`AGENT.md`, architecture, a graphics quality contract with a
check for every rule), the reference sheets, the graphics playbook, a ready
first message (`START.md`), build briefs for five games (Field Line, Castaway
Lagoon, Tanks, a jet fighter and an attack helicopter simulator) with
target-look screenshots where they exist, and — for the evaluator only — a
grading protocol and a 100-point rubric per game. README in Polish.

**[docs/graphics-playbook.md](docs/graphics-playbook.md)** — every graphics
technique used in both games (renderer and light units, procedural textures,
terrain, sky, vegetation and streaming, water, shore waves, swash, caustics),
the phone budget and how to stop shader-compile stutter, how to verify it
headless, and the three.js r186 pitfalls — written as step-by-step
instructions another project or coding agent can follow.

## Android

The games also build as Android apps (`android/`): one Gradle project, one
product flavour per game, each a full-screen landscape WebView that serves the
bundled production build offline. On phones and tablets the games switch to
on-screen controls — a floating movement stick on the left, drag anywhere
else to look, and buttons for fire, aim, jump, use, reload, weapons and the
rest (Contrail and Ridgeline: an analogue stick, a throttle or collective lever, and cockpit buttons; tilt steering as an option), and cap the render resolution so a
3× phone screen does not cost three times the pixels. The back button pauses.

- **Download:** every push to `main` runs `.github/workflows/android.yml`,
  which publishes `field-line.apk`, `castaway-lagoon.apk`, `contrail.apk`, `ridgeline.apk` and `tanks.apk` on the
  **android-latest** release of this repository (Android 8 or newer; allow
  installs from that source when asked).
- **Build locally** (Node 22, JDK 17, Android SDK): `bash android/build-apks.sh`
  → `android/out/*.apk`.
- **Signing:** without the optional `ANDROID_KEYSTORE_*` secrets each build is
  signed with a throwaway debug key, so uninstall the old app before
  installing a newer one. See the comments in the workflow. Tanks is the
  exception: it is always signed with its committed sideload key
  (`android/app/tanks-sideload.keystore`), so it updates the copy installed
  from the old `anbow1/tanks` releases.
- **Test touch controls in a desktop browser:** add `?touch` to the URL.
