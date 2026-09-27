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
