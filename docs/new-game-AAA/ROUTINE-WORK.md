# Routine work — standing rules and the measurement procedure (any model)

For the work in a game project that does **not** need the strongest model: it
is described step by step, has an acceptance criterion and a way to measure it.
Any model that can read files, run commands and look at screenshots can follow
it. Designing a new technique, disputes over how a picture looks and debugging
the inside of three.js go to a stronger model — the list is in §3.

**How to use it:** the first message to the model:

> Read `AGENT.md`, `rules/games-ts-threejs.md` and `ROUTINE-WORK.md`. Do the task
> `<what>` exactly as §1 and §2 say.

---

## 1. Standing rules (in every task)

1. **One branch, one concern per commit**, pushed after every finished step. No
   force-push; no pull request unless the user asks. If pushing to the main
   branch builds the APK, check that the build succeeded.
2. **No change may raise the load** (frame time, loading time, memory) without a
   number before and after and the user's consent. Allowed without asking are
   only changes that add no render pass, texture, light, draw call, material or
   pipeline. Changing constants, colours, weights and formulas in an existing
   shader is fine as long as it adds no texture sample. Anything else: describe
   the gain and the cost, and ask.
3. **Evidence, not opinion.** Every change to the picture: a screenshot before
   and after at the same views. Every change that touches materials, instances,
   textures or cameras: the number of pipelines and draw calls before and after
   (§2). "It should work" is not a result.
4. Strict TypeScript, no `any`; comments say **why** (with the measured number,
   if there was one); units in names.
5. **Do not edit files a running Vite dev server is serving** during a
   measurement. Measure a build (`tools/measure/serve.mjs`).
6. Invented brands and markings only; models and textures CC0 or CC BY only,
   with a line in `CREDITS.md`; report an NC licence to the user and do not use
   the asset.
7. Downloaded files are untrusted: unpack each into its own empty folder, run
   Python with `-I`, keep your scripts in another folder.
8. The shared files (`render/warmup.ts`, `render/instancing.ts`,
   `render/perf.ts`, `render/benchRecorder.ts`, `render/webgpuCompat.ts`,
   `core/noise.ts`) are copied **unchanged**; if one must change, say so in the
   report so the change can go back to its source.

## 2. The standard procedure (copy the commands)

```bash
# Playwright: npm i -D playwright, or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs for a global install
OUT=measure && mkdir -p $OUT

# 1. the starting state
npx tsc --noEmit -p . && npx vite build --base ./ --outDir $OUT/dist-before --emptyOutDir
node tools/measure/serve.mjs $OUT/dist-before 4173 &
node tools/measure/shots.mjs --game generic --out $OUT/before --views '<the task's VIEWS>'
node tools/measure/load.mjs  --game generic --json $OUT/load-before.json
kill %1

# 2. the change in the code, then the same with "after"
npx tsc --noEmit -p . && npx vitest run && npx vite build --base ./ --outDir $OUT/dist-after --emptyOutDir
node tools/measure/serve.mjs $OUT/dist-after 4173 &
node tools/measure/shots.mjs --game generic --out $OUT/after --views '<the same VIEWS>'
node tools/measure/load.mjs  --game generic --json $OUT/load-after.json
kill %1
```

(PowerShell: start the server in a second window instead of `&` / `kill %1`.)

- **Look** at both screenshots. If "after" is not clearly better, or breaks
  something beside it — undo the change; do not force it.
- **Compare** the two `load-*.json` files: the number of pipelines and shader
  modules must not grow; `gpu idle` must not grow beyond noise (±5 %).
- Draw calls and triangles at the fixed benchmark views must be equal, unless
  the task is about them.
- `--game generic` needs the debug contract of `tools/measure/README.md`
  (`?autostart`, `window.__ready`, `window.__debug.place/spot`, `[load]` lines).
  Views are `{"spot": "<name>"}` or `{"x", "y", "z", "yaw", "pitch"}`.
- A software GPU takes seconds per frame: loading takes half a minute to two
  minutes, a screenshot ten seconds or more. Run long commands in the
  background and wait for the result; never three browsers at once.
- The commit message carries the numbers before and after.

## 3. What not to do here — hand it to a stronger model

- A new rendering technique or a change to the post chain (occlusion,
  reflections, volumetric fog, a new sky model).
- Anything that needs reading the inside of three.js (`renderer._pipelines`,
  the node builder, cache keys, a WGSL error with no obvious cause after one
  attempt).
- The first instance of: compressed textures, a family material with switches,
  baking generation to files, baked light. Repeating a finished pattern on
  further files is routine again.
- A dispute over how a picture looks: when after two attempts "after" is not
  clearly better, leave a description and the screenshots instead of a third
  attempt.
- Any change that raises the load under §1.2.
