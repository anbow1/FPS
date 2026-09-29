# FPS — two browser games

Two separate TypeScript + three.js projects (`WebGPURenderer`, WebGL2
fallback), each with its own `package.json`, tests and build:

| Folder | Game |
|---|---|
| [`field-line/`](field-line/) | **Field Line** — single-player military FPS: shooting range, city block, forest ridge; Range, Skirmish and Extraction modes. |
| [`castaway-lagoon/`](castaway-lagoon/) | **Castaway Lagoon** — first-person tropical lagoon with a survival outpost: stone throwing, AK-47, knife, supply crate, harvesting, inventory, dynamic weather and time of day. |

```powershell
cd field-line        # or: cd castaway-lagoon
npm install
npm run dev          # http://localhost:5173
```

Shared by both, at the root: the coding rules (`AGENT.md`,
`games-ts-threejs.md`) and the reference sheets in `references/`.

**[docs/graphics-playbook.md](docs/graphics-playbook.md)** — every graphics
technique used in both games (renderer and light units, procedural textures,
terrain, sky, vegetation and streaming, water, shore waves, swash, caustics),
the phone budget and how to stop shader-compile stutter, how to verify it
headless, and the three.js r186 pitfalls — written as step-by-step
instructions another project or coding agent can follow.

## Android

Both games also build as Android apps (`android/`): one Gradle project, one
product flavour per game, each a full-screen landscape WebView that serves the
bundled production build offline. On phones and tablets the games switch to
on-screen controls — a floating movement stick on the left, drag anywhere
else to look, and buttons for fire, aim, jump, use, reload, weapons and the
rest — start on the Low graphics preset, and cap the render resolution so a
3× phone screen does not cost three times the pixels. The back button pauses.

- **Download:** every push to `main` runs `.github/workflows/android.yml`,
  which publishes `field-line.apk` and `castaway-lagoon.apk` on the
  **android-latest** release of this repository (Android 8 or newer; allow
  installs from that source when asked).
- **Build locally** (Node 22, JDK 17, Android SDK): `bash android/build-apks.sh`
  → `android/out/*.apk`.
- **Signing:** without the optional `ANDROID_KEYSTORE_*` secrets each build is
  signed with a throwaway debug key, so uninstall the old app before
  installing a newer one. See the comments in the workflow.
- **Test touch controls in a desktop browser:** add `?touch` to the URL.
