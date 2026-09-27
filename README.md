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

Also here: [`kurs-programowania/`](kurs-programowania/) — an interactive
programming course in Polish (Python, CLI, git, JSON, SQL, pandas, HTTP APIs,
tool calling, loops and graphs, embeddings, RAG, MCP, Docker and venv, code
quality tooling and evals for AI apps), with
auto-checked exercises and quizzes. Start with `python kurs.py` inside that folder.

Shared by both, at the root: the coding rules (`AGENT.md`,
`games-ts-threejs.md`) and the reference sheets in `references/`.

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
