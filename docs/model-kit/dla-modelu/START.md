# START — what to paste into the model

This folder is everything a coding model needs to build one of the games to the
standard of the reference implementations: realistic, physically lit, smooth
on a desktop and a phone. Copy the whole folder into an empty project, pick one
game in `games/`, and paste one of the two blocks below as your first message.

```
AGENT.md                      general working rules (always)
rules/games-ts-threejs.md     architecture, physics, rendering, performance rules
rules/graphics-quality.md     the graphics contract: musts, checks, presets, traps
reference-sheets/*.png        binding numbers: light, PBR, scale, ballistics, HUD, budget
docs/graphics-playbook.md     how every technique was built and measured (optional, see below)
docs/graphics-rules-template.md  the same rules as a fill-in template (Polish)
games/<game>/BRIEF.md         the task (+ target-look/*.png where available)
```

---

## Block A — short (when the model reads files itself)

> Build the game described in `games/<GAME>/BRIEF.md`. Before writing code,
> read `AGENT.md`, `rules/games-ts-threejs.md` and `rules/graphics-quality.md`,
> and look at every image in `reference-sheets/` and `games/<GAME>/target-look/`.
> Follow the brief's build order. Stop and report after each milestone using the
> report format in `START.md`. Do not claim anything works unless you ran it.

## Block B — full (paste as the first message or the system prompt)

> You are building a real-time 3D game in TypeScript + three.js to a
> professional quality bar. The task is `games/<GAME>/BRIEF.md`.
>
> **Read first, in this order, and follow them for the whole project:**
> 1. `AGENT.md` — how to work (read before writing, smallest diff, finish the
>    job, units in names, tests, honest reports).
> 2. `rules/games-ts-threejs.md` — architecture and engineering rules. Where it
>    and the brief disagree on the *stack* (renderer, shader system, physics
>    approach, asset pipeline), the rules win; where the brief asks for more
>    features or quality, the brief wins.
> 3. `rules/graphics-quality.md` — the graphics contract. Every "Must" has a
>    "Check"; you run the check before you call an item done.
> 4. The six sheets in `reference-sheets/` (light in lux and EV100, PBR values,
>    true scale, ballistics, HUD zones, performance budget). They are binding:
>    any value that disagrees needs a comment saying why.
> 5. `games/<GAME>/target-look/` if it exists — the quality bar to match in mood,
>    scale, density and light (not exact layout).
>
> **Non-negotiable stack:** three.js `WebGPURenderer` (its own WebGL2 fallback,
> one code path); all shaders in TSL node materials (no `ShaderMaterial`,
> `onBeforeCompile`, `EffectComposer`); one `RenderPipeline` post chain; strict
> TypeScript without `any`; Vite; game logic free of three.js and stepped at a
> fixed rate; everything procedural unless the brief provides assets; a High
> preset for desktop and a Low preset that holds 60 fps on a mid-range Android
> phone; touch controls; an Android APK (a WebView serving the build offline).
>
> **Working protocol.**
> - Work through the brief's build order. Before each milestone, write a short
>   numbered plan. Do not start the next milestone while the current one fails
>   its checks.
> - Build the measurement tools in the first milestone: fixed benchmark views,
>   a `?bench` flag and a menu button producing a table (fps, p95 frame time,
>   CPU ms, draw calls, triangles, GPU ms per pass), an F3 overlay, and a
>   pipeline tracer. Every later performance claim uses them, before and after.
> - Verify every change: `tsc --noEmit`, unit tests, a production build served
>   statically, headless Chromium on WebGL2 *and* on software WebGPU (flags in
>   `rules/graphics-quality.md` §13) with zero page or console errors, and look
>   at screenshots — several seconds apart for anything that moves.
> - Physics, ballistics, flight and vehicle models get unit tests with at least
>   one known-good value from an outside source (the sheets count).
> - Never hide a failure. If something is missing, approximate or broken, say
>   so in the report with the reason.
> - Ask only when guessing wrong is expensive (a unit convention, deleting
>   work); otherwise pick a sensible default and write it down in a comment.
>
> **After each milestone, report exactly this:**
> 1. *Done* — the brief's feature IDs / items with done / partial / missing.
> 2. *What changed* — files touched, one line each.
> 3. *How to run* — exact commands (dev, test, build, bench, APK).
> 4. *Numbers* — the benchmark table at every fixed view on High and Low, and
>    any model-specific numbers the brief asks for (e.g. ballistics, energy-
>    manoeuvrability, rotor state).
> 5. *Checks run* — which items of `rules/graphics-quality.md` you checked and
>    how; screenshots at the fixed views.
> 6. *Not done / known issues* — anything skipped, guessed or broken, and why.

---

## Notes for whoever hands this over

- **Fair test:** delete `docs/` before handing the folder over. The playbook
  describes finished solutions (and points at the reference code); without it
  you measure what the model can work out from the rules. With it you measure
  how well it can follow a detailed recipe. Both are useful — say which one you
  ran.
- **One game at a time.** Copying only `games/<GAME>/` is enough; the other
  briefs do no harm but are noise.
- **Milestones are checkpoints.** A model that ships milestone 5 working beats
  one that ships milestone 9 broken.
- The grading guides are in `../dla-ciebie/` — never give them to the model.
