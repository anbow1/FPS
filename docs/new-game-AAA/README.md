# New game AAA — everything for a start from nothing

All a model needs to build a new game (three.js, WebGPU + TSL, a browser and
an APK) as close to AAA quality as the platform allows, from your description.
The guidelines assume no particular model.

## Three steps

1. **Copy this whole folder** into an empty folder for the new project (or a
   new repository).
2. **Describe the game**: fill in `games/new-game/DESCRIPTION.md` (kind of
   game, rules, surroundings, devices, priority — five minutes) and put
   reference photographs in `games/new-game/references/`.
3. **Paste** the text of `FIRST-MESSAGE.md` to the model as its first message.

The model starts with Stage 0 **without code**: it writes the brief, the look
board, the budget table and the asset plan, and waits for your approval. Then
it goes through stages 1–8 of `NEW-GAME-AAA.md` and stops with a report after
each.

## What is here

| File / folder | What for |
|---|---|
| `NEW-GAME-AAA.md` | **the guide**: rules R1–R12 (what brings realism; what must come first: KTX2, levels of detail, few shader variants), stages 0–8 each with its checks, how to divide work between models, techniques and engines for later |
| `FIRST-MESSAGE.md` | the first message to the model |
| `TEST-RUN.md` | a run sheet: which model, which variant, the results — for comparing models |
| `games/new-game/DESCRIPTION.md` | the form you fill in |
| `games/new-game/references/` | your photographs of the place and the mood |
| `AGENT.md` | general working rules for an agent |
| `START.md` | the report format after each stage |
| `rules/games-ts-threejs.md` | architecture, physics, rendering, smoothness, loading time |
| `rules/graphics-quality.md` | the graphics contract: every requirement has a "Must" and a "Check" |
| `reference-sheets/` | sheets of numbers: light, PBR materials, scale, ballistics, HUD, budget |
| `tools/measure/` | screenshots at fixed views, a loading report, a CPU profile |
| `tools/assets/` | Blender scripts: vehicle and weapon models, people, motion clips |
| `shared-src/` | source files to copy unchanged (pipeline warm-up, shared shaders for instances, measurement, noise) |
| `docs/graphics-playbook.md` | how each technique was built and measured in the reference games |
| `ROUTINE-WORK.md` | standing rules and the measurement procedure for routine work, for any model |

## Notes

- The name `new-game` can be changed (the folder in `games/` and the paths in
  `FIRST-MESSAGE.md`).
- **Comparing models:** give each model a fresh copy of this folder, the same
  `DESCRIPTION.md` and the same first message; note the model and the variant
  in `TEST-RUN.md`.
- **A test without ready solutions:** delete `docs/` and `shared-src/` and
  strike the sentence about them from `FIRST-MESSAGE.md` — you then measure
  what the model works out from the rules alone. `tools/` stays: it measures,
  it does not solve.
- This folder is a **generated copy**: its sources are files of the FPS
  repository (`AGENT.md`, `docs/graphics-playbook.md`, `tools/measure/`, …). Only
  `README.md`, `NEW-GAME-AAA.md`, `FIRST-MESSAGE.md`, `TEST-RUN.md` and
  `ROUTINE-WORK.md` are edited here by hand; `bash docs/model-kit/sync.sh`
  refreshes the rest. The Polish twin is `docs/nowa-gra-AAA/`: a change to the
  guide goes into both.
